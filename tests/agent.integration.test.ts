/**
 * Runs the real agent loop against Postgres, with Gemini replaced by a
 * scripted fake. Needs a disposable database:
 *
 *   TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/reconagent_test npm test
 *
 * WARNING: every table in that database is truncated between tests.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';

type Call = { name: string; args: Record<string, unknown> };
const script: Call[][] = [];
const generateContent = vi.fn(async () => {
  const calls = script.shift() ?? [];
  return { response: { candidates: [{ content: { parts: calls.map((functionCall) => ({ functionCall })) } }] } };
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

describe.skipIf(!url)('reconcileRecord (integration)', () => {
  let db: typeof import('../src/db');
  let reconcileRecord: typeof import('../src/agent').reconcileRecord;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.GEMINI_API_KEY = 'test-key';
    db = await import('../src/db');
    ({ reconcileRecord } = await import('../src/agent'));
    const { runMigration } = await import('../src/db/migration');
    await runMigration();
  });

  afterAll(async () => {
    await db?.closePool();
  });

  beforeEach(async () => {
    script.length = 0;
    generateContent.mockClear();
    await db.query('TRUNCATE audit_log, exceptions, matches, bank_transactions, ledger_records RESTART IDENTITY CASCADE');
  });

  async function ledger(invoice: string, amount: number, ref: string, date = '2026-08-10'): Promise<number> {
    const r = await db.query<{ id: number }>(
      `INSERT INTO ledger_records (invoice_id, customer_name, amount, invoice_date, payment_ref)
       VALUES ($1, 'Acme Traders', $2, $3, $4) RETURNING id`,
      [invoice, amount, date, ref],
    );
    return r.rows[0].id;
  }

  async function bank(txn: string, amount: number, ref: string, date = '2026-08-10'): Promise<void> {
    await db.query(
      `INSERT INTO bank_transactions (txn_id, utr_ref, amount, txn_date, payer_name, status)
       VALUES ($1, $2, $3, $4, 'Acme Traders', 'settled')`,
      [txn, ref, amount, date],
    );
  }

  const commit = (txn: string, confidence = 0.95, method = 'fuzzy'): Call =>
    ({ name: 'commit_match', args: { bank_txn_id: txn, confidence, method, reasoning: 'looks right' } });

  async function auditTools(ledgerId: number): Promise<string[]> {
    const r = await db.query<{ tool_name: string }>(
      `SELECT tool_name FROM audit_log WHERE ledger_id = $1 ORDER BY id`, [ledgerId],
    );
    return r.rows.map((row) => row.tool_name);
  }

  it('matches a clean exact record in the precheck without calling the model', async () => {
    const id = await ledger('INV-1', 1000, 'REF-1');
    await bank('TXN-1', 1000, 'REF-1');

    const result = await reconcileRecord(id);

    expect(result).toMatchObject({ outcome: 'matched', method: 'exact', precheck: true });
    expect(generateContent).not.toHaveBeenCalled();
  });

  it('commits a fuzzy match within tolerance', async () => {
    const id = await ledger('INV-1', 1000, 'REF-1');
    await bank('TXN-1', 997, 'REF-1');
    script.push([{ name: 'check_duplicate_ref', args: { reference: 'REF-1' } }], [commit('TXN-1')]);

    const result = await reconcileRecord(id);

    expect(result).toMatchObject({ outcome: 'matched', method: 'fuzzy', matched_bank_txn_id: 'TXN-1' });
    expect(await auditTools(id)).toEqual(['check_duplicate_ref', 'commit_match']);
  });

  it('turns a commit on a duplicated reference into an exception', async () => {
    const id = await ledger('INV-1', 1000, 'REF-1');
    await bank('TXN-1', 1000, 'REF-1');
    await bank('TXN-2', 5000, 'REF-1');
    // The model skips check_duplicate_ref and commits anyway
    script.push([commit('TXN-1', 0.99, 'exact')]);

    const result = await reconcileRecord(id);

    expect(result).toMatchObject({ outcome: 'exception', exception_reason: 'duplicate_reference' });
    expect(await auditTools(id)).toEqual(['commit_match', 'guardrail_override']);
    expect((await db.query('SELECT 1 FROM matches')).rowCount).toBe(0);
  });

  it('never lets two invoices claim the same bank transaction', async () => {
    const first = await ledger('INV-1', 1000, 'REF-1');
    const second = await ledger('INV-2', 1000, 'REF-2');
    await bank('TXN-1', 1000, 'REF-1');
    await reconcileRecord(first);

    script.push([commit('TXN-1')]);
    const result = await reconcileRecord(second);

    expect(result).toMatchObject({ outcome: 'exception', exception_reason: 'ambiguous_candidates' });
    expect((await db.query('SELECT 1 FROM matches')).rowCount).toBe(1);
  });

  it('refuses to reconcile a record twice', async () => {
    const id = await ledger('INV-1', 1000, 'REF-1');
    await bank('TXN-1', 1000, 'REF-1');
    await reconcileRecord(id);

    await expect(reconcileRecord(id)).rejects.toThrow(/already reconciled/);
  });

  it('stops executing tools after the budget and hard-stops', async () => {
    const id = await ledger('INV-1', 1000, 'REF-1');
    for (let i = 0; i < 10; i++) {
      script.push([{ name: 'compare_names', args: { name_a: 'a', name_b: 'b' } }]);
    }

    const result = await reconcileRecord(id);

    expect(result.outcome).toBe('timeout');
    const results = await db.query<{ tool_result: { error?: string } }>(
      `SELECT tool_result FROM audit_log WHERE ledger_id = $1 AND tool_name = 'compare_names'`, [id],
    );
    const executed = results.rows.filter((r) => !r.tool_result.error);
    expect(executed).toHaveLength(6);
    expect(await auditTools(id)).toContain('hard_stop');
  });
});
