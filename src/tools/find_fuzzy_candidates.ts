import { query } from '../db';

/**
 * Candidate row returned by find_fuzzy_candidates.
 */
export interface FuzzyCandidate {
  id: number;
  txn_id: string;
  utr_ref: string;
  amount: number;
  txn_date: string;
  payer_name: string;
  status: string;
  amount_diff: number;
  date_diff_days: number;
  /** Invoice or gateway settlement that already owns this transaction, or null if unclaimed. */
  matched_to: string | null;
}

/**
 * Search bank_transactions within a tolerance window:
 *   - amount: +/- 1%
 *   - date:   +/- 3 days
 *
 * Returns up to 5 candidates ranked by proximity (smallest combined
 * amount + date deviation first).
 *
 * @param amount        The target amount
 * @param date          The target date (YYYY-MM-DD string)
 * @param customerName  Optional — not used in the SQL filter, but included
 *                      in the return for caller convenience
 */
export async function findFuzzyCandidates(
  amount: number,
  date: string,
  _customerName?: string,
): Promise<FuzzyCandidate[]> {
  const tolerance = amount * 0.01; // 1%
  const lowerAmt  = amount - tolerance;
  const upperAmt  = amount + tolerance;

  const result = await query<FuzzyCandidate>(
    `SELECT b.id, b.txn_id, b.utr_ref, b.amount::float AS amount,
            b.txn_date::text AS txn_date, b.payer_name, b.status,
            ABS(b.amount - $1)::float          AS amount_diff,
            ABS(b.txn_date - $2::date)         AS date_diff_days,
            (SELECT c.claimed_by FROM bank_claims c WHERE c.bank_txn_id = b.id LIMIT 1) AS matched_to
     FROM   bank_transactions b
     WHERE  b.amount  BETWEEN $3 AND $4
       AND  b.txn_date BETWEEN ($2::date - INTERVAL '3 days')
                           AND ($2::date + INTERVAL '3 days')
     ORDER  BY ABS(b.amount - $1) + ABS(b.txn_date - $2::date) ASC
     LIMIT  5`,
    [amount, date, lowerAmt, upperAmt],
  );

  return result.rows;
}
