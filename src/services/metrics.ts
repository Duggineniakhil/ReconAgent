/**
 * Scores the agent's decisions against ground_truth.json.
 *
 * Precision/recall are pair-level: matching a record to the wrong bank txn is
 * a false positive (wrong pair claimed) AND a false negative (right pair
 * missed). Accuracy is record-level: the share of decided records whose
 * outcome was fully correct. Records the agent hasn't decided yet are counted
 * as pending, not as errors.
 */

export interface GroundTruthEntry {
  ledger_invoice_id: string;
  expected_bank_txn_id: string | null;
  /** For invoices paid through a gateway: the payment they should match. */
  expected_gateway_entity_id?: string | null;
  case_type: string;
}

/** What the agent decided for a record: a bank txn / gateway payment id, or null for an exception. */
export type AgentDecisions = Map<string, string | null>;

export interface CaseTypeStats {
  total: number;
  correct: number;
  pending: number;
}

export interface EvaluationResult {
  precision: number;
  recall: number;
  accuracy: number;
  confusion_matrix: { TP: number; FP: number; FN: number; TN: number };
  evaluated_records: number;
  pending_records: number;
  by_case_type: Record<string, CaseTypeStats>;
}

const ratio = (num: number, den: number) => (den > 0 ? num / den : 0);

export function evaluate(truth: GroundTruthEntry[], decisions: AgentDecisions): EvaluationResult {
  let TP = 0, FP = 0, FN = 0, TN = 0;
  let correct = 0, pending = 0;
  const byCase: Record<string, CaseTypeStats> = {};

  for (const gt of truth) {
    const stats = (byCase[gt.case_type] ??= { total: 0, correct: 0, pending: 0 });
    stats.total++;

    if (!decisions.has(gt.ledger_invoice_id)) {
      pending++;
      stats.pending++;
      continue;
    }

    const matchedTxn = decisions.get(gt.ledger_invoice_id) ?? null;
    const expected = gt.expected_gateway_entity_id ?? gt.expected_bank_txn_id;
    let isCorrect = false;

    if (expected !== null) {
      if (matchedTxn === expected) {
        TP++;
        isCorrect = true;
      } else if (matchedTxn !== null) {
        FP++;
        FN++;
      } else {
        FN++;
      }
    } else if (matchedTxn === null) {
      TN++;
      isCorrect = true;
    } else {
      FP++;
    }

    if (isCorrect) {
      correct++;
      stats.correct++;
    }
  }

  const evaluated = truth.length - pending;
  return {
    precision: ratio(TP, TP + FP),
    recall: ratio(TP, TP + FN),
    accuracy: ratio(correct, evaluated),
    confusion_matrix: { TP, FP, FN, TN },
    evaluated_records: evaluated,
    pending_records: pending,
    by_case_type: byCase,
  };
}
