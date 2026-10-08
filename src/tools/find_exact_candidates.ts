import { query } from '../db';

/**
 * Candidate row returned by find_exact_candidates.
 */
export interface ExactCandidate {
  id: number;
  txn_id: string;
  utr_ref: string;
  amount: number;
  txn_date: string;
  payer_name: string;
  status: string;
  /** Invoice or gateway settlement that already owns this transaction, or null if unclaimed. */
  matched_to: string | null;
}

/**
 * Search bank_transactions for an exact match on payment reference/UTR and amount.
 * This should be called first for every ledger record.
 *
 * @param reference  The payment reference / UTR to match
 * @param amount     The expected amount to match
 * @returns Array of matching bank transactions (typically 0 or 1)
 */
export async function findExactCandidates(
  reference: string,
  amount: number,
): Promise<ExactCandidate[]> {
  const result = await query<ExactCandidate>(
    `SELECT b.id, b.txn_id, b.utr_ref, b.amount::float AS amount,
            b.txn_date::text AS txn_date, b.payer_name, b.status,
            (SELECT c.claimed_by FROM bank_claims c WHERE c.bank_txn_id = b.id LIMIT 1) AS matched_to
     FROM   bank_transactions b
     WHERE  b.utr_ref = $1
       AND  b.amount  = $2`,
    [reference, amount],
  );

  return result.rows;
}
