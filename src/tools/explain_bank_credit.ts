import { query } from '../db';

export interface BankCreditExplanation {
  bank_txn_id: string;
  is_gateway_settlement: boolean;
  settlement_id?: string;
  /** matched / mismatch / missing, or null if not reconciled yet. */
  settlement_status?: string | null;
  bank_amount?: number;
  expected_net?: number;
  lines?: {
    entity_id: string;
    type: string;
    amount: number;
    fee: number;
    net: number;
    order_receipt: string | null;
    matched_to: string | null;
  }[];
}

/**
 * Explain a bank credit: if its reference is a gateway settlement UTR, list
 * the payments, refunds and fees that make it up. A settlement credit pays
 * out many invoices at once, so it should never be matched to one invoice.
 */
export async function explainBankCredit(bankTxnId: string): Promise<BankCreditExplanation> {
  const bank = await query<{ id: number; amount: number; utr_ref: string | null }>(
    `SELECT id, amount::float AS amount, utr_ref FROM bank_transactions WHERE txn_id = $1`,
    [bankTxnId],
  );
  const credit = bank.rows[0];
  if (!credit) return { bank_txn_id: bankTxnId, is_gateway_settlement: false };

  // Either a settlement already matched to this credit, or one whose UTR it carries
  const lines = await query<{
    settlement_id: string; entity_id: string; type: string; amount: number; fee: number; net: number;
    order_receipt: string | null; matched_to: string | null;
  }>(
    `SELECT g.settlement_id, g.entity_id, g.entity_type AS type, g.amount::float AS amount,
            g.fee::float AS fee, (g.credit - g.debit)::float AS net, g.order_receipt,
            (SELECT l.invoice_id FROM matches m JOIN ledger_records l ON l.id = m.ledger_id
              WHERE m.gateway_txn_id = g.id) AS matched_to
     FROM   gateway_transactions g
     WHERE  g.settlement_id = COALESCE(
              (SELECT s.settlement_id FROM settlement_matches s WHERE s.bank_txn_id = $1),
              (SELECT g2.settlement_id FROM gateway_transactions g2
                WHERE g2.settlement_utr = $2 AND $2 IS NOT NULL LIMIT 1))
     ORDER  BY g.created_at`,
    [credit.id, credit.utr_ref],
  );
  if (lines.rows.length === 0) return { bank_txn_id: bankTxnId, is_gateway_settlement: false };

  const settlementId = lines.rows[0].settlement_id;
  const status = await query<{ status: string }>(
    `SELECT status FROM settlement_matches WHERE settlement_id = $1`, [settlementId],
  );
  return {
    bank_txn_id: bankTxnId,
    is_gateway_settlement: true,
    settlement_id: settlementId,
    settlement_status: status.rows[0]?.status ?? null,
    bank_amount: credit.amount,
    expected_net: Math.round(lines.rows.reduce((s, l) => s + l.net, 0) * 100) / 100,
    lines: lines.rows.map(({ settlement_id: _s, ...line }) => line),
  };
}
