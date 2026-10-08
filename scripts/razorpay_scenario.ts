/**
 * scripts/razorpay_scenario.ts
 *
 * Synthetic Razorpay data for the demo: invoices paid through the gateway,
 * the settlement recon report Razorpay would return for them, and the bank
 * credits those settlements produce.
 *
 * Shapes follow GET /v1/settlements/recon/combined: amounts in paise,
 * timestamps in unix seconds, and for payments credit = amount - fee
 * (fee already includes GST; tax is the GST part of fee).
 *
 * Settlements cover every outcome the reconciler has to handle:
 *   S1  clean                       → bank credit equals net settlement
 *   S2  includes a refund deduction → still matches (refund nets off)
 *   S3  bank credit short by an adjustment missing from the report → mismatch
 *   S4  report says settled, no bank credit yet                    → missing
 * plus one captured-but-unsettled payment, two payments without an
 * order_receipt (only notes), and one invoice with no Razorpay payment.
 */

/** Mulberry32 — same PRNG as the main generator, separate seed. */
function makeRng(seed: number) {
  let state = seed;
  const next = () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min: number, max: number) => Math.floor(next() * (max - min + 1)) + min,
    pick: <T>(arr: readonly T[]) => arr[Math.floor(next() * arr.length)],
  };
}

export interface ReconItem {
  entity_id: string;
  type: 'payment' | 'refund' | 'transfer' | 'adjustment';
  debit: number;
  credit: number;
  amount: number;
  currency: 'INR';
  fee: number;
  tax: number;
  on_hold: boolean;
  settled: boolean;
  created_at: number;
  settled_at: number | null;
  settlement_id: string | null;
  posted_at: null;
  credit_type: 'default';
  description: string | null;
  notes: Record<string, string> | null;
  payment_id: string | null;
  settlement_utr: string | null;
  order_id: string | null;
  order_receipt: string | null;
  method: 'card' | 'netbanking' | 'wallet' | 'upi' | 'emi' | null;
  card_network: string | null;
  card_issuer: string | null;
  card_type: 'credit' | 'debit' | null;
  dispute_id: string | null;
}

export interface ScenarioLedger {
  invoice_id: string;
  customer_name: string;
  amount: number;
  invoice_date: string;
  payment_ref: string;
}

export interface ScenarioBank {
  txn_id: string;
  utr_ref: string;
  amount: number;
  txn_date: string;
  payer_name: string;
  status: string;
}

export interface ScenarioTruth {
  ledger_invoice_id: string;
  expected_bank_txn_id: null;
  /** Razorpay payment the invoice should be matched to (null = exception). */
  expected_gateway_entity_id: string | null;
  case_type: string;
}

export interface SettlementTruth {
  settlement_id: string;
  settlement_utr: string;
  expected_status: 'matched' | 'mismatch' | 'missing';
  expected_bank_txn_id: string | null;
  /** Net amount the recon report says was paid out, in rupees. */
  expected_amount: number;
  description: string;
}

const CUSTOMERS = [
  'Bloom Organics', 'Pixelcraft Studio', 'Urban Tiffin Co', 'Nimbus Analytics',
  'Saffron Skincare', 'Trekkers Hub', 'Kettle & Brew Cafe', 'Lumen Learning Labs',
  'Vastra Handloom', 'Brightpath Tutors', 'Aarogya Diagnostics', 'Cloudnine Software',
  'Masala Box Foods', 'Greenleaf Nursery', 'Orbit Fitness',
] as const;

const METHODS = [
  { method: 'upi', rate: 0.02 },
  { method: 'card', rate: 0.02, network: 'Visa', type: 'credit' },
  { method: 'card', rate: 0.02, network: 'MasterCard', type: 'debit' },
  { method: 'card', rate: 0.03, network: 'American Express', type: 'credit' },
  { method: 'netbanking', rate: 0.02 },
  { method: 'wallet', rate: 0.02 },
] as const;

