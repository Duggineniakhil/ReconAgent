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
    `SELECT id, txn_id, utr_ref, amount::float AS amount,
            txn_date::text AS txn_date, payer_name, status,
            ABS(amount - $1)          AS amount_diff,
            ABS(txn_date - $2::date)  AS date_diff_days
     FROM   bank_transactions
     WHERE  amount  BETWEEN $3 AND $4
       AND  txn_date BETWEEN ($2::date - INTERVAL '3 days')
                         AND ($2::date + INTERVAL '3 days')
     ORDER  BY ABS(amount - $1) + ABS(txn_date - $2::date) ASC
     LIMIT  5`,
    [amount, date, lowerAmt, upperAmt],
  );

  return result.rows;
}
