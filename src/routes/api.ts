import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import config from '../config';
import { ingestData } from '../services/ingest';
import { query, withTransaction } from '../db';
import { reconcileRecord } from '../agent';
import { evaluate, type GroundTruthEntry } from '../services/metrics';

export const apiRouter = Router();

// Ingest and reconcile both rewrite outcome tables; letting two of them overlap
// is how records used to end up matched twice. Only one may run at a time.
let busy: 'ingest' | 'reconcile' | null = null;

/**
 * POST /api/ingest
 * Triggers the ingestData() utility.
 */
apiRouter.post('/ingest', async (req: Request, res: Response) => {
  if (busy) {
    res.status(409).json({ error: `A ${busy} run is already in progress` });
    return;
  }
  busy = 'ingest';
  try {
    const counts = await ingestData();
    res.json({ success: true, counts });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    busy = null;
  }
});

/**
 * POST /api/reconcile
 * Triggers the agent loop for all unreconciled records, updating progress.
 */
apiRouter.post('/reconcile', async (req: Request, res: Response) => {
  if (busy) {
    res.status(409).json({ error: `A ${busy} run is already in progress` });
    return;
  }
  busy = 'reconcile';
  try {
    const unreconciled = await query<{ id: number }>(`
      SELECT l.id
      FROM ledger_records l
      LEFT JOIN matches m ON l.id = m.ledger_id
      LEFT JOIN exceptions e ON l.id = e.ledger_id
      WHERE m.id IS NULL AND e.id IS NULL
      ORDER BY l.id ASC
    `);

    // Let the caller pass a limit to avoid rate limit issues in demo
    const limit = Number(req.query.limit) || unreconciled.rows.length;
    let processed = 0;
    const errors: any[] = [];

    // Process sequentially
    for (const row of unreconciled.rows.slice(0, limit)) {
      try {
        await reconcileRecord(row.id);
        processed++;
      } catch (err: any) {
        errors.push({ ledgerId: row.id, error: err.message });
        if (err.message.includes('429')) {
          // Break early on rate limits
          break;
        }
      }
    }

    res.json({ success: true, processed, errors });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    busy = null;
  }
});

/**
 * GET /api/matches
 * Fetches successfully matched records, joining with ledger and bank data.
 */
