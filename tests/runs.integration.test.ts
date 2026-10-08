/**
 * Background runs and uploads against Postgres, with Gemini replaced by a fake.
 * Needs TEST_DATABASE_URL (a disposable database — all tables are truncated).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';

type Reply = { name: string; args: Record<string, unknown> }[];
type Behaviour = () => Promise<Reply>;

const flag: Reply = [{ name: 'flag_exception', args: { reason: 'no_candidate', reasoning: 'nothing found' } }];
let behaviour: Behaviour = async () => flag;

const generateContent = vi.fn(async () => {
  const calls = await behaviour();
  return {
    response: {
      candidates: [{ content: { parts: calls.map((functionCall) => ({ functionCall })) } }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10 },
    },
  };
});

vi.mock('@google/generative-ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@google/generative-ai')>()),
  GoogleGenerativeAI: class {
    getGenerativeModel() {
      return { generateContent };
    }
  },
}));

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('runs and uploads (integration)', () => {
  let db: typeof import('../src/db');
  let runner: typeof import('../src/services/runner');
  let ingest: typeof import('../src/services/ingest');
  let dataDir: string;

  beforeAll(async () => {
    // Ground truth for the demo dataset used below
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-test-'));
    fs.writeFileSync(path.join(dataDir, 'ground_truth.json'), JSON.stringify([
      { ledger_invoice_id: 'INV-1', expected_bank_txn_id: 'TXN-1', case_type: 'clean_exact' },
      { ledger_invoice_id: 'INV-2', expected_bank_txn_id: null, case_type: 'missing_bank_txn' },
      { ledger_invoice_id: 'INV-3', expected_bank_txn_id: null, case_type: 'missing_bank_txn' },
      { ledger_invoice_id: 'INV-4', expected_bank_txn_id: null, case_type: 'missing_bank_txn' },
    ]));

    Object.assign(process.env, {
      DATABASE_URL: url,
      DATA_DIR: dataDir,
      GEMINI_API_KEY: 'test-key',
      GEMINI_RPM: '0',
      GEMINI_RETRY_BASE_MS: '1',
    });
    db = await import('../src/db');
    runner = await import('../src/services/runner');
    ingest = await import('../src/services/ingest');
    const { runMigration } = await import('../src/db/migration');
    await runMigration();
  });

  afterAll(async () => {
    await db?.closePool();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    behaviour = async () => flag;
    generateContent.mockClear();
    await db.query('TRUNCATE audit_log, exceptions, matches, settlement_matches, gateway_transactions, bank_transactions, ledger_records, runs, datasets RESTART IDENTITY CASCADE');
    // INV-1 is a clean exact match (precheck); INV-2..4 need the model
    await ingest.loadDataset('Test demo', 'demo', [
      { invoice_id: 'INV-1', customer_name: 'Acme', amount: 1000, invoice_date: '2026-08-10', payment_ref: 'REF-1' },
      { invoice_id: 'INV-2', customer_name: 'Beta', amount: 2000, invoice_date: '2026-08-10', payment_ref: 'REF-2' },
      { invoice_id: 'INV-3', customer_name: 'Gamma', amount: 3000, invoice_date: '2026-08-10', payment_ref: 'REF-3' },
      { invoice_id: 'INV-4', customer_name: 'Delta', amount: 4000, invoice_date: '2026-08-10', payment_ref: 'REF-4' },
    ], [
      { txn_id: 'TXN-1', utr_ref: 'REF-1', amount: 1000, txn_date: '2026-08-10', payer_name: 'Acme', status: 'settled' },
    ]);
  });

  /** Start a run and wait for it to finish. */
  async function runToCompletion(options = {}) {
    const finished = new Promise<number>((resolve) => runner.runManager.once('finished', resolve));
    const run = await runner.runManager.start(options);
    await finished;
    const result = await db.query<import('../src/services/runner').RunRow>('SELECT * FROM runs WHERE id = $1', [run.id]);
    return result.rows[0];
  }

  it('processes every pending record and records counters, usage and metrics', async () => {
    const run = await runToCompletion({ concurrency: 2 });

    expect(run).toMatchObject({
      status: 'completed', total: 4, processed: 4, matched: 1, exceptions: 3, errors: 0,
      precheck_hits: 1, llm_calls: 3, input_tokens: 300, output_tokens: 30,
    });
    expect(run.metrics).toMatchObject({ accuracy: 1, pending_records: 0, confusion_matrix: { TP: 1, TN: 3 } });

    const stamped = await db.query(`
      SELECT (SELECT COUNT(*) FROM matches WHERE run_id = $1)::int AS m,
             (SELECT COUNT(*) FROM exceptions WHERE run_id = $1)::int AS e`, [run.id]);
    expect(stamped.rows[0]).toEqual({ m: 1, e: 3 });
  });

  it('only picks up records still pending, up to the limit', async () => {
    const first = await runToCompletion({ limit: 2 });
    const second = await runToCompletion();

    expect(first).toMatchObject({ total: 2, processed: 2 });
    expect(second).toMatchObject({ total: 2, processed: 2 });
  });

  it('retries a rate-limited model call', async () => {
    let calls = 0;
    behaviour = async () => {
      if (calls++ === 0) throw Object.assign(new Error('[429 Too Many Requests]'), { status: 429 });
      return flag;
    };

    const run = await runToCompletion({ concurrency: 1 });

    expect(run).toMatchObject({ status: 'completed', errors: 0, exceptions: 3 });
    expect(generateContent).toHaveBeenCalledTimes(4);
  });

  it('fails the run after repeated non-retryable errors and leaves records pending', async () => {
    behaviour = async () => {
      throw Object.assign(new Error('[400 Bad Request] API key not valid'), { status: 400 });
    };
    await db.query(`INSERT INTO ledger_records (invoice_id, customer_name, amount, invoice_date)
                    SELECT 'X-' || g, 'X', 1, '2026-08-10' FROM generate_series(1, 6) g`);

    const run = await runToCompletion({ concurrency: 1 });

    expect(run.status).toBe('failed');
    expect(run.errors).toBe(5);
    expect(run.error).toMatch(/5 consecutive failures.*API key not valid/);
    expect(run.failures).toHaveLength(5);
    expect(generateContent).toHaveBeenCalledTimes(5); // 400s are not retried
  });

  it('can be cancelled, and blocks other runs and data loads while active', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    behaviour = async () => {
      await gate;
      return flag;
    };

    const finished = new Promise<number>((resolve) => runner.runManager.once('finished', resolve));
    const run = await runner.runManager.start({ concurrency: 1 });

    await expect(runner.runManager.start()).rejects.toBeInstanceOf(runner.BusyError);
    await expect(runner.runManager.withLock('ingest', async () => 'x')).rejects.toBeInstanceOf(runner.BusyError);

    expect(runner.runManager.cancel(run.id)).toBe(true);
    release();
    await finished;

    const row = (await db.query<{ status: string; processed: number }>('SELECT * FROM runs WHERE id = $1', [run.id])).rows[0];
    expect(row.status).toBe('cancelled');
    expect(row.processed).toBeLessThan(4);
    await expect(runner.runManager.withLock('ingest', async () => 'ok')).resolves.toBe('ok');
  });

  it('marks runs left running by a previous process as interrupted', async () => {
    await db.query(`INSERT INTO runs (model, prompt_version, concurrency, total) VALUES ('m', 'p', 1, 5)`);
    await runner.runManager.recoverInterrupted();
    const row = (await db.query<{ status: string }>('SELECT status FROM runs')).rows[0];
    expect(row.status).toBe('interrupted');
  });

  it('imports an uploaded bank statement and skips ground-truth scoring for it', async () => {
    const result = await ingest.importUpload({
      name: 'August statement',
      ledger: {
        csv: 'Invoice No,Party Name,Total,Bill Date\nA-1,"Acme, Inc","₹1,500.00",07/08/2026\n',
        mapping: { invoice_id: 'Invoice No', customer_name: 'Party Name', amount: 'Total', invoice_date: 'Bill Date', payment_ref: null },
      },
      bank: {
        csv: 'Value Date,Narration,Ref No,Deposit Amt\n08/08/2026,NEFT ACME INC,UTR123,"1,500.00"\n',
        mapping: { txn_id: null, utr_ref: 'Ref No', amount: 'Deposit Amt', txn_date: 'Value Date', payer_name: 'Narration', status: null },
      },
    });

    expect(result).toMatchObject({ ok: true, dataset: { name: 'August statement', source: 'upload', ledger_count: 1, bank_count: 1 } });
    const bank = await db.query('SELECT txn_id, amount::float AS amount, txn_date::text AS txn_date FROM bank_transactions');
    expect(bank.rows).toEqual([{ txn_id: 'BANK-00001', amount: 1500, txn_date: '2026-08-08' }]);
    expect(await runner.evaluateDecisions()).toBeNull();
  });

  it('rejects an invalid upload without touching the current data', async () => {
    const result = await ingest.importUpload({
      ledger: {
        csv: 'id,name,amt,date\nA-1,Acme,abc,07/08/2026\nA-1,Acme,10,07/08/2026\n',
        mapping: { invoice_id: 'id', customer_name: 'name', amount: 'amt', invoice_date: 'date', payment_ref: null },
      },
      bank: {
        csv: 'date,name,amt\n07/08/2026,Acme,10\n',
        mapping: { txn_id: null, utr_ref: null, amount: 'amt', txn_date: 'date', payer_name: 'name', status: null },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([{
        file: 'ledger',
        errors: [
          expect.objectContaining({ row: 2, field: 'amount' }),
          expect.objectContaining({ row: 3, field: 'invoice_id' }),
        ],
      }]);
    }
    const count = await db.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM ledger_records');
    expect(count.rows[0].n).toBe(4);
  });
});
