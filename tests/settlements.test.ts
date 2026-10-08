import { describe, it, expect, vi } from 'vitest';
import { decideSettlement, describeSettlement, type SettlementSummary, type BankCandidate } from '../src/services/settlements';
import { normaliseReconItem, daysBetween, fetchReconForDay, RazorpayApiError, type RazorpayReconItem } from '../src/services/razorpay';
import { checkCommit } from '../src/agent/guardrails';
import { evaluate } from '../src/services/metrics';

const summary: SettlementSummary = {
  settlement_id: 'setl_A',
  settlement_utr: 'UTR1',
  settled_at: '2026-08-06',
  payment_count: 3,
  gross: 10000,
  fees: 236,
  tax: 36,
  refunds: 500,
  other: 0,
  net: 9264,
};

const bank = (over: Partial<BankCandidate> = {}): BankCandidate => ({
  id: 1, txn_id: 'TXN-1', utr_ref: 'UTR1', amount: 9264, txn_date: '2026-08-06', claimed_by: null, ...over,
});

describe('describeSettlement', () => {
  it('spells out the arithmetic', () => {
    expect(describeSettlement(summary)).toBe(
      '3 payments ₹10,000.00 − fees ₹236.00 (incl. GST ₹36.00) − refunds ₹500.00 = ₹9,264.00 net',
    );
  });
});

describe('decideSettlement', () => {
  it('matches the credit with the settlement UTR and the exact net amount', () => {
    expect(decideSettlement(summary, [bank()], [])).toMatchObject({ status: 'matched', bank_txn_id: 1, difference: 0 });
  });

  it('reports a mismatch with the difference when the amount is off', () => {
    const d = decideSettlement(summary, [bank({ amount: 8084 })], []);
    expect(d).toMatchObject({ status: 'mismatch', bank_txn_id: 1, difference: -1180 });
    expect(d.reasoning).toMatch(/₹1,180.00 less than expected/);
  });

  it('treats paisa-level float noise as equal', () => {
    expect(decideSettlement({ ...summary, net: 0.1 + 0.2 }, [bank({ amount: 0.3 })], []).status).toBe('matched');
  });

  it('does not claim a UTR credit already matched elsewhere', () => {
    const d = decideSettlement(summary, [bank({ claimed_by: 'INV-9' })], []);
    expect(d).toMatchObject({ status: 'mismatch', bank_txn_id: null });
    expect(d.reasoning).toMatch(/already matched to INV-9/);
  });

  it('flags a UTR that appears on several credits', () => {
    expect(decideSettlement(summary, [bank(), bank({ id: 2, txn_id: 'TXN-2' })], []).status).toBe('mismatch');
  });

  it('falls back to a unique exact-amount credit when the UTR is absent', () => {
    const d = decideSettlement(summary, [], [bank({ utr_ref: 'NEFT-XYZ' })]);
    expect(d).toMatchObject({ status: 'matched', bank_txn_id: 1 });
    expect(d.reasoning).toMatch(/not on the statement/);
  });

  it('is missing when nothing fits, or when the amount fallback is ambiguous', () => {
    expect(decideSettlement(summary, [], []).status).toBe('missing');
    expect(decideSettlement(summary, [], [bank(), bank({ id: 2, txn_id: 'TXN-2' })]).status).toBe('missing');
  });
});

const item = (over: Partial<RazorpayReconItem> = {}): RazorpayReconItem => ({
  entity_id: 'pay_1', type: 'payment', debit: 0, credit: 97100, amount: 100000, currency: 'INR',
  fee: 2900, tax: 442, settled: true, created_at: 1567692556, settled_at: 1568176960,
  settlement_id: 'setl_1', settlement_utr: 'UTR1', description: null, notes: null,
  payment_id: null, order_id: 'order_1', order_receipt: 'INV-1', method: 'card', ...over,
});

describe('normaliseReconItem', () => {
  it('converts paise to rupees and unix seconds to ISO timestamps', () => {
    expect(normaliseReconItem(item())).toMatchObject({
      entity_id: 'pay_1', entity_type: 'payment', amount: 1000, fee: 29, tax: 4.42, credit: 971, debit: 0,
      created_at: '2019-09-05T14:09:16.000Z', settled_at: '2019-09-11T04:42:40.000Z', order_receipt: 'INV-1',
    });
  });

  it('handles unsettled lines and missing fees', () => {
    expect(normaliseReconItem(item({ settled: false, settled_at: null, settlement_id: null, fee: null, tax: null })))
      .toMatchObject({ settled: false, settled_at: null, settlement_id: null, fee: 0, tax: 0 });
  });
});

describe('daysBetween', () => {
  it('lists each day inclusive, across month ends', () => {
    expect(daysBetween('2026-08-30', '2026-09-01')).toEqual([
      { year: 2026, month: 8, day: 30 }, { year: 2026, month: 8, day: 31 }, { year: 2026, month: 9, day: 1 },
    ]);
  });

  it('rejects bad or over-long ranges', () => {
    expect(() => daysBetween('2026-09-02', '2026-09-01')).toThrow();
    expect(() => daysBetween('nope', '2026-09-01')).toThrow();
    expect(() => daysBetween('2026-01-01', '2026-12-31')).toThrow(/at most/);
  });
});

describe('fetchReconForDay', () => {
  const creds = { keyId: 'rzp_test_abc', keySecret: 'secret' };

  it('authenticates with basic auth and follows pages', async () => {
    const full = Array.from({ length: 1000 }, (_, i) => item({ entity_id: `pay_${i}` }));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: full })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [item({ entity_id: 'pay_last' })] })));

    const items = await fetchReconForDay({ year: 2026, month: 8, day: 6 }, creds, fetchMock);

    expect(items).toHaveLength(1001);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/settlements/recon/combined?year=2026&month=08&day=06&count=1000&skip=0');
    expect(fetchMock.mock.calls[1][0]).toContain('skip=1000');
    expect(init.headers.Authorization).toBe('Basic ' + Buffer.from('rzp_test_abc:secret').toString('base64'));
  });

  it('surfaces the API error description', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: { description: 'The api key provided is invalid' } }), { status: 401 },
    ));
    const err = await fetchReconForDay({ year: 2026, month: 8, day: 6 }, creds, fetchMock).catch((e) => e);
    expect(err).toBeInstanceOf(RazorpayApiError);
    expect(err).toMatchObject({ status: 401, message: 'The api key provided is invalid' });
  });
});

describe('gateway guardrail', () => {
  it('only lets payments be matched to invoices', () => {
    const refund = { txn_id: 'rfnd_1', utr_ref: null, amount: 1000, ref_count: 1, matched_to: null, entity_type: 'refund' };
    expect(checkCommit(1000, 0.99, refund, 'rfnd_1')).toMatchObject({ ok: false, reason: 'unexplained_discrepancy' });
    expect(checkCommit(1000, 0.99, { ...refund, entity_type: 'payment' }, 'pay_1')).toEqual({ ok: true });
  });
});

describe('evaluate with gateway payments', () => {
  it('scores an invoice against its expected gateway payment', () => {
    const r = evaluate([
      { ledger_invoice_id: 'A', expected_bank_txn_id: null, expected_gateway_entity_id: 'pay_A', case_type: 'razorpay_receipt' },
      { ledger_invoice_id: 'B', expected_bank_txn_id: null, expected_gateway_entity_id: null, case_type: 'razorpay_missing_payment' },
    ], new Map<string, string | null>([['A', 'pay_A'], ['B', null]]));
    expect(r.confusion_matrix).toEqual({ TP: 1, FP: 0, FN: 0, TN: 1 });
  });
});