const GST_RATE = 0.18;
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export function generateRazorpayScenario(opts: {
  nextInvoiceId: () => string;
  nextTxnId: () => string;
  seed?: number;
}) {
  const rng = makeRng(opts.seed ?? 2026);
  const id = (prefix: string) => prefix + Array.from({ length: 14 }, () => rng.pick(BASE62.split(''))).join('');

  /** Unix seconds for a date in Aug 2026 at hh:mm IST. */
  const ts = (day: number, hour: number, minute = 0) =>
    Math.floor(Date.UTC(2026, 7, day, hour - 5, minute - 30) / 1000);
  const dateOf = (day: number) => `2026-08-${String(day).padStart(2, '0')}`;
  const rupees = (paise: number) => paise / 100;

  const ledger: ScenarioLedger[] = [];
  const bank: ScenarioBank[] = [];
  const items: ReconItem[] = [];
  const truth: ScenarioTruth[] = [];
  const settlementTruth: SettlementTruth[] = [];
  let customer = 0;

  /** A captured payment for a new invoice. Returns the payment item. */
  function payment(day: number, opts2: { receipt?: boolean; settled?: boolean } = {}): ReconItem {
    const invoiceId = opts.nextInvoiceId();
    const name = CUSTOMERS[customer++ % CUSTOMERS.length];
    const amount = rng.int(999, 49_999) * 100 + rng.pick([0, 0, 0, 50, 99]);
    const m = rng.pick(METHODS);
    const feeBase = Math.round(amount * m.rate);
    const tax = Math.round(feeBase * GST_RATE);
    const fee = feeBase + tax;
    const withReceipt = opts2.receipt ?? true;

    ledger.push({ invoice_id: invoiceId, customer_name: name, amount: rupees(amount), invoice_date: dateOf(day), payment_ref: '' });
    const item: ReconItem = {
      entity_id: id('pay_'),
      type: 'payment',
      debit: 0,
      credit: amount - fee,
      amount,
      currency: 'INR',
      fee,
      tax,
      on_hold: false,
      settled: opts2.settled ?? true,
      created_at: ts(day, rng.int(9, 21), rng.int(0, 59)),
      settled_at: null,
      settlement_id: null,
      posted_at: null,
      credit_type: 'default',
      description: withReceipt ? `Invoice ${invoiceId}` : 'Payment link',
      notes: withReceipt ? { invoice: invoiceId } : { customer: name.toUpperCase() },
      payment_id: null,
      settlement_utr: null,
      order_id: id('order_'),
      order_receipt: withReceipt ? invoiceId : null,
      method: m.method,
      card_network: 'network' in m ? m.network : null,
      card_issuer: m.method === 'card' ? rng.pick(['HDFC', 'ICIC', 'SBIN', 'UTIB']) : null,
      card_type: 'type' in m ? m.type : null,
      dispute_id: null,
    };
    items.push(item);
    truth.push({
      ledger_invoice_id: invoiceId,
      expected_bank_txn_id: null,
      expected_gateway_entity_id: item.entity_id,
      case_type: withReceipt ? 'razorpay_receipt' : 'razorpay_no_receipt',
    });
    return item;
  }

  /** Close a settlement: stamp its lines and (optionally) add the bank credit. */
  function settle(
    lines: ReconItem[],
    day: number,
    outcome: { kind: 'matched' } | { kind: 'mismatch'; shortBy: number } | { kind: 'missing' },
    description: string,
  ) {
    const settlementId = id('setl_');
    const utr = `UTIBR5${dateOf(day).replace(/-/g, '')}${String(rng.int(100000, 999999))}`;
    for (const line of lines) {
      line.settlement_id = settlementId;
      line.settlement_utr = utr;
      line.settled_at = ts(day, 10, 0);
    }
    const net = lines.reduce((sum, l) => sum + l.credit - l.debit, 0);

    let bankTxnId: string | null = null;
    if (outcome.kind !== 'missing') {
      bankTxnId = opts.nextTxnId();
      bank.push({
        txn_id: bankTxnId,
        utr_ref: utr,
        amount: rupees(net - (outcome.kind === 'mismatch' ? outcome.shortBy : 0)),
        txn_date: dateOf(day),
        payer_name: 'RAZORPAY SOFTWARE PVT LTD',
        status: 'settled',
      });
    }
    settlementTruth.push({
      settlement_id: settlementId,
      settlement_utr: utr,
      expected_status: outcome.kind,
      expected_bank_txn_id: bankTxnId,
      expected_amount: rupees(net),
      description,
    });
  }

  // ── S1: clean ──────────────────────────────────────────────────────
  const s1 = [payment(3), payment(3), payment(4), payment(4, { receipt: false })];
  settle(s1, 6, { kind: 'matched' }, 'Clean settlement');

  // ── S2: refund of an S1 payment deducted from the payout ───────────
  const s2 = [payment(10), payment(10), payment(11), payment(11)];
  const refunded = s1[1];
  const refundAmount = Math.round(refunded.amount / 2);
  const refund: ReconItem = {
    ...refunded,
    entity_id: id('rfnd_'),
    type: 'refund',
    debit: refundAmount,
    credit: 0,
    amount: refundAmount,
    fee: 0,
    tax: 0,
    created_at: ts(12, 15, 20),
    description: 'Partial refund',
    notes: null,
    payment_id: refunded.entity_id,
    method: null,
    card_network: null,
    card_issuer: null,
    card_type: null,
  };
  items.push(refund);
  s2.push(refund);
  settle(s2, 13, { kind: 'matched' }, `Includes a refund of ₹${rupees(refundAmount)} for ${refunded.entity_id}`);

  // ── S3: bank received less than the report says ────────────────────
  const s3 = [payment(17), payment(17, { receipt: false }), payment(18)];
  settle(s3, 20, { kind: 'mismatch', shortBy: 118_000 }, 'Bank credit ₹1,180.00 short of the report (unexplained adjustment)');

  // ── S4: settled per Razorpay, not on the bank statement yet ────────
  const s4 = [payment(24), payment(25)];
  settle(s4, 27, { kind: 'missing' }, 'Settlement UTR not found on the bank statement');

  // ── Captured, not yet settled ──────────────────────────────────────
  payment(30, { settled: false });

  // ── Invoice marked as paid online, but no Razorpay payment exists ──
  const missingInvoice = opts.nextInvoiceId();
  ledger.push({
    invoice_id: missingInvoice,
    customer_name: CUSTOMERS[customer++ % CUSTOMERS.length],
    amount: rupees(rng.int(999, 49_999) * 100),
    invoice_date: dateOf(21),
    payment_ref: '',
  });
  truth.push({
    ledger_invoice_id: missingInvoice,
    expected_bank_txn_id: null,
    expected_gateway_entity_id: null,
    case_type: 'razorpay_missing_payment',
  });

  items.sort((a, b) => a.created_at - b.created_at);
  return {
    ledger,
    bank,
    recon: { entity: 'collection' as const, count: items.length, items },
    truth,
    settlementTruth,
  };
}
