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
    `SELECT id, txn_id, utr_ref, amount::float AS amount,
            txn_date::text AS txn_date, payer_name, status
     FROM   bank_transactions
     WHERE  utr_ref = $1
       AND  amount  = $2`,
    [reference, amount],
  );

  return result.rows;
}
