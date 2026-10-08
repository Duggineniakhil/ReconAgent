/**
 * Gateway settlement reconciliation (deterministic, no LLM).
 *
 * Razorpay pays out many payments as one bank credit: the settlement's net
 * amount = payments − fees (incl. GST) − refunds ± adjustments. Each
 * settlement is matched to the bank credit carrying its UTR, and the
 * amounts must agree to the paisa.
 */
import { query, withTransaction } from '../db';

export interface SettlementSummary {
  settlement_id: string;
  settlement_utr: string | null;
  settled_at: string | null;
  payment_count: number;
  gross: number;
  fees: number;
  tax: number;
  refunds: number;
  /** Net of transfers and adjustments (credit − debit). */
  other: number;
  /** Amount the bank should receive: Σ credit − Σ debit. */
  net: number;
}

export interface BankCandidate {
  id: number;
  txn_id: string;
  utr_ref: string | null;
  amount: number;
  txn_date: string;
  claimed_by: string | null;
}

export interface SettlementDecision {
  status: 'matched' | 'mismatch' | 'missing';
  bank_txn_id: number | null;
  bank_amount: number | null;
  difference: number | null;
  reasoning: string;
}

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' });
const money = (n: number) => inr.format(n);
const round2 = (n: number) => Math.round(n * 100) / 100;

/** "4 payments ₹1,25,000.00 − fees ₹2,950.00 (incl. GST ₹450.00) − refunds ₹2,468.50 = ₹1,19,581.50" */
export function describeSettlement(s: SettlementSummary): string {
  const parts = [`${s.payment_count} payment${s.payment_count === 1 ? '' : 's'} ${money(s.gross)}`];
  if (s.fees) parts.push(`− fees ${money(s.fees)} (incl. GST ${money(s.tax)})`);
  if (s.refunds) parts.push(`− refunds ${money(s.refunds)}`);
  if (s.other) parts.push(`${s.other < 0 ? '−' : '+'} adjustments ${money(Math.abs(s.other))}`);
  return `${parts.join(' ')} = ${money(s.net)} net`;
}

/**
 * Decide a settlement's outcome given bank transactions with its UTR
 * (`byUtr`) and, as a fallback when the UTR isn't on the statement,
 * unclaimed credits of exactly the net amount near the settlement date
 * (`byAmount`).
 */
export function decideSettlement(
  s: SettlementSummary,
  byUtr: BankCandidate[],
  byAmount: BankCandidate[],
): SettlementDecision {
  const breakdown = `Razorpay settlement ${s.settlement_id}: ${describeSettlement(s)}.`;

  const available = byUtr.filter((b) => !b.claimed_by);
  if (byUtr.length > 0 && available.length === 0) {
    return {
      status: 'mismatch', bank_txn_id: null, bank_amount: null, difference: null,
      reasoning: `${breakdown} The bank credit with UTR ${s.settlement_utr} (${byUtr[0].txn_id}) is already matched to ${byUtr[0].claimed_by}.`,
    };
  }
  if (available.length > 1) {
    return {
      status: 'mismatch', bank_txn_id: null, bank_amount: null, difference: null,
      reasoning: `${breakdown} UTR ${s.settlement_utr} appears on ${available.length} bank transactions (${available.map((b) => b.txn_id).join(', ')}); review manually.`,
    };
  }
  if (available.length === 1) {
    const bank = available[0];
    const difference = round2(bank.amount - s.net);
    if (Math.abs(difference) < 0.005) {
      return {
        status: 'matched', bank_txn_id: bank.id, bank_amount: bank.amount, difference: 0,
        reasoning: `${breakdown} Bank credit ${bank.txn_id} on ${bank.txn_date} (UTR ${bank.utr_ref}) is ${money(bank.amount)}, which matches.`,
      };
    }
    return {
      status: 'mismatch', bank_txn_id: bank.id, bank_amount: bank.amount, difference,
      reasoning: `${breakdown} Bank credit ${bank.txn_id} (UTR ${bank.utr_ref}) is ${money(bank.amount)}, ${money(Math.abs(difference))} ${difference < 0 ? 'less' : 'more'} than expected. Look for a chargeback, hold or adjustment missing from the report.`,
    };
  }

  // UTR not on the statement: accept a single unclaimed credit of exactly the net amount
  const amountMatches = byAmount.filter((b) => !b.claimed_by);
  if (amountMatches.length === 1) {
    const bank = amountMatches[0];
    return {
      status: 'matched', bank_txn_id: bank.id, bank_amount: bank.amount, difference: 0,
      reasoning: `${breakdown} UTR ${s.settlement_utr} is not on the statement, but bank credit ${bank.txn_id} on ${bank.txn_date} is exactly ${money(bank.amount)} within 3 days of the settlement (reference ${bank.utr_ref}).`,
    };
  }
  return {
    status: 'missing', bank_txn_id: null, bank_amount: null, difference: null,
    reasoning: amountMatches.length > 1
      ? `${breakdown} UTR ${s.settlement_utr} is not on the statement and ${amountMatches.length} credits have the same amount (${amountMatches.map((b) => b.txn_id).join(', ')}); review manually.`
      : `${breakdown} No bank credit with UTR ${s.settlement_utr} or of ${money(s.net)} near ${s.settled_at?.slice(0, 10) ?? 'the settlement date'}. The payout may not have reached the bank yet.`,
  };
}

