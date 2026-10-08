/**
 * Razorpay settlements and gateway matching against Postgres, with Gemini
 * replaced by a fake that answers per invoice. Needs TEST_DATABASE_URL
 * (a disposable database — all tables are truncated).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import type { RazorpayReconItem } from '../src/services/razorpay';

type Call = { name: string; args: Record<string, unknown> };
/** Fake model replies keyed by invoice ID, consumed one per model turn. */
const scripts = new Map<string, Call[][]>();

const generateContent = vi.fn(async ({ contents }: { contents: { parts: { text?: string }[] }[] }) => {
  const invoice = /Invoice ID: (\S+)/.exec(contents[0].parts[0].text ?? '')?.[1] ?? '';
  const calls = scripts.get(invoice)?.shift() ?? [];
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

const recon = (over: Partial<RazorpayReconItem>): RazorpayReconItem => ({
  entity_id: 'pay_X', type: 'payment', debit: 0, credit: 0, amount: 0, currency: 'INR', fee: 0, tax: 0,
  settled: true, created_at: Date.UTC(2026, 7, 3, 6) / 1000, settled_at: Date.UTC(2026, 7, 5, 4) / 1000,
  settlement_id: 'setl_1', settlement_utr: 'UTRSETL1', description: null, notes: null,
  payment_id: null, order_id: null, order_receipt: null, method: 'upi', ...over,
});

describe.skipIf(!url)('gateway reconciliation (integration)', () => {
  let db: typeof import('../src/db');
  let ingest: typeof import('../src/services/ingest');
  let runner: typeof import('../src/services/runner');
  let razorpay: typeof import('../src/services/razorpay');
  let reconcileRecord: typeof import('../src/agent').reconcileRecord;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-gw-'));
    fs.writeFileSync(path.join(dataDir, 'ground_truth.json'), JSON.stringify([
      { ledger_invoice_id: 'INV-1', expected_bank_txn_id: null, expected_gateway_entity_id: 'pay_1', case_type: 'razorpay_receipt' },
      { ledger_invoice_id: 'INV-2', expected_bank_txn_id: null, expected_gateway_entity_id: 'pay_2', case_type: 'razorpay_no_receipt' },
      { ledger_invoice_id: 'INV-3', expected_bank_txn_id: null, expected_gateway_entity_id: null, case_type: 'razorpay_missing_payment' },
    ]));
    Object.assign(process.env, { DATABASE_URL: url, DATA_DIR: dataDir, GEMINI_API_KEY: 'test-key' });
    db = await import('../src/db');
    ingest = await import('../src/services/ingest');
    runner = await import('../src/services/runner');
    razorpay = await import('../src/services/razorpay');
    ({ reconcileRecord } = await import('../src/agent'));
    const { runMigration } = await import('../src/db/migration');
    await runMigration();
  });

  afterAll(async () => {
    await db?.closePool();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    scripts.clear();
    generateContent.mockClear();
    await db.query('TRUNCATE runs, datasets RESTART IDENTITY CASCADE');
    // pay_1 (receipt INV-1) and pay_2 (no receipt) settle together as setl_1;
    // the bank shows one Razorpay credit for the net amount.
    await ingest.loadDataset('Gateway test', 'demo', [
      { invoice_id: 'INV-1', customer_name: 'Bloom Organics', amount: 1000, invoice_date: '2026-08-03', payment_ref: null },
      { invoice_id: 'INV-2', customer_name: 'Pixelcraft Studio', amount: 2000, invoice_date: '2026-08-03', payment_ref: null },
      { invoice_id: 'INV-3', customer_name: 'Urban Tiffin Co', amount: 2950.5, invoice_date: '2026-08-04', payment_ref: null },
    ], [
      { txn_id: 'TXN-S', utr_ref: 'UTRSETL1', amount: 2929.2, txn_date: '2026-08-05', payer_name: 'RAZORPAY SOFTWARE PVT LTD', status: 'settled' },
    ], [
      recon({ entity_id: 'pay_1', amount: 100000, fee: 2360, tax: 360, credit: 97640, order_receipt: 'INV-1' }),
      recon({ entity_id: 'pay_2', amount: 200000, fee: 4720, tax: 720, credit: 195280, notes: { customer: 'PIXELCRAFT' } }),
    ].map((i) => razorpay.normaliseReconItem(i)));
  });

  async function runToCompletion() {
    const finished = new Promise<number>((resolve) => runner.runManager.once('finished', resolve));
    const run = await runner.runManager.start({ concurrency: 1 });
    await finished;
    return (await db.query<import('../src/services/runner').RunRow>('SELECT * FROM runs WHERE id = $1', [run.id])).rows[0];
  }

  it('reconciles the settlement, then matches invoices to gateway payments', async () => {
    scripts.set('INV-2', [
      [{ name: 'find_gateway_payments', args: { amount: 2000, date: '2026-08-03', receipt: 'INV-2' } }],
      [{ name: 'commit_match', args: { gateway_entity_id: 'pay_2', confidence: 0.92, method: 'reasoned', reasoning: 'Amount and date fit; notes name the customer' } }],
    ]);
    scripts.set('INV-3', [
      [{ name: 'flag_exception', args: { reason: 'no_candidate', reasoning: 'No gateway payment found' } }],
    ]);

    const run = await runToCompletion();

    expect(run).toMatchObject({ status: 'completed', matched: 2, exceptions: 1, precheck_hits: 1, errors: 0 });
    expect(run.settlements).toEqual({ matched: 1, mismatch: 0, missing: 0 });
    expect(run.metrics).toMatchObject({ accuracy: 1, confusion_matrix: { TP: 2, TN: 1 } });

    const settlement = await db.query(`SELECT status, difference::float AS difference FROM settlement_matches`);
    expect(settlement.rows).toEqual([{ status: 'matched', difference: 0 }]);
    const matches = await db.query(`
      SELECT l.invoice_id, g.entity_id, m.method FROM matches m
      JOIN ledger_records l ON l.id = m.ledger_id JOIN gateway_transactions g ON g.id = m.gateway_txn_id
      ORDER BY l.invoice_id`);
    expect(matches.rows).toEqual([
      { invoice_id: 'INV-1', entity_id: 'pay_1', method: 'exact' },
      { invoice_id: 'INV-2', entity_id: 'pay_2', method: 'reasoned' },
    ]);

    // Server startup re-runs the migration; it must cope with gateway matches (no bank_txn_id)
    const { runMigration } = await import('../src/db/migration');
    await expect(runMigration()).resolves.toBeUndefined();
  });

  it('blocks matching an invoice to a settlement payout', async () => {
    const { reconcileSettlements } = await import('../src/services/settlements');
    await reconcileSettlements();
    scripts.set('INV-3', [
      [{ name: 'explain_bank_credit', args: { bank_txn_id: 'TXN-S' } }],
      [{ name: 'commit_match', args: { bank_txn_id: 'TXN-S', confidence: 0.9, method: 'fuzzy', reasoning: 'close amount' } }],
    ]);

    const id = (await db.query<{ id: number }>(`SELECT id FROM ledger_records WHERE invoice_id = 'INV-3'`)).rows[0].id;
    const result = await reconcileRecord(id);

    expect(result).toMatchObject({ outcome: 'exception', exception_reason: 'ambiguous_candidates' });
    expect(result.reasoning).toMatch(/already matched to settlement setl_1/);
    const explained = result.trace.find((t) => t.tool_name === 'explain_bank_credit')!.tool_result as Record<string, unknown>;
    expect(explained).toMatchObject({ is_gateway_settlement: true, settlement_id: 'setl_1', expected_net: 2929.2 });
  });

  it('rejects a direct insert that double-claims a settlement credit', async () => {
    const { reconcileSettlements } = await import('../src/services/settlements');
    await reconcileSettlements();
    await expect(db.query(`
      INSERT INTO matches (ledger_id, bank_txn_id, method, confidence, reasoning)
      SELECT l.id, b.id, 'manual', 1, 'x' FROM ledger_records l, bank_transactions b
      WHERE l.invoice_id = 'INV-3' AND b.txn_id = 'TXN-S'`)).rejects.toThrow(/already claimed by a settlement/);
  });

  it('syncs the recon report from the API and updates lines that settle later', async () => {
    const day = (items: RazorpayReconItem[]) => new Response(JSON.stringify({ entity: 'collection', count: items.length, items }));
    const unsettled = recon({ entity_id: 'pay_9', amount: 50000, fee: 1180, tax: 180, credit: 48820, settled: false, settlement_id: null, settlement_utr: null, settled_at: null });
    await razorpay.syncRazorpay('2026-08-10', '2026-08-10', { keyId: 'k', keySecret: 's' }, vi.fn().mockResolvedValue(day([unsettled])));
    await razorpay.syncRazorpay('2026-08-11', '2026-08-12', { keyId: 'k', keySecret: 's' }, vi.fn()
      .mockResolvedValueOnce(day([{ ...unsettled, settled: true, settlement_id: 'setl_9', settlement_utr: 'UTR9', settled_at: Date.UTC(2026, 7, 12) / 1000 }]))
      .mockResolvedValueOnce(day([])));

    const row = (await db.query(`SELECT settled, settlement_id, amount::float AS amount FROM gateway_transactions WHERE entity_id = 'pay_9'`)).rows;
    expect(row).toEqual([{ settled: true, settlement_id: 'setl_9', amount: 500 }]);
  });
});
