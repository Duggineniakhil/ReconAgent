#!/usr/bin/env tsx
/**
 * scripts/generate_data.ts
 *
 * Synthetic data generator for ReconAgent.
 * Produces:
 *   - data/ledger_records.csv   (70 rows)
 *   - data/bank_transactions.csv (~75 rows)
 *   - data/ground_truth.json    (answer key for every ledger record)
 *
 * Case-type mix (from spec section 4):
 *   clean_exact      42  (60%)  — identical ref, amount, date
 *   rounding_diff     7  (10%)  — amount off by ₹1-5, same ref/date
 *   date_drift        7  (10%)  — settles 1-3 days later, same ref/amount
 *   name_variant      4   (6%)  — payer name abbreviated/transliterated
 *   split_payment     3   (4%)  — one invoice → two bank txns (exception)
 *   missing_bank_txn  4   (6%)  — no bank txn at all (exception)
 *   duplicate_ref     3   (4%)  — same ref on two unrelated bank txns (exception)
 *
 * Uses a fixed seed (42) via Mulberry32 PRNG for full reproducibility.
 */

import fs from 'fs';
import path from 'path';

// ═══════════════════════════════════════════════════════════════════════
//  SEEDED PRNG — Mulberry32
// ═══════════════════════════════════════════════════════════════════════
const SEED = 42;

class SeededRng {
  private state: number;

  constructor(seed: number) {
    this.state = seed;
  }

