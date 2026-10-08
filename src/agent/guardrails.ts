/**
 * Server-side guardrails for commit_match.
 *
 * The system prompt asks the model to follow these rules, but a prompt is
 * not a control. Every commit_match is re-checked here against the database
 * before a match is written; if any check fails, the record becomes an
 * exception instead.
 */

export const MIN_CONFIDENCE = 0.85;

/** Max relative amount difference for a match (same window as find_fuzzy_candidates). */
export const AMOUNT_TOLERANCE = 0.01;

export type ExceptionReason =
  | 'no_candidate'
  | 'ambiguous_candidates'
  | 'duplicate_reference'
  | 'unexplained_discrepancy';

/** Database facts about the bank transaction or gateway payment the model wants to commit to. */
export interface CommitTarget {
  txn_id: string;
  utr_ref: string | null;
  /** Bank amount, or a gateway payment's gross amount (what the invoice was for). */
  amount: number;
  /** Number of bank transactions sharing this utr_ref (1 = unique; always 1 for gateway lines). */
  ref_count: number;
  /** Invoice or settlement that already owns this transaction, if any. */
  matched_to: string | null;
  /** Gateway lines only: payment / refund / transfer / adjustment. */
  entity_type?: string;
}

export type CommitCheck =
  | { ok: true }
  | { ok: false; reason: ExceptionReason; message: string };

export function checkCommit(
  ledgerAmount: number,
  confidence: number,
  target: CommitTarget | null,
  requestedTxnId: string,
): CommitCheck {
  if (!target) {
    return {
      ok: false,
      reason: 'unexplained_discrepancy',
      message: `Bank transaction "${requestedTxnId}" does not exist.`,
    };
  }

  if (!(confidence >= MIN_CONFIDENCE)) {
    return {
      ok: false,
      reason: 'unexplained_discrepancy',
      message: `Confidence ${confidence} is below the ${MIN_CONFIDENCE} threshold.`,
    };
  }

  if (target.entity_type && target.entity_type !== 'payment') {
    return {
      ok: false,
      reason: 'unexplained_discrepancy',
      message: `${target.txn_id} is a ${target.entity_type}; only payments can be matched to invoices.`,
    };
  }

  if (target.matched_to) {
    return {
      ok: false,
      reason: 'ambiguous_candidates',
      message: `${target.txn_id} is already matched to ${target.matched_to}.`,
    };
  }

  if (target.ref_count > 1) {
    return {
      ok: false,
      reason: 'duplicate_reference',
      message: `Reference ${target.utr_ref} appears on ${target.ref_count} bank transactions.`,
    };
  }

  const diff = Math.abs(target.amount - ledgerAmount);
  if (diff > Math.abs(ledgerAmount) * AMOUNT_TOLERANCE) {
    return {
      ok: false,
      reason: 'unexplained_discrepancy',
      message: `Amount differs by ${diff.toFixed(2)}, more than ${AMOUNT_TOLERANCE * 100}% of ${ledgerAmount}.`,
    };
  }

  return { ok: true };
}
