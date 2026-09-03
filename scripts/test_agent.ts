#!/usr/bin/env tsx
/**
 * scripts/test_agent.ts
 *
 * Runs the agent loop on 5 specific ledger records (one per case type)
 * and prints the full tool-call trace + final decision for each.
 *
 * Usage:  npm run test-agent
 *
 * Requires GEMINI_API_KEY in .env
 */

// Suppress noisy DB query logs
process.env.NODE_ENV = 'production';

import fs from 'fs';
import path from 'path';
import { testConnection, closePool, query } from '../src/db';
import { runMigration } from '../src/db/migration';
import { ingestData } from '../src/services/ingest';
import { reconcileRecord } from '../src/agent';
import type { ReconciliationResult, ToolCallTrace } from '../src/agent';

// ── Types ─────────────────────────────────────────────────────────────

interface GroundTruthEntry {
  ledger_invoice_id: string;
  expected_bank_txn_id: string | null;
  case_type: string;
}

// ── Formatting helpers ────────────────────────────────────────────────

function hr(ch: string, len: number): string {
  return ch.repeat(len);
}

function printTrace(trace: ToolCallTrace[]): void {
  for (const t of trace) {
    const turnLabel = t.turn === 0 ? 'PRECHECK' : `TURN ${t.turn}`;
    console.log(`    ┌─ [${turnLabel}] ${t.tool_name}`);
    console.log(`    │  Input:  ${JSON.stringify(t.tool_input, null, 2).split('\n').join('\n    │          ')}`);

    const resultStr = JSON.stringify(t.tool_result, null, 2);
    // Truncate very long results
    const lines = resultStr.split('\n');
    if (lines.length > 12) {
      console.log(`    │  Result: ${lines.slice(0, 10).join('\n    │          ')}`);
      console.log(`    │          ... (${lines.length - 10} more lines)`);
    } else {
      console.log(`    │  Result: ${lines.join('\n    │          ')}`);
    }
    console.log(`    └${'─'.repeat(60)}`);
  }
}

function printResult(
  result: ReconciliationResult,
  gt: GroundTruthEntry,
): void {
  console.log(`\n    DECISION: ${result.outcome.toUpperCase()}`);

  if (result.outcome === 'matched') {
    console.log(`      Method:      ${result.method}`);
    console.log(`      Confidence:  ${result.confidence}`);
    console.log(`      Bank Txn:    ${result.matched_bank_txn_id}`);
    console.log(`      Reasoning:   ${result.reasoning}`);
  } else if (result.outcome === 'exception') {
    console.log(`      Reason:      ${result.exception_reason}`);
    console.log(`      Best Cand.:  ${result.best_candidate_id ?? 'none'}`);
    console.log(`      Reasoning:   ${result.reasoning}`);
  } else {
    console.log(`      Reasoning:   ${result.reasoning}`);
  }

  console.log(`      Turns:       ${result.turns}${result.precheck ? ' (precheck — no LLM)' : ''}`);

  // Verify against ground truth
  console.log(`\n    GROUND TRUTH CHECK:`);
  console.log(`      Expected:    ${gt.expected_bank_txn_id ?? 'NULL (exception)'}`);
  console.log(`      Case type:   ${gt.case_type}`);

  if (gt.expected_bank_txn_id === null) {
    // Should be an exception
    const correct = result.outcome === 'exception' || result.outcome === 'timeout';
    console.log(`      Verdict:     ${correct ? '✔ CORRECT — flagged as exception' : '✗ WRONG — should have been an exception'}`);
  } else {
    // Should be a match
    const correct = result.outcome === 'matched' && result.matched_bank_txn_id === gt.expected_bank_txn_id;
    if (correct) {
      console.log(`      Verdict:     ✔ CORRECT — matched to right bank txn`);
    } else if (result.outcome === 'matched') {
      console.log(`      Verdict:     ✗ WRONG — matched to ${result.matched_bank_txn_id} instead of ${gt.expected_bank_txn_id}`);
    } else {
      console.log(`      Verdict:     ✗ WRONG — flagged as ${result.outcome} instead of matching`);
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║            ReconAgent — Agent Loop Test (5 Records)                 ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝\n');

  // Check API key
  if (!process.env.GEMINI_API_KEY) {
    console.error('✗ GEMINI_API_KEY not set in .env — cannot run agent loop.');
    console.error('  Add it to .env:  GEMINI_API_KEY=...');
    process.exit(1);
  }

  console.log(`  Model: ${process.env.GEMINI_MODEL || 'gemini-2.0-flash'}\n`);

  // Connect + migrate + ingest
  const ok = await testConnection();
  if (!ok) { console.error('DB connection failed'); process.exit(1); }

  await runMigration();

  // Clear matches/exceptions/audit_log for a clean run
  await query('TRUNCATE matches, exceptions, audit_log CASCADE');

  console.log('[Ingest] Loading CSV data...');
  const counts = await ingestData();
  console.log(`[Ingest] ✔ ${counts.ledgerCount} ledger, ${counts.bankCount} bank txns\n`);

  // Load ground truth
  const gtPath = path.resolve(__dirname, '..', 'data', 'ground_truth.json');
  const groundTruth: GroundTruthEntry[] = JSON.parse(fs.readFileSync(gtPath, 'utf-8'));

  // ── Test records: one per interesting case type ─────────────────────
  const testInvoices = [
    'INV-2026-0001',  // clean_exact   → precheck should handle this
    'INV-2026-0043',  // rounding_diff → agent should fuzzy-match
    'INV-2026-0068',  // duplicate_ref → agent should flag exception
    'INV-2026-0061',  // split_payment → agent should flag exception
    'INV-2026-0064',  // missing_bank_txn → agent should flag exception
  ];

  // Resolve invoice_id → DB id
  const idResult = await query<{ id: number; invoice_id: string }>(
    `SELECT id, invoice_id FROM ledger_records WHERE invoice_id = ANY($1)`,
    [testInvoices],
  );
  const idMap = new Map(idResult.rows.map(r => [r.invoice_id, r.id]));

  let correctCount = 0;

  for (const invoiceId of testInvoices) {
    const ledgerId = idMap.get(invoiceId);
    if (!ledgerId) {
      console.error(`  ✗ ${invoiceId} not found in DB`);
      continue;
    }

    const gt = groundTruth.find(g => g.ledger_invoice_id === invoiceId)!;

    console.log(hr('═', 72));
    console.log(`  ${invoiceId}  [${gt.case_type}]`);
    console.log(hr('═', 72));

    const startTime = Date.now();

    try {
      const result = await reconcileRecord(ledgerId);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      console.log(`\n    TOOL-CALL TRACE (${elapsed}s):`);
      printTrace(result.trace);
      printResult(result, gt);

      // Count correct
      if (gt.expected_bank_txn_id === null) {
        if (result.outcome === 'exception' || result.outcome === 'timeout') correctCount++;
      } else {
        if (result.outcome === 'matched' && result.matched_bank_txn_id === gt.expected_bank_txn_id) correctCount++;
      }
    } catch (err) {
      const error = err as Error;
      console.error(`\n    ✗ ERROR: ${error.message}`);
      if (error.message.includes('API_KEY') || error.message.includes('API key') || error.message.includes('authentication')) {
        console.error('    Check your GEMINI_API_KEY in .env');
        break;
      }
    }

    console.log('');
  }

  // ── Summary ─────────────────────────────────────────────────────────
  console.log(hr('═', 72));
  console.log(`  SUMMARY: ${correctCount}/${testInvoices.length} correct against ground truth`);
  console.log(hr('═', 72));

  await closePool();
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