/** Totals per settlement from gateway_transactions. */
export async function summariseSettlements(onlyUnreconciled = false): Promise<SettlementSummary[]> {
  const result = await query<SettlementSummary>(`
    SELECT g.settlement_id,
           MAX(g.settlement_utr) AS settlement_utr,
           MAX(g.settled_at)::date::text AS settled_at,
           COUNT(*) FILTER (WHERE g.entity_type = 'payment')::int AS payment_count,
           COALESCE(SUM(g.amount) FILTER (WHERE g.entity_type = 'payment'), 0)::float AS gross,
           COALESCE(SUM(g.fee), 0)::float AS fees,
           COALESCE(SUM(g.tax), 0)::float AS tax,
           COALESCE(SUM(g.debit) FILTER (WHERE g.entity_type = 'refund'), 0)::float AS refunds,
           COALESCE(SUM(g.credit - g.debit) FILTER (WHERE g.entity_type IN ('transfer','adjustment')), 0)::float AS other,
           SUM(g.credit - g.debit)::float AS net
    FROM gateway_transactions g
    WHERE g.settlement_id IS NOT NULL
      ${onlyUnreconciled ? 'AND NOT EXISTS (SELECT 1 FROM settlement_matches s WHERE s.settlement_id = g.settlement_id)' : ''}
    GROUP BY g.settlement_id
    ORDER BY MAX(g.settled_at), g.settlement_id
  `);
  return result.rows;
}

const BANK_CANDIDATE_COLUMNS = `
  b.id, b.txn_id, b.utr_ref, b.amount::float AS amount, b.txn_date::text AS txn_date,
  (SELECT c.claimed_by FROM bank_claims c WHERE c.bank_txn_id = b.id LIMIT 1) AS claimed_by`;

/**
 * Match every settlement that has no outcome yet to its bank credit.
 * Returns how many ended up in each status.
 */
export async function reconcileSettlements(runId: number | null = null): Promise<Record<SettlementDecision['status'], number>> {
  const counts = { matched: 0, mismatch: 0, missing: 0 };

  for (const s of await summariseSettlements(true)) {
    const byUtr = s.settlement_utr
      ? (await query<BankCandidate>(`SELECT ${BANK_CANDIDATE_COLUMNS} FROM bank_transactions b WHERE b.utr_ref = $1`, [s.settlement_utr])).rows
      : [];
    const byAmount = byUtr.length || !s.settled_at
      ? []
      : (await query<BankCandidate>(
          `SELECT ${BANK_CANDIDATE_COLUMNS} FROM bank_transactions b
           WHERE b.amount = $1 AND b.txn_date BETWEEN $2::date AND $2::date + 3`,
          [s.net, s.settled_at],
        )).rows;

    const decision = decideSettlement(s, byUtr, byAmount);
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO settlement_matches
           (settlement_id, settlement_utr, status, bank_txn_id, expected_amount, bank_amount, difference, reasoning, run_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [s.settlement_id, s.settlement_utr, decision.status, decision.bank_txn_id, s.net,
         decision.bank_amount, decision.difference, decision.reasoning, runId],
      );
    });
    counts[decision.status]++;
  }
  return counts;
}

/** Gateway fees and GST, overall and per payment method. */
export async function feeSummary() {
  const result = await query<{
    method: string; payments: number; gross: number; fees: number; tax: number;
  }>(`
    SELECT COALESCE(method, 'unknown') AS method,
           COUNT(*)::int AS payments,
           SUM(amount)::float AS gross,
           SUM(fee)::float AS fees,
           SUM(tax)::float AS tax
    FROM gateway_transactions
    WHERE entity_type = 'payment'
    GROUP BY 1
    ORDER BY gross DESC
  `);
  const byMethod = result.rows.map((r) => ({ ...r, effective_rate: r.gross ? r.fees / r.gross : 0 }));
  const total = byMethod.reduce(
    (t, r) => ({ payments: t.payments + r.payments, gross: t.gross + r.gross, fees: t.fees + r.fees, tax: t.tax + r.tax }),
    { payments: 0, gross: 0, fees: 0, tax: 0 },
  );
  return {
    total: { ...total, gross: round2(total.gross), fees: round2(total.fees), tax: round2(total.tax), effective_rate: total.gross ? total.fees / total.gross : 0 },
    by_method: byMethod,
  };
}
