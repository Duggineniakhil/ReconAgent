import { query } from '../db';

/**
 * A payment from the gateway's settlement report.
 */
export interface GatewayPaymentCandidate {
  entity_id: string;
  amount: number;
  fee: number;
  tax: number;
  /** What reached the merchant for this payment: amount − fee. */
  net: number;
  method: string | null;
  payment_date: string;
  order_receipt: string | null;
  notes: unknown;
  settlement_id: string | null;
  /** matched / mismatch / missing once the settlement has been reconciled; 'unsettled' if not paid out yet. */
  settlement_status: string;
  amount_diff: number;
  date_diff_days: number;
  /** Invoice this payment is already matched to, or null if unclaimed. */
  matched_to: string | null;
}

/**
 * Search Razorpay payments for an invoice: by order receipt / notes when a
 * receipt is given, otherwise (and additionally) by amount +/- 1% and
 * payment date +/- 3 days. Returns up to 5, closest first.
 *
 * @param amount   Invoice amount (gateway payments carry the gross amount)
 * @param date     Invoice date (YYYY-MM-DD)
 * @param receipt  Invoice ID, matched against order_receipt and notes
 */
export async function findGatewayPayments(
  amount: number,
  date: string,
  receipt?: string,
): Promise<GatewayPaymentCandidate[]> {
  const result = await query<GatewayPaymentCandidate>(
    `SELECT g.entity_id, g.amount::float AS amount, g.fee::float AS fee, g.tax::float AS tax,
            (g.amount - g.fee)::float AS net, g.method,
            (g.created_at AT TIME ZONE 'Asia/Kolkata')::date::text AS payment_date,
            g.order_receipt, g.notes, g.settlement_id,
            CASE WHEN g.settlement_id IS NULL THEN 'unsettled'
                 ELSE COALESCE((SELECT s.status FROM settlement_matches s WHERE s.settlement_id = g.settlement_id), 'not reconciled yet')
            END AS settlement_status,
            ABS(g.amount - $1)::float AS amount_diff,
            ABS((g.created_at AT TIME ZONE 'Asia/Kolkata')::date - $2::date) AS date_diff_days,
            (SELECT l.invoice_id FROM matches m JOIN ledger_records l ON l.id = m.ledger_id
              WHERE m.gateway_txn_id = g.id) AS matched_to
     FROM   gateway_transactions g
     WHERE  g.entity_type = 'payment'
       AND (
             ($3::text IS NOT NULL AND (g.order_receipt = $3 OR g.notes::text ILIKE '%' || $3 || '%'))
          OR (g.amount BETWEEN $1 * 0.99 AND $1 * 1.01
              AND ABS((g.created_at AT TIME ZONE 'Asia/Kolkata')::date - $2::date) <= 3)
       )
     ORDER  BY (g.order_receipt = $3) DESC NULLS LAST, ABS(g.amount - $1), date_diff_days
     LIMIT  5`,
    [amount, date, receipt ?? null],
  );
  return result.rows;
}
