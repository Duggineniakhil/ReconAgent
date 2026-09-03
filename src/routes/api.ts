import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { ingestData } from '../services/ingest';
import { query } from '../db';
import { reconcileRecord } from '../agent';

export const apiRouter = Router();

/**
 * POST /api/ingest
 * Triggers the ingestData() utility.
 */
apiRouter.post('/ingest', async (req: Request, res: Response) => {
  try {
    const counts = await ingestData();
    res.json({ success: true, counts });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/reconcile
 * Triggers the agent loop for all unreconciled records, updating progress.
 */
apiRouter.post('/reconcile', async (req: Request, res: Response) => {
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

    const excResult = await query<{ ledger_id: number, status: string }>(`SELECT * FROM exceptions WHERE id = $1`, [id]);
    if (!excResult.rows.length) {
      res.status(404).json({ error: 'Exception not found' });
      return;
    }
    
    const exc = excResult.rows[0];
    if (exc.status !== 'open') {
      res.status(400).json({ error: 'Exception is already resolved' });
      return;
    }

    if (action === 'match') {
      const bankResult = await query<{ id: number }>(`SELECT id FROM bank_transactions WHERE txn_id = $1`, [bank_txn_id]);
      const bankId = bankResult.rows[0]?.id;
      if (!bankId) {
        res.status(400).json({ error: 'Invalid bank_txn_id' });
        return;
      }
      
      // Use 'reasoned' method for manual matches, as method must be exact/fuzzy/reasoned
      await query(`
        INSERT INTO matches (ledger_id, bank_txn_id, method, confidence, reasoning)
        VALUES ($1, $2, 'reasoned', 1.0, 'Manually resolved by user')
      `, [exc.ledger_id, bankId]);
      
      await query(`UPDATE exceptions SET status = 'approved', resolved_by = 'human' WHERE id = $1`, [id]);
      res.json({ success: true, message: 'Resolved as match' });
    } else if (action === 'reject') {
      await query(`UPDATE exceptions SET status = 'rejected', resolved_by = 'human' WHERE id = $1`, [id]);
      res.json({ success: true, message: 'Exception rejected / written off' });
    } else {
      res.status(400).json({ error: 'Invalid action, use "match" or "reject"' });
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
 * Placeholder for precision/recall metrics. 
 * Actually computes precision/recall if ground truth exists, but for now we can just return basic stats.
 */
apiRouter.get('/metrics', async (req: Request, res: Response) => {
  try {
    const stats = await query(`
      SELECT 
        (SELECT COUNT(*) FROM ledger_records) as total_records,
        (SELECT COUNT(*) FROM matches) as total_matches,
        (SELECT COUNT(*) FROM exceptions) as total_exceptions
    `);

    // Calculate Precision and Recall
    const gtPath = path.resolve(__dirname, '../../data/ground_truth.json');
    let precision = 0;
    let recall = 0;
    let accuracy = 0;
    
    if (fs.existsSync(gtPath)) {
      const groundTruth: { ledger_invoice_id: string, expected_bank_txn_id: string | null }[] = JSON.parse(fs.readFileSync(gtPath, 'utf-8'));
      
      const matches = await query(`
        SELECT l.invoice_id, b.txn_id as bank_txn_id 
        FROM matches m 
        JOIN ledger_records l ON m.ledger_id = l.id 
        JOIN bank_transactions b ON m.bank_txn_id = b.id
      `);
      
      const exceptions = await query(`
        SELECT l.invoice_id 
        FROM exceptions e 
        JOIN ledger_records l ON e.ledger_id = l.id
      `);

      const matchMap = new Map(matches.rows.map((r: any) => [r.invoice_id, r.bank_txn_id]));
      const exceptionSet = new Set(exceptions.rows.map((r: any) => r.invoice_id));

      let TP = 0, FP = 0, FN = 0, TN = 0;

      for (const gt of groundTruth) {
        const agentMatchedId = matchMap.get(gt.ledger_invoice_id);
        const agentFlagged = exceptionSet.has(gt.ledger_invoice_id);

        if (gt.expected_bank_txn_id !== null) {
          // Expected a match
          if (agentMatchedId === gt.expected_bank_txn_id) {
            TP++;
          } else if (agentMatchedId) {
            // Matched to the wrong one
            FP++;
            FN++; // Also missed the correct one
          } else if (agentFlagged) {
            // Should have matched, but flagged as exception
            FN++;
          }
        } else {
          // Expected an exception
          if (agentFlagged) {
            TN++;
          } else if (agentMatchedId) {
            FP++;
          }
        }
      }

      precision = (TP + FP) > 0 ? (TP / (TP + FP)) : 0;
      recall = (TP + FN) > 0 ? (TP / (TP + FN)) : 0;
      accuracy = (TP + TN + FP + FN) > 0 ? ((TP + TN) / (TP + TN + FP + FN)) : 0;
      
      res.json({
        ...stats.rows[0],
        precision,
        recall,
        accuracy,
        confusion_matrix: { TP, FP, FN, TN }
      });
    } else {
      res.json(stats.rows[0]);
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
