/**
 * Background reconciliation runs.
 *
 * A run reconciles pending ledger records with a small pool of concurrent
 * workers. Progress counters live in the `runs` row (updated atomically after
 * every record) and each update is broadcast to listeners, which the API
 * streams to the dashboard over Server-Sent Events.
 *
 * Only one run, or one data load, can be active at a time.
 */
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { query } from '../db';
import config from '../config';
import { reconcileRecord, MODEL_NAME, PROMPT_VERSION } from '../agent';
import { currentDataset } from './ingest';
import { reconcileSettlements } from './settlements';
import { evaluate, type GroundTruthEntry, type EvaluationResult } from './metrics';

export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export interface RunRow {
  id: number;
  dataset_id: number | null;
  status: RunStatus;
  model: string;
  prompt_version: string;
  concurrency: number;
  total: number;
  processed: number;
  matched: number;
  exceptions: number;
  errors: number;
  precheck_hits: number;
  llm_calls: number;
  input_tokens: number;
  output_tokens: number;
  failures: { ledger_id: number; invoice_id?: string; error: string }[];
  metrics: EvaluationResult | null;
  /** Settlement outcomes decided by this run: { matched, mismatch, missing }. */
  settlements: Record<string, number> | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface StartRunOptions {
  /** Max records to process (default: all pending). */
  limit?: number;
  /** Concurrent workers (default: RUN_CONCURRENCY env or 2). */
  concurrency?: number;
}

export class BusyError extends Error {}

const MAX_CONCURRENCY = 8;
/** Stop a run after this many record failures in a row (e.g. bad API key, quota gone). */
const MAX_CONSECUTIVE_FAILURES = 5;

/** Ground truth only applies to the synthetic demo dataset. */
export async function loadGroundTruth(): Promise<GroundTruthEntry[] | null> {
  const dataset = await currentDataset();
  if (dataset?.source !== 'demo') return null;
  const gtPath = path.join(config.dataDir, 'ground_truth.json');
  if (!fs.existsSync(gtPath)) return null;
  return JSON.parse(fs.readFileSync(gtPath, 'utf-8'));
}

/**
 * Score agent decisions (optionally only those made in one run) against ground truth.
 * Manual matches are human decisions and are excluded.
 */
export async function evaluateDecisions(runId?: number): Promise<EvaluationResult | null> {
  const truth = await loadGroundTruth();
  if (!truth) return null;

  const filter = runId === undefined ? '' : 'AND x.run_id = $1';
  const params = runId === undefined ? [] : [runId];
  // A match's counterpart is a bank txn or a gateway payment
  const decisions = await query<{ invoice_id: string; bank_txn_id: string | null }>(`
    SELECT l.invoice_id, COALESCE(b.txn_id, g.entity_id) AS bank_txn_id
    FROM matches x
    JOIN ledger_records l ON x.ledger_id = l.id
    LEFT JOIN bank_transactions b ON x.bank_txn_id = b.id
    LEFT JOIN gateway_transactions g ON x.gateway_txn_id = g.id
    WHERE x.method <> 'manual' ${filter}
    UNION ALL
    SELECT l.invoice_id, NULL
    FROM exceptions x
    JOIN ledger_records l ON x.ledger_id = l.id
    WHERE TRUE ${filter}
  `, params);

  return evaluate(truth, new Map(decisions.rows.map((r) => [r.invoice_id, r.bank_txn_id])));
}

class RunManager extends EventEmitter {
  private busy: 'ingest' | 'reconcile' | null = null;
  private activeRunId: number | null = null;
  private cancelRequested = false;

  get activeRun(): number | null {
    return this.activeRunId;
  }

  /** Run `fn` while holding the shared lock used by data loads and runs. */
  async withLock<T>(kind: 'ingest', fn: () => Promise<T>): Promise<T> {
    if (this.busy) throw new BusyError(`A ${this.busy} is already in progress`);
    this.busy = kind;
    try {
      return await fn();
    } finally {
      this.busy = null;
    }
  }

  /** Mark runs left 'running' by a previous process (crash / restart) as interrupted. */
  async recoverInterrupted(): Promise<void> {
    const result = await query(
      `UPDATE runs SET status = 'interrupted', finished_at = now()
       WHERE status = 'running' RETURNING id`,
    );
    if (result.rowCount) {
      console.log(`[Runs] Marked ${result.rowCount} unfinished run(s) as interrupted`);
    }
  }

  async start(options: StartRunOptions = {}): Promise<RunRow> {
    if (this.busy) throw new BusyError(`A ${this.busy} is already in progress`);
    this.busy = 'reconcile';

    try {
      const pending = await query<{ id: number }>(`
        SELECT l.id FROM ledger_records l
        WHERE NOT EXISTS (SELECT 1 FROM matches m WHERE m.ledger_id = l.id)
          AND NOT EXISTS (SELECT 1 FROM exceptions e WHERE e.ledger_id = l.id)
        ORDER BY l.id
      `);
      const limit = options.limit && options.limit > 0 ? options.limit : pending.rows.length;
      const ids = pending.rows.slice(0, limit).map((r) => r.id);
      const concurrency = Math.min(
        Math.max(1, options.concurrency ?? Number(process.env.RUN_CONCURRENCY ?? 2)),
        MAX_CONCURRENCY,
      );
      const dataset = await currentDataset();

      const created = await query<RunRow>(
        `INSERT INTO runs (dataset_id, model, prompt_version, concurrency, total)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [dataset?.id ?? null, MODEL_NAME, PROMPT_VERSION, concurrency, ids.length],
      );
      const run = created.rows[0];

      this.activeRunId = run.id;
      this.cancelRequested = false;
      // Deliberately not awaited: the run continues in the background
      void this.process(run, ids);
      return run;
    } catch (err) {
      this.busy = null;
      throw err;
    }
  }

  /** Ask the active run to stop after the records currently in flight. */
  cancel(runId: number): boolean {
    if (this.activeRunId !== runId) return false;
    this.cancelRequested = true;
    return true;
  }

  private async process(run: RunRow, ids: number[]): Promise<void> {
    let next = 0;
    let consecutiveFailures = 0;
    let fatalError: string | null = null;

    const worker = async () => {
      while (next < ids.length && !this.cancelRequested && !fatalError) {
        const ledgerId = ids[next++];
        try {
          const result = await reconcileRecord(ledgerId, { runId: run.id });
          consecutiveFailures = 0;
          await this.bump(run.id, `
            processed = processed + 1,
            matched = matched + $2, exceptions = exceptions + $3,
            precheck_hits = precheck_hits + $4,
            llm_calls = llm_calls + $5, input_tokens = input_tokens + $6, output_tokens = output_tokens + $7`,
            [
              result.outcome === 'matched' ? 1 : 0,
              result.outcome === 'matched' ? 0 : 1,
              result.precheck ? 1 : 0,
              result.usage.llm_calls,
              result.usage.input_tokens,
              result.usage.output_tokens,
            ]);
        } catch (err) {
          const message = (err as Error).message ?? String(err);
          console.error(`[Runs] run ${run.id}, ledger ${ledgerId}: ${message}`);
          await this.bump(run.id, `
            processed = processed + 1, errors = errors + 1,
            failures = failures || jsonb_build_array(jsonb_build_object('ledger_id', $2::int, 'error', $3::text))`,
            [ledgerId, message.slice(0, 500)]);
          if (++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            fatalError = `Stopped after ${consecutiveFailures} consecutive failures. Last error: ${message.slice(0, 300)}`;
          }
        }
      }
    };

    try {
      // Settlements first: once their bank credits are claimed, the agent
      // can't mistake a Razorpay payout for a single invoice's payment.
      const settlements = await reconcileSettlements(run.id);
      await this.bump(run.id, `settlements = $2`, [JSON.stringify(settlements)]);

      await Promise.all(Array.from({ length: Math.min(run.concurrency, ids.length) }, worker));
      const metrics = await evaluateDecisions(run.id);
      const status: RunStatus = fatalError ? 'failed' : this.cancelRequested ? 'cancelled' : 'completed';
      await this.bump(run.id, `status = $2, metrics = $3, error = $4, finished_at = now()`,
        [status, metrics ? JSON.stringify(metrics) : null, fatalError]);
    } catch (err) {
      await this.bump(run.id, `status = 'failed', error = $2, finished_at = now()`, [(err as Error).message]);
    } finally {
      this.activeRunId = null;
      this.cancelRequested = false;
      this.busy = null;
      this.emit('finished', run.id);
    }
  }

  /** Atomically update the run row and broadcast the new state. */
  private async bump(runId: number, set: string, params: unknown[]): Promise<void> {
    const result = await query<RunRow>(`UPDATE runs SET ${set} WHERE id = $1 RETURNING *`, [runId, ...params]);
    this.emit('update', result.rows[0]);
  }
}

export const runManager = new RunManager();
