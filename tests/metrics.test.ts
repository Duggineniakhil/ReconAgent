import { describe, it, expect } from 'vitest';
import { evaluate, type GroundTruthEntry } from '../src/services/metrics';

const truth: GroundTruthEntry[] = [
  { ledger_invoice_id: 'A', expected_bank_txn_id: 'T-A', case_type: 'clean_exact' },
  { ledger_invoice_id: 'B', expected_bank_txn_id: 'T-B', case_type: 'rounding_diff' },
  { ledger_invoice_id: 'C', expected_bank_txn_id: 'T-C', case_type: 'name_variant' },
  { ledger_invoice_id: 'D', expected_bank_txn_id: null, case_type: 'duplicate_ref' },
  { ledger_invoice_id: 'E', expected_bank_txn_id: null, case_type: 'missing_bank_txn' },
  { ledger_invoice_id: 'F', expected_bank_txn_id: 'T-F', case_type: 'clean_exact' },
];

describe('evaluate', () => {
  it('scores each kind of outcome', () => {
    const r = evaluate(truth, new Map<string, string | null>([
      ['A', 'T-A'],   // TP
      ['B', 'T-X'],   // wrong txn: FP + FN
      ['C', null],    // flagged a real match: FN
      ['D', null],    // TN
      ['E', 'T-E'],   // matched something that should be an exception: FP
      // F not processed yet
    ]));

    expect(r.confusion_matrix).toEqual({ TP: 1, FP: 2, FN: 2, TN: 1 });
    expect(r.precision).toBeCloseTo(1 / 3);
    expect(r.recall).toBeCloseTo(1 / 3);
    expect(r.pending_records).toBe(1);
    expect(r.evaluated_records).toBe(5);
    // Record-level: A and D correct out of 5 decided
    expect(r.accuracy).toBeCloseTo(2 / 5);
    expect(r.by_case_type.clean_exact).toEqual({ total: 2, correct: 1, pending: 1 });
  });

  it('returns zeros, not NaN, when nothing is decided', () => {
    const r = evaluate(truth, new Map());
    expect(r).toMatchObject({ precision: 0, recall: 0, accuracy: 0, pending_records: 6 });
  });
});
