import { Router, Request, Response } from 'express';
import { query, withTransaction } from '../db';
import { ingestData, importUpload, currentDataset } from '../services/ingest';
import { parseCsvRows, suggestMapping, LEDGER_FIELDS, BANK_FIELDS, type FieldDef } from '../services/csv_import';
import { runManager, evaluateDecisions, BusyError, type RunRow } from '../services/runner';

export const apiRouter = Router();

// ═══════════════════════════════════════════════════════════════════════
//  DATASETS
// ═══════════════════════════════════════════════════════════════════════

/**
 * GET /api/dataset
 * The dataset currently loaded (null if none has been recorded yet).
 */
apiRouter.get('/dataset', async (_req: Request, res: Response) => {
  try {
    res.json(await currentDataset());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/ingest
 * Loads the synthetic demo dataset from the data folder, replacing current data.
 */
apiRouter.post('/ingest', async (_req: Request, res: Response) => {
  try {
    const result = await runManager.withLock('ingest', () => ingestData());
    res.json({
      success: true,
      counts: { ledgerCount: result.ledgerCount, bankCount: result.bankCount },
      dataset: result.dataset,
    });
  } catch (err: any) {
    res.status(err instanceof BusyError ? 409 : 500).json({ error: err.message });
  }
});

/**
 * POST /api/datasets/preview
 * Body: { ledgerCsv, bankCsv }. Returns each file's headers, a few sample rows,
 * the fields we need and a suggested column mapping.
 */
apiRouter.post('/datasets/preview', (req: Request, res: Response) => {
  const { ledgerCsv, bankCsv } = req.body ?? {};
  if (typeof ledgerCsv !== 'string' || typeof bankCsv !== 'string') {
    res.status(400).json({ error: 'ledgerCsv and bankCsv must be CSV text' });
    return;
  }

  const describe = (csv: string, fields: FieldDef[]) => {
    const [header = [], ...rows] = parseCsvRows(csv);
    const headers = header.map((h) => h.trim());
    return {
      headers,
      rowCount: rows.length,
      sample: rows.slice(0, 5).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? '']))),
      fields: fields.map(({ key, label, type, required }) => ({ key, label, type, required })),
      suggested: suggestMapping(headers, fields),
    };
  };

  res.json({ ledger: describe(ledgerCsv, LEDGER_FIELDS), bank: describe(bankCsv, BANK_FIELDS) });
});

/**
 * POST /api/datasets/upload
 * Body: { name?, dateFormat?, ledger: { csv, mapping }, bank: { csv, mapping } }.
 * Validates every row; loads nothing and returns 422 with row-level errors if any are invalid.
 */