apiRouter.get('/matches', async (req: Request, res: Response) => {
  try {
    const matches = await query(`
      SELECT 
        m.id as match_id,
        m.ledger_id,
        m.method,
        m.confidence,
        m.reasoning,
        l.invoice_id,
        l.customer_name,
        l.amount as ledger_amount,
        l.payment_ref as ledger_ref,
        b.txn_id as bank_txn_id,
        b.amount as bank_amount
      FROM matches m
      JOIN ledger_records l ON m.ledger_id = l.id
      JOIN bank_transactions b ON m.bank_txn_id = b.id
      ORDER BY m.created_at DESC
    `);
    res.json(matches.rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/exceptions
 * Fetches records flagged for review.
 */
apiRouter.get('/exceptions', async (req: Request, res: Response) => {
  try {
    const exceptions = await query(`
      SELECT 
        e.id as exception_id,
        e.ledger_id,
        e.reason,
        e.reasoning,
        e.status,
        e.best_candidate_bank_txn_id,
        l.invoice_id,
        l.customer_name,
        l.amount as ledger_amount,
        l.payment_ref as ledger_ref,
        b.txn_id as best_candidate_txn_id,
        b.amount as best_candidate_amount
      FROM exceptions e
      JOIN ledger_records l ON e.ledger_id = l.id
      LEFT JOIN bank_transactions b ON e.best_candidate_bank_txn_id = b.id
      ORDER BY e.created_at DESC
    `);
    res.json(exceptions.rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/exceptions/:id/resolve
 * Allows a human to manually resolve an exception (either matching it to a bank ID or writing it off).
 */
apiRouter.post('/exceptions/:id/resolve', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { action, bank_txn_id } = req.body; // action: 'match' | 'reject'

    if (action !== 'match' && action !== 'reject') {
      res.status(400).json({ error: 'Invalid action, use "match" or "reject"' });
      return;
    }

    const outcome = await withTransaction(async (client) => {
      // Lock the exception row so two reviewers can't resolve it at once
      const excResult = await client.query<{ ledger_id: number; status: string }>(
        `SELECT ledger_id, status FROM exceptions WHERE id = $1 FOR UPDATE`, [id],
      );
      const exc = excResult.rows[0];
      if (!exc) return { status: 404, error: 'Exception not found' };
      if (exc.status !== 'open') return { status: 400, error: 'Exception is already resolved' };

      if (action === 'reject') {
        await client.query(`UPDATE exceptions SET status = 'rejected', resolved_by = 'human' WHERE id = $1`, [id]);
        return { message: 'Exception rejected / written off' };
      }

      const bankResult = await client.query<{ id: number; matched_to: string | null }>(
        `SELECT b.id,
                (SELECT l.invoice_id FROM matches m JOIN ledger_records l ON l.id = m.ledger_id
                  WHERE m.bank_txn_id = b.id) AS matched_to
         FROM bank_transactions b WHERE b.txn_id = $1`,
        [bank_txn_id],
      );
      const bank = bankResult.rows[0];
      if (!bank) return { status: 400, error: 'Invalid bank_txn_id' };
      if (bank.matched_to) return { status: 409, error: `${bank_txn_id} is already matched to ${bank.matched_to}` };

      await client.query(
        `INSERT INTO matches (ledger_id, bank_txn_id, method, confidence, reasoning)
         VALUES ($1, $2, 'manual', 1.0, 'Manually resolved by user')`,
        [exc.ledger_id, bank.id],
      );
      await client.query(`UPDATE exceptions SET status = 'approved', resolved_by = 'human' WHERE id = $1`, [id]);
      return { message: 'Resolved as match' };
    });

    if ('error' in outcome) {
      res.status(outcome.status!).json({ error: outcome.error });
    } else {
      res.json({ success: true, message: outcome.message });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/audit-log/:ledgerId
 * Fetches the tool-call trace from audit_log for a specific record.
 */
apiRouter.get('/audit-log/:ledgerId', async (req: Request, res: Response) => {
  try {
    const { ledgerId } = req.params;
    const logs = await query(`
      SELECT turn_number as turn, tool_name, tool_input, tool_result, created_at
      FROM audit_log
      WHERE ledger_id = $1
      ORDER BY turn_number ASC, created_at ASC
    `, [ledgerId]);
    res.json(logs.rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/metrics
 * Record counts, plus precision / recall / accuracy of the agent's own
 * decisions against data/ground_truth.json when it exists.
 */
apiRouter.get('/metrics', async (req: Request, res: Response) => {
  try {
    const stats = await query(`
      SELECT
        (SELECT COUNT(*) FROM ledger_records) as total_records,
        (SELECT COUNT(*) FROM matches) as total_matches,
        (SELECT COUNT(*) FROM exceptions) as total_exceptions,
        (SELECT COUNT(*) FROM exceptions WHERE status = 'open') as open_exceptions,
        (SELECT COUNT(*) FROM exceptions WHERE status = 'rejected') as rejected_exceptions
    `);

    const gtPath = path.join(config.dataDir, 'ground_truth.json');
    if (!fs.existsSync(gtPath)) {
      res.json(stats.rows[0]);
      return;
    }
    const groundTruth: GroundTruthEntry[] = JSON.parse(fs.readFileSync(gtPath, 'utf-8'));

    // The agent's decision per invoice: its match (manual matches excluded,
    // those are human decisions) or null where it flagged an exception.
    const decisions = await query<{ invoice_id: string; bank_txn_id: string | null }>(`
      SELECT l.invoice_id, b.txn_id AS bank_txn_id
      FROM matches m
      JOIN ledger_records l ON m.ledger_id = l.id
      JOIN bank_transactions b ON m.bank_txn_id = b.id
      WHERE m.method <> 'manual'
      UNION ALL
      SELECT l.invoice_id, NULL
      FROM exceptions e
      JOIN ledger_records l ON e.ledger_id = l.id
    `);

    const evaluation = evaluate(
      groundTruth,
      new Map(decisions.rows.map((r) => [r.invoice_id, r.bank_txn_id])),
    );

    res.json({ ...stats.rows[0], ...evaluation });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
