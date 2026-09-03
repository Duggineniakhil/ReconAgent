import { query } from '../db';

/**
 * Result from check_duplicate_ref.
 */
export interface DuplicateRefResult {
  reference: string;
  is_duplicate: boolean;
  count: number;
  txn_ids: string[];
}

/**
 * Checks whether a given payment reference / UTR appears more than once
 * across all bank_transactions. A duplicate is a red flag — even if the
 * amount and name look right, the agent should flag it as an exception.
 *
 * @param reference  The payment reference / UTR to check
 * @returns Object indicating whether it's duplicated, plus the count and txn IDs
 */
export async function checkDuplicateRef(
  reference: string,
): Promise<DuplicateRefResult> {
  const result = await query<{ txn_id: string }>(
    `SELECT txn_id
     FROM   bank_transactions
     WHERE  utr_ref = $1
     ORDER  BY id`,
    [reference],
  );

  return {
    reference,
    is_duplicate: result.rows.length > 1,
    count: result.rows.length,
    txn_ids: result.rows.map(r => r.txn_id),
  };
}