apiRouter.post('/datasets/upload', async (req: Request, res: Response) => {
  const body = req.body ?? {};
  if (typeof body.ledger?.csv !== 'string' || typeof body.bank?.csv !== 'string'
      || typeof body.ledger?.mapping !== 'object' || typeof body.bank?.mapping !== 'object') {
    res.status(400).json({ error: 'ledger and bank must each have csv text and a mapping' });
    return;
  }
  if (body.dateFormat && !['auto', 'YMD', 'DMY', 'MDY'].includes(body.dateFormat)) {
    res.status(400).json({ error: 'dateFormat must be auto, YMD, DMY or MDY' });
    return;
  }

  try {
    const result = await runManager.withLock('ingest', () => importUpload(body));
    if (result.ok) res.json({ success: true, dataset: result.dataset });
    else res.status(422).json({ error: 'Some rows are invalid', files: result.errors });
  } catch (err: any) {
    res.status(err instanceof BusyError ? 409 : 500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
//  RUNS
// ═══════════════════════════════════════════════════════════════════════

/**
 * GET /api/runs
 * The 50 most recent runs, newest first.
 */
apiRouter.get('/runs', async (_req: Request, res: Response) => {
  try {
    const runs = await query(`
      SELECT r.*, d.name AS dataset_name, d.source AS dataset_source
      FROM runs r LEFT JOIN datasets d ON d.id = r.dataset_id
      ORDER BY r.id DESC LIMIT 50
    `);
    res.json(runs.rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/runs
 * Body: { limit?, concurrency? }. Starts a background run over pending records
 * and returns it immediately (202). 409 if a run or data load is in progress.
 */
apiRouter.post('/runs', async (req: Request, res: Response) => {
  const limit = req.body?.limit == null ? undefined : Number(req.body.limit);
  const concurrency = req.body?.concurrency == null ? undefined : Number(req.body.concurrency);
  if ((limit !== undefined && !(limit > 0)) || (concurrency !== undefined && !(concurrency > 0))) {
    res.status(400).json({ error: 'limit and concurrency must be positive numbers' });
    return;
  }
  try {
    const run = await runManager.start({ limit, concurrency });
    res.status(202).json(run);
  } catch (err: any) {
    res.status(err instanceof BusyError ? 409 : 500).json({ error: err.message });
  }
});

async function getRun(id: number): Promise<RunRow | undefined> {
  if (!Number.isInteger(id)) return undefined;
  const result = await query<RunRow>(`SELECT * FROM runs WHERE id = $1`, [id]);
  return result.rows[0];
}

/**
 * GET /api/runs/:id
 */
apiRouter.get('/runs/:id', async (req: Request, res: Response) => {
  try {
    const run = await getRun(Number(req.params.id));
    if (!run) res.status(404).json({ error: 'Run not found' });
    else res.json(run);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/runs/:id/events
 * Server-Sent Events: the run row on connect and after every processed
 * record. The stream ends once the run has finished.
 */
apiRouter.get('/runs/:id/events', async (req: Request, res: Response) => {
  const runId = Number(req.params.id);
  let run: RunRow | undefined;
  try {
    run = await getRun(runId);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
    return;
  }
  if (!run) {
    res.status(404).json({ error: 'Run not found' });
    return;
  }

  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  const send = (row: RunRow) => res.write(`data: ${JSON.stringify(row)}\n\n`);
  send(run);

  if (run.status !== 'running') {
    res.end();
    return;
  }

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
  const cleanup = () => {
    clearInterval(heartbeat);
    runManager.off('update', onUpdate);
    res.end();
  };
  const onUpdate = (row: RunRow) => {
    if (row.id !== runId) return;
    send(row);
    if (row.status !== 'running') cleanup();
  };
  runManager.on('update', onUpdate);
  req.on('close', cleanup);
});

/**
 * POST /api/runs/:id/cancel
 * Stops the run after the records currently being processed.
 */
apiRouter.post('/runs/:id/cancel', (req: Request, res: Response) => {
  if (runManager.cancel(Number(req.params.id))) res.json({ success: true });
  else res.status(409).json({ error: 'That run is not active' });
});

// ═══════════════════════════════════════════════════════════════════════
//  RESULTS
// ═══════════════════════════════════════════════════════════════════════

/**
 * GET /api/matches
 * Fetches successfully matched records, joining with ledger and bank data.
 */
apiRouter.get('/matches', async (_req: Request, res: Response) => {
  try {
    const matches = await query(`
      SELECT
        m.id as match_id,
        m.ledger_id,
        m.run_id,
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
apiRouter.get('/exceptions', async (_req: Request, res: Response) => {
  try {
    const exceptions = await query(`
      SELECT
        e.id as exception_id,
        e.ledger_id,
        e.run_id,
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
      ORDER BY id ASC
    `, [ledgerId]);
    res.json(logs.rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/metrics
 * Record counts, plus precision / recall / accuracy of the agent's own
 * decisions against data/ground_truth.json when the demo dataset is loaded.
 */
apiRouter.get('/metrics', async (_req: Request, res: Response) => {
  try {
    const stats = await query(`
      SELECT
        (SELECT COUNT(*) FROM ledger_records) as total_records,
        (SELECT COUNT(*) FROM matches) as total_matches,
        (SELECT COUNT(*) FROM exceptions) as total_exceptions,
        (SELECT COUNT(*) FROM exceptions WHERE status = 'open') as open_exceptions,
        (SELECT COUNT(*) FROM exceptions WHERE status = 'rejected') as rejected_exceptions
    `);
    const evaluation = await evaluateDecisions();
    res.json({ ...stats.rows[0], ...(evaluation ?? {}), has_ground_truth: evaluation !== null });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
