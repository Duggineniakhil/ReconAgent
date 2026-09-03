#!/usr/bin/env tsx
/**
 * scripts/test_tools.ts
 *
 * Standalone test script that:
 *   1. Ingests CSV data into the DB
 *   2. Runs each investigation tool against 5 known ground-truth records
 *      (one per interesting case type)
 *   3. Prints results so you can manually verify against the answer key
 *
 * Usage: npm run test-tools
 */

import fs from 'fs';
import path from 'path';
import { testConnection, closePool, query } from '../src/db';
import { ingestData } from '../src/services/ingest';
import {
  findExactCandidates,
  findFuzzyCandidates,
  compareNames,
  checkDuplicateRef,
} from '../src/tools';

// ── Types ─────────────────────────────────────────────────────────────

interface GroundTruthEntry {
  ledger_invoice_id: string;
  expected_bank_txn_id: string | null;
  case_type: string;
}

interface LedgerRow {
  id: number;
  invoice_id: string;
  customer_name: string;
  amount: number;
  invoice_date: string;
  payment_ref: string;
}

// ── Helpers ───────────────────────────────────────────────────────────

function hr(label: string): void {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  ${label}`);
  console.log('═'.repeat(70));
}

function sub(label: string): void {
  console.log(`\n  ── ${label} ${'─'.repeat(Math.max(0, 58 - label.length))}`);
}

// ── Main ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║           ReconAgent — Investigation Tools Test Suite               ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝\n');

  // 1. Connect
  const ok = await testConnection();
  if (!ok) { console.error('DB connection failed'); process.exit(1); }

  // 2. Ingest CSV data into DB
  console.log('\n[Ingest] Loading CSV data into database...');
  const counts = await ingestData();
  console.log(`[Ingest] ✔ ${counts.ledgerCount} ledger records, ${counts.bankCount} bank transactions loaded.\n`);

  // 3. Load ground truth
  const gtPath = path.resolve(__dirname, '..', 'data', 'ground_truth.json');
  const groundTruth: GroundTruthEntry[] = JSON.parse(fs.readFileSync(gtPath, 'utf-8'));

  // 4. Pick 5 test records — one from each interesting case type
  const testCases: { invoiceId: string; caseType: string; expectedTxn: string | null }[] = [
    // clean_exact  → should find exact match
    { invoiceId: 'INV-2026-0001', caseType: 'clean_exact',     expectedTxn: 'TXN-00001' },
    // rounding_diff → exact should miss (amount differs), fuzzy should find it
    { invoiceId: 'INV-2026-0043', caseType: 'rounding_diff',   expectedTxn: 'TXN-00043' },
    // date_drift → exact should hit (same ref+amount), date differs
    { invoiceId: 'INV-2026-0050', caseType: 'date_drift',      expectedTxn: 'TXN-00050' },
    // name_variant → exact should hit, but name mismatch is visible
    { invoiceId: 'INV-2026-0057', caseType: 'name_variant',    expectedTxn: 'TXN-00057' },
    // duplicate_ref → should find 2 bank txns with the same ref
    { invoiceId: 'INV-2026-0068', caseType: 'duplicate_ref',   expectedTxn: null },
  ];

  for (const tc of testCases) {
    // Fetch the ledger row from DB
    const ledgerResult = await query<LedgerRow>(
      `SELECT id, invoice_id, customer_name, amount::float AS amount,
              invoice_date::text AS invoice_date, payment_ref
       FROM   ledger_records
       WHERE  invoice_id = $1`,
      [tc.invoiceId],
    );
    const ledger = ledgerResult.rows[0];
    if (!ledger) {
      console.error(`  ✗ Ledger record ${tc.invoiceId} not found in DB!`);
      continue;
    }

    hr(`TEST: ${tc.invoiceId}  [${tc.caseType}]`);
    console.log(`  Expected match: ${tc.expectedTxn ?? 'NULL (exception)'}`);
    console.log(`  Ledger:  ${ledger.customer_name}  ₹${ledger.amount}  ${ledger.invoice_date}  ref=${ledger.payment_ref}`);

    // ── Tool 1: find_exact_candidates ────────────────────────────────
    sub('find_exact_candidates(ref, amount)');
    const exact = await findExactCandidates(ledger.payment_ref, ledger.amount);
    if (exact.length === 0) {
      console.log('  Result: No exact match found.');
    } else {
      for (const c of exact) {
        console.log(`  Result: ${c.txn_id}  ₹${c.amount}  ${c.txn_date}  payer=${c.payer_name}  ref=${c.utr_ref}`);
      }
    }
    const exactHit = exact.find(c => c.txn_id === tc.expectedTxn);
    if (tc.expectedTxn && tc.caseType !== 'rounding_diff') {
      console.log(`  Verdict: ${exactHit ? '✔ CORRECT — expected txn found' : '⚠ expected txn NOT in results'}`);
    } else if (tc.caseType === 'rounding_diff') {
      console.log(`  Verdict: ${exact.length === 0 ? '✔ CORRECT — exact miss expected (amount differs by ₹1-5)' : '⚠ unexpected exact hit'}`);
    }

    // ── Tool 2: find_fuzzy_candidates ────────────────────────────────
    sub('find_fuzzy_candidates(amount, date)');
    const fuzzy = await findFuzzyCandidates(ledger.amount, ledger.invoice_date, ledger.customer_name);
    if (fuzzy.length === 0) {
      console.log('  Result: No fuzzy candidates found.');
    } else {
      for (const c of fuzzy) {
        const amtDiff = (Number(c.amount_diff)).toFixed(2);
        const dateDiff = c.date_diff_days;
        console.log(`  Result: ${c.txn_id}  ₹${c.amount}  ${c.txn_date}  payer=${c.payer_name}  amt_diff=₹${amtDiff}  date_diff=${dateDiff}d`);
      }
    }
    const fuzzyHit = fuzzy.find(c => c.txn_id === tc.expectedTxn);
    if (tc.expectedTxn) {
      console.log(`  Verdict: ${fuzzyHit ? '✔ CORRECT — expected txn found in fuzzy results' : '⚠ expected txn NOT in fuzzy results'}`);
    }

    // ── Tool 3: compare_names ────────────────────────────────────────
    // Compare ledger customer_name vs the top fuzzy/exact candidate's payer_name
    const bestCandidate = exact[0] ?? fuzzy[0];
    if (bestCandidate) {
      sub(`compare_names("${ledger.customer_name}", "${bestCandidate.payer_name}")`);
      const nameResult = compareNames(ledger.customer_name, bestCandidate.payer_name);
      console.log(`  Result: similarity = ${nameResult.similarity}`);
      if (tc.caseType === 'name_variant') {
        console.log(`  Verdict: ${nameResult.similarity < 1.0 ? '✔ CORRECT — names differ as expected (score < 1.0)' : '⚠ names unexpectedly identical'}`);
      } else {
        console.log(`  Verdict: ${nameResult.similarity === 1.0 ? '✔ Names match perfectly' : `⚠ Similarity ${nameResult.similarity} (not 1.0)`}`);
      }
    }

    // ── Tool 4: check_duplicate_ref ──────────────────────────────────
    sub(`check_duplicate_ref("${ledger.payment_ref}")`);
    const dupResult = await checkDuplicateRef(ledger.payment_ref);
    console.log(`  Result: is_duplicate=${dupResult.is_duplicate}  count=${dupResult.count}  txn_ids=[${dupResult.txn_ids.join(', ')}]`);
    if (tc.caseType === 'duplicate_ref') {
      console.log(`  Verdict: ${dupResult.is_duplicate ? '✔ CORRECT — duplicate detected, agent should flag exception' : '⚠ expected duplicate NOT detected'}`);
    } else {
      console.log(`  Verdict: ${!dupResult.is_duplicate ? '✔ CORRECT — no duplicate (single ref)' : '⚠ unexpected duplicate found'}`);
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────
  hr('SUMMARY');
  console.log(`
  Tests ran against 5 records covering these case types:
    1. clean_exact     — exact match found, names match, no duplicate
    2. rounding_diff   — exact miss (₹1-5 off), fuzzy finds it
    3. date_drift      — exact hits (same ref+amount), date shifted
    4. name_variant    — exact hits (same ref+amount), name similarity < 1
    5. duplicate_ref   — duplicate ref detected, should be flagged

  Compare the txn_ids and verdicts above against data/ground_truth.json.
`);

  await closePool();
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