  /** Returns float in [0, 1) — deterministic */
  next(): number {
    this.state |= 0;
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [min, max] inclusive */
  int(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  /** Float in [min, max) */
  float(min: number, max: number): number {
    return this.next() * (max - min) + min;
  }

  /** Pick one random element from array */
  pick<T>(arr: readonly T[]): T {
    return arr[this.int(0, arr.length - 1)];
  }

  /** Fisher-Yates shuffle — returns new array */
  shuffle<T>(arr: readonly T[]): T[] {
    const copy = [...arr];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }
}

const rng = new SeededRng(SEED);

// ═══════════════════════════════════════════════════════════════════════
//  DATA POOLS — Realistic Indian merchant / customer data
// ═══════════════════════════════════════════════════════════════════════

const CUSTOMER_NAMES: readonly string[] = [
  'Rajesh Kumar Enterprises',
  'Sharma Electronics Pvt Ltd',
  'Gupta Steel Works',
  'Patel Fabrics & Textiles',
  'Singh Auto Components',
  'Mehta Pharmaceuticals',
  'Joshi Construction Co',
  'Agarwal Sweets & Namkeen',
  'Verma Transport Services',
  'Reddy Agro Industries',
  'Nair Spices Export',
  'Iyer Silk Emporium',
  'Bhatia Hardware Store',
  'Desai Chemicals Ltd',
  'Malhotra Furniture House',
  'Kapoor Garments',
  'Chopra Medical Supplies',
  'Tiwari Oil Mills',
  'Saxena IT Solutions',
  'Pandey Book Depot',
  'Sundaram Motors',
  'Krishnamurthy Jewellers',
  'Balakrishnan Traders',
  'Rajan Marine Exports',
  'Pillai Coir Industries',
  'Das Paper Mills',
  'Banerjee Tea Estate',
  'Mukherjee Engineering Works',
  'Chatterjee Electricals',
  'Bose Scientific Instruments',
  'Roy Cement Distributors',
  'Sinha Dairy Farm',
  'Mishra Fertilizers',
  'Dubey Logistics Pvt Ltd',
  'Yadav Agri Equipments',
  'Rawat Cold Storage',
  'Thakur Rice Mills',
  'Chauhan Plywood Industries',
  'Trivedi Optical House',
  'Bhatt Packaging Solutions',
  'Kulkarni Machine Tools',
  'Deshpande Polymers',
  'Patil Sugar Factory',
  'Shinde Construction Materials',
  'Jadhav Auto Spares',
  'Naik Fisheries',
  'Shetty Cashew Industries',
  'Hegde Plantation Co',
  'Gowda Coffee Estate',
  'Rao Granite Exports',
  'Sethi Wine & Spirits',
  'Dhawan Electronics Mart',
  'Luthra Leather Works',
  'Bajaj Cycle Components',
  'Mahajan Paper Trading',
  'Grover Bakery Products',
  'Tandon Steel Tubes',
  'Sabharwal Imports',
  'Anand Dairy Products',
  'Menon Rubbers Ltd',
  'Nambiar Ayurvedic Pharmacy',
  'Kurien Frozen Foods',
  'George Timber Merchants',
  'Thomas Rubber Estate',
  'Fernandes Seafood Exports',
  'D\'Souza Bakery Chain',
  'Siddiqui Leather Exports',
  'Khan Textile Mills',
  'Ansari Handicrafts',
  'Shaikh Hardware Trading',
  'Choudhary Marble Industries',
  'Rathore Sand & Gravel',
  'Shekhawat Transport Corp',
  'Meena Handicraft Emporium',
  'Tak Surgical Instruments',
  'Oberoi Hotels Supply',
  'Wadia Group Trading',
  'Birla Textiles Outlet',
  'Godrej Appliances Dealer',
  'Tata Components Dist',
] as const;

/** Name-variant pairs: [ledger name, bank payer name] */
const NAME_VARIANT_PAIRS: [string, string][] = [
  ['Rajesh Kumar Enterprises',    'R. K. Enterprises'],
  ['Krishnamurthy Jewellers',     'K. Murthy Jewellers'],
  ['Siddiqui Leather Exports',    'Md. Siddiqui Leather Exp'],
  ['Balakrishnan Traders',        'Bala Krishnan Traders'],
];

const BANK_IFSC_PREFIXES = [
  'UTIB', 'HDFC', 'ICIC', 'SBIN', 'BARB',
  'PUNB', 'CNRB', 'IOBA', 'KKBK', 'YESB',
] as const;

// ═══════════════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════════════

let invoiceSeq = 0;
let txnSeq = 0;
let refSeq = 1000;

function nextInvoiceId(): string {
  invoiceSeq++;
  return `INV-2026-${String(invoiceSeq).padStart(4, '0')}`;
}

function nextTxnId(): string {
  txnSeq++;
  return `TXN-${String(txnSeq).padStart(5, '0')}`;
}

function generateUtrRef(): string {
  refSeq++;
  const prefix = rng.pick(BANK_IFSC_PREFIXES);
  return `${prefix}${String(refSeq).padStart(12, '0')}`;
}

function generateUpiRef(): string {
  refSeq++;
  const mid = rng.int(100000000, 999999999);
  return `UPI/${mid}/${String(refSeq).padStart(6, '0')}`;
}

function generatePaymentRef(): string {
  return rng.next() > 0.45 ? generateUtrRef() : generateUpiRef();
}

/** Base date: 2026-08-01. Window: 30 days. */
function generateDate(): Date {
  const base = new Date('2026-08-01T00:00:00Z');
  base.setUTCDate(base.getUTCDate() + rng.int(0, 29));
  return base;
}

function formatDate(d: Date): string {
  return d.toISOString().split('T')[0]; // YYYY-MM-DD
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + n);
  return r;
}

/** Realistic INR amount: ₹1,500 – ₹5,00,000 with tier distribution */
function generateAmount(): number {
  const tier = rng.next();
  let amt: number;
  if (tier < 0.35) {
    amt = rng.float(1500, 15000);       // small
  } else if (tier < 0.65) {
    amt = rng.float(15000, 75000);      // medium
  } else if (tier < 0.88) {
    amt = rng.float(75000, 200000);     // large
  } else {
    amt = rng.float(200000, 500000);    // very large
  }
  return Math.round(amt * 100) / 100;
}

// Rotating name picker (shuffled once for variety)
const shuffledNames = rng.shuffle(CUSTOMER_NAMES);
let nameIdx = 0;
function nextName(): string {
  const n = shuffledNames[nameIdx % shuffledNames.length];
  nameIdx++;
  return n;
}

// ═══════════════════════════════════════════════════════════════════════
//  TYPES
// ═══════════════════════════════════════════════════════════════════════

interface LedgerRecord {
  invoice_id: string;
  customer_name: string;
  amount: number;
  invoice_date: string;
  payment_ref: string;
  _case_type: string; // internal, not written to CSV
}

interface BankTransaction {
  txn_id: string;
  utr_ref: string;
  amount: number;
  txn_date: string;
  payer_name: string;
  status: string;
}

interface GroundTruthEntry {
  ledger_invoice_id: string;
  expected_bank_txn_id: string | null;
  case_type: string;
}

// ═══════════════════════════════════════════════════════════════════════
//  GENERATE ALL RECORDS
// ═══════════════════════════════════════════════════════════════════════

const ledger: LedgerRecord[] = [];
const bank: BankTransaction[] = [];
const truth: GroundTruthEntry[] = [];

// ── 1. clean_exact  (42 records) ─────────────────────────────────────
for (let i = 0; i < 42; i++) {
  const invId = nextInvoiceId();
  const name  = nextName();
  const amt   = generateAmount();
  const date  = generateDate();
  const ref   = generatePaymentRef();
  const txnId = nextTxnId();

  ledger.push({
    invoice_id: invId, customer_name: name, amount: amt,
    invoice_date: formatDate(date), payment_ref: ref, _case_type: 'clean_exact',
  });
  bank.push({
    txn_id: txnId, utr_ref: ref, amount: amt,
    txn_date: formatDate(date), payer_name: name, status: 'settled',
  });
  truth.push({ ledger_invoice_id: invId, expected_bank_txn_id: txnId, case_type: 'clean_exact' });
}

// ── 2. rounding_diff  (7 records) ────────────────────────────────────
for (let i = 0; i < 7; i++) {
  const invId = nextInvoiceId();
  const name  = nextName();
  const amt   = generateAmount();
  const date  = generateDate();
  const ref   = generatePaymentRef();
  const txnId = nextTxnId();

  const diff     = rng.int(1, 5) * (rng.next() > 0.5 ? 1 : -1);
  const bankAmt  = Math.round((amt + diff) * 100) / 100;

  ledger.push({
    invoice_id: invId, customer_name: name, amount: amt,
    invoice_date: formatDate(date), payment_ref: ref, _case_type: 'rounding_diff',
  });
  bank.push({
    txn_id: txnId, utr_ref: ref, amount: bankAmt,
    txn_date: formatDate(date), payer_name: name, status: 'settled',
  });
  truth.push({ ledger_invoice_id: invId, expected_bank_txn_id: txnId, case_type: 'rounding_diff' });
}

// ── 3. date_drift  (7 records) ───────────────────────────────────────
for (let i = 0; i < 7; i++) {
  const invId = nextInvoiceId();
  const name  = nextName();
  const amt   = generateAmount();
  const invDate = generateDate();
  const ref   = generatePaymentRef();
  const txnId = nextTxnId();

  const drift   = rng.int(1, 3);
  const bankDate = addDays(invDate, drift);

  ledger.push({
    invoice_id: invId, customer_name: name, amount: amt,
    invoice_date: formatDate(invDate), payment_ref: ref, _case_type: 'date_drift',
  });
  bank.push({
    txn_id: txnId, utr_ref: ref, amount: amt,
    txn_date: formatDate(bankDate), payer_name: name, status: 'settled',
  });
  truth.push({ ledger_invoice_id: invId, expected_bank_txn_id: txnId, case_type: 'date_drift' });
}

// ── 4. name_variant  (4 records) ─────────────────────────────────────
for (let i = 0; i < 4; i++) {
  const invId = nextInvoiceId();
  const [ledgerName, bankName] = NAME_VARIANT_PAIRS[i];
  const amt   = generateAmount();
  const date  = generateDate();
  const ref   = generatePaymentRef();
  const txnId = nextTxnId();

  ledger.push({
    invoice_id: invId, customer_name: ledgerName, amount: amt,
    invoice_date: formatDate(date), payment_ref: ref, _case_type: 'name_variant',
  });
  bank.push({
    txn_id: txnId, utr_ref: ref, amount: amt,
    txn_date: formatDate(date), payer_name: bankName, status: 'settled',
  });
  truth.push({ ledger_invoice_id: invId, expected_bank_txn_id: txnId, case_type: 'name_variant' });
}

// ── 5. split_payment  (3 records → 6 bank txns) ─────────────────────
for (let i = 0; i < 3; i++) {
  const invId = nextInvoiceId();
  const name  = nextName();
  const total = generateAmount();
  const date  = generateDate();
  const ref   = generatePaymentRef();

  // Split into two parts (30–70% ratio)
  const ratio = rng.float(0.3, 0.7);
  const part1 = Math.round(total * ratio * 100) / 100;
  const part2 = Math.round((total - part1) * 100) / 100;

  const txnId1 = nextTxnId();
  const txnId2 = nextTxnId();

  ledger.push({
    invoice_id: invId, customer_name: name, amount: total,
    invoice_date: formatDate(date), payment_ref: ref, _case_type: 'split_payment',
  });

  bank.push({
    txn_id: txnId1, utr_ref: `${ref}-PART1`, amount: part1,
    txn_date: formatDate(date), payer_name: name, status: 'settled',
  });
  bank.push({
    txn_id: txnId2, utr_ref: `${ref}-PART2`, amount: part2,
    txn_date: formatDate(addDays(date, rng.int(0, 1))),
    payer_name: name, status: 'settled',
  });

  // Exception — agent should NOT auto-match split payments
  truth.push({ ledger_invoice_id: invId, expected_bank_txn_id: null, case_type: 'split_payment' });
}

// ── 6. missing_bank_txn  (4 records → 0 bank txns) ──────────────────
for (let i = 0; i < 4; i++) {
  const invId = nextInvoiceId();
  const name  = nextName();
  const amt   = generateAmount();
  const date  = generateDate();
  const ref   = generatePaymentRef();

  ledger.push({
    invoice_id: invId, customer_name: name, amount: amt,
    invoice_date: formatDate(date), payment_ref: ref, _case_type: 'missing_bank_txn',
  });
  // No bank transaction!
  truth.push({ ledger_invoice_id: invId, expected_bank_txn_id: null, case_type: 'missing_bank_txn' });
}

// ── 7. duplicate_ref  (3 records → 6 bank txns) ─────────────────────
for (let i = 0; i < 3; i++) {
  const invId = nextInvoiceId();
  const name  = nextName();
  const amt   = generateAmount();
  const date  = generateDate();
  const ref   = generatePaymentRef();

  const txnId1 = nextTxnId();  // "real" transaction
  const txnId2 = nextTxnId();  // unrelated duplicate ref

  ledger.push({
    invoice_id: invId, customer_name: name, amount: amt,
    invoice_date: formatDate(date), payment_ref: ref, _case_type: 'duplicate_ref',
  });

  // Real matching bank txn
  bank.push({
    txn_id: txnId1, utr_ref: ref, amount: amt,
    txn_date: formatDate(date), payer_name: name, status: 'settled',
  });

  // Unrelated txn reusing the SAME reference — fraud-adjacent
  bank.push({
    txn_id: txnId2, utr_ref: ref, amount: generateAmount(),
    txn_date: formatDate(addDays(date, rng.int(-2, 2))),
    payer_name: nextName(), status: 'settled',
  });

  // Exception — agent must flag duplicate refs, not auto-match
  truth.push({ ledger_invoice_id: invId, expected_bank_txn_id: null, case_type: 'duplicate_ref' });
}

// ── 8. Orphan bank txns  (3 extras to reach ~75) ─────────────────────
for (let i = 0; i < 3; i++) {
  bank.push({
    txn_id: nextTxnId(),
    utr_ref: generatePaymentRef(),
    amount: generateAmount(),
    txn_date: formatDate(generateDate()),
    payer_name: nextName(),
    status: rng.pick(['settled', 'pending', 'reversed']),
  });
}

// ═══════════════════════════════════════════════════════════════════════
//  CSV HELPERS
// ═══════════════════════════════════════════════════════════════════════

/** Escape a CSV field: quote if it contains comma, quote, or newline */
function csvField(val: string | number): string {
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function ledgerToCsvRow(r: LedgerRecord): string {
  return [
    csvField(r.invoice_id),
    csvField(r.customer_name),
    csvField(r.amount),
    csvField(r.invoice_date),
    csvField(r.payment_ref),
  ].join(',');
}

function bankToCsvRow(r: BankTransaction): string {
  return [
    csvField(r.txn_id),
    csvField(r.utr_ref),
    csvField(r.amount),
    csvField(r.txn_date),
    csvField(r.payer_name),
    csvField(r.status),
  ].join(',');
}

// ═══════════════════════════════════════════════════════════════════════
//  WRITE OUTPUT FILES
// ═══════════════════════════════════════════════════════════════════════

const dataDir = path.resolve(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

// Shuffle ledger and bank arrays so case types aren't in contiguous blocks
// (more realistic — the agent shouldn't rely on ordering)
const shuffledLedger = rng.shuffle(ledger);
const shuffledBank   = rng.shuffle(bank);

// ── ledger_records.csv ────────────────────────────────────────────────
const ledgerCsv = [
  'invoice_id,customer_name,amount,invoice_date,payment_ref',
  ...shuffledLedger.map(ledgerToCsvRow),
].join('\n');

fs.writeFileSync(path.join(dataDir, 'ledger_records.csv'), ledgerCsv + '\n', 'utf-8');

// ── bank_transactions.csv ─────────────────────────────────────────────
const bankCsv = [
  'txn_id,utr_ref,amount,txn_date,payer_name,status',
  ...shuffledBank.map(bankToCsvRow),
].join('\n');

fs.writeFileSync(path.join(dataDir, 'bank_transactions.csv'), bankCsv + '\n', 'utf-8');

// ── ground_truth.json ─────────────────────────────────────────────────
fs.writeFileSync(
  path.join(dataDir, 'ground_truth.json'),
  JSON.stringify(truth, null, 2) + '\n',
  'utf-8',
);

// ═══════════════════════════════════════════════════════════════════════
//  CONSOLE REPORT
// ═══════════════════════════════════════════════════════════════════════

console.log('═══════════════════════════════════════════════════════════════');
console.log('  ReconAgent — Synthetic Data Generator');
console.log('═══════════════════════════════════════════════════════════════\n');

console.log(`  Ledger records written:       ${shuffledLedger.length}`);
console.log(`  Bank transactions written:    ${shuffledBank.length}`);
console.log(`  Ground truth entries:         ${truth.length}`);
console.log(`  Output directory:             ${dataDir}\n`);

// ── Case-type breakdown ───────────────────────────────────────────────
const caseTypes = [
  'clean_exact', 'rounding_diff', 'date_drift', 'name_variant',
  'split_payment', 'missing_bank_txn', 'duplicate_ref',
] as const;

console.log('  Case-type breakdown:');
for (const ct of caseTypes) {
  const count = truth.filter(t => t.case_type === ct).length;
  const pct   = ((count / truth.length) * 100).toFixed(0);
  console.log(`    ${ct.padEnd(20)} ${String(count).padStart(3)}  (${pct}%)`);
}

// ── Sample rows per case type ─────────────────────────────────────────
console.log('\n');

for (const ct of caseTypes) {
  const ctLedger = ledger.filter(l => l._case_type === ct);
  const ctTruth  = truth.filter(t => t.case_type === ct);
  const sample   = ctLedger.slice(0, 10); // up to 10

  console.log(`╔══════════════════════════════════════════════════════════════`);
  console.log(`║  ${ct.toUpperCase()}  (${ctLedger.length} ledger records)`);
  console.log(`╠══════════════════════════════════════════════════════════════`);

  for (const rec of sample) {
    const gt = ctTruth.find(t => t.ledger_invoice_id === rec.invoice_id)!;
    const matchingBank = gt.expected_bank_txn_id
      ? bank.find(b => b.txn_id === gt.expected_bank_txn_id)
      : null;

    console.log(`║`);
    console.log(`║  LEDGER: ${rec.invoice_id}`);
    console.log(`║    Customer:    ${rec.customer_name}`);
    console.log(`║    Amount:      ₹${rec.amount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`);
    console.log(`║    Date:        ${rec.invoice_date}`);
    console.log(`║    Payment Ref: ${rec.payment_ref}`);

    if (matchingBank) {
      console.log(`║  BANK MATCH: ${matchingBank.txn_id}`);
      console.log(`║    Payer:       ${matchingBank.payer_name}`);
      console.log(`║    Amount:      ₹${matchingBank.amount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`);
      console.log(`║    Date:        ${matchingBank.txn_date}`);
      console.log(`║    UTR Ref:     ${matchingBank.utr_ref}`);

      // Highlight the difference for rounding_diff / date_drift / name_variant
      if (ct === 'rounding_diff') {
        const diff = matchingBank.amount - rec.amount;
        console.log(`║    ▸ DIFF:      ₹${diff > 0 ? '+' : ''}${diff.toFixed(2)}`);
      } else if (ct === 'date_drift') {
        const d1 = new Date(rec.invoice_date);
        const d2 = new Date(matchingBank.txn_date);
        const days = Math.round((d2.getTime() - d1.getTime()) / 86400000);
        console.log(`║    ▸ DRIFT:     +${days} day(s)`);
      } else if (ct === 'name_variant') {
        console.log(`║    ▸ NAME DIFF: "${rec.customer_name}" ≠ "${matchingBank.payer_name}"`);
      }
    } else if (ct === 'split_payment') {
      // Find the two partial bank txns by reference pattern
      const partials = bank.filter(b => b.utr_ref.startsWith(rec.payment_ref + '-PART'));
      console.log(`║  BANK SPLITS:`);
      for (const p of partials) {
        console.log(`║    ${p.txn_id}  ₹${p.amount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}  (${p.utr_ref.split('-').pop()})  ${p.txn_date}`);
      }
      const partialSum = partials.reduce((s, p) => s + p.amount, 0);
      console.log(`║    ▸ SUM:      ₹${partialSum.toLocaleString('en-IN', { minimumFractionDigits: 2 })}  (invoice: ₹${rec.amount.toLocaleString('en-IN', { minimumFractionDigits: 2 })})`);
    } else if (ct === 'missing_bank_txn') {
      console.log(`║  BANK MATCH: ✗ NONE — true exception`);
    } else if (ct === 'duplicate_ref') {
      const dupes = bank.filter(b => b.utr_ref === rec.payment_ref);
      console.log(`║  DUPLICATE REF BANK TXNS (${dupes.length} with same ref):`);
      for (const d of dupes) {
        console.log(`║    ${d.txn_id}  ₹${d.amount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}  ${d.payer_name}  ${d.txn_date}`);
      }
    }
  }

  console.log(`║`);
  console.log(`╚══════════════════════════════════════════════════════════════\n`);
}

console.log('✓ Data generation complete.\n');
console.log('  Files:');
console.log(`    ${path.join(dataDir, 'ledger_records.csv')}`);
console.log(`    ${path.join(dataDir, 'bank_transactions.csv')}`);
console.log(`    ${path.join(dataDir, 'ground_truth.json')}`);
console.log('');
