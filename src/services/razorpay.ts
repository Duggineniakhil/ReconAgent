/**
 * Razorpay settlement recon: normalising report lines and syncing them
 * from the API (GET /v1/settlements/recon/combined).
 *
 * The API reports amounts in paise and times as unix seconds; we store
 * rupees and timestamps. Keys come from RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET
 * (use test-mode keys while developing).
 */
import type { PoolClient } from 'pg';
import { withTransaction } from '../db';

const API_BASE = process.env.RAZORPAY_API_BASE || 'https://api.razorpay.com/v1';
/** Max page size the recon endpoint accepts. */
const PAGE_SIZE = 1000;
/** Longest date range one sync may cover (one API call per day, per page). */
const MAX_SYNC_DAYS = 62;

/** One item of the recon report, as returned by the API. */
export interface RazorpayReconItem {
  entity_id: string;
  type: 'payment' | 'refund' | 'transfer' | 'adjustment';
  debit: number;
  credit: number;
  amount: number;
  currency: string;
  fee: number | null;
  tax: number | null;
  settled: boolean;
  created_at: number;
  settled_at: number | null;
  settlement_id: string | null;
  settlement_utr: string | null;
  description: string | null;
  notes: unknown;
  payment_id: string | null;
  order_id: string | null;
  order_receipt: string | null;
  method: string | null;
  [key: string]: unknown;
}

/** A gateway line ready to insert into gateway_transactions. */
export interface GatewayInput {
  provider: string;
  entity_id: string;
  entity_type: string;
  amount: number;
  fee: number;
  tax: number;
  credit: number;
  debit: number;
  currency: string;
  method: string | null;
  order_id: string | null;
  order_receipt: string | null;
  payment_id: string | null;
  description: string | null;
  notes: unknown;
  settled: boolean;
  settlement_id: string | null;
  settlement_utr: string | null;
  created_at: string;
  settled_at: string | null;
}

const rupees = (paise: number | null | undefined) => Math.round(Number(paise ?? 0)) / 100;
const isoFromUnix = (s: number | null | undefined) => (s ? new Date(s * 1000).toISOString() : null);

export function normaliseReconItem(item: RazorpayReconItem): GatewayInput {
  return {
    provider: 'razorpay',
    entity_id: item.entity_id,
    entity_type: item.type,
    amount: rupees(item.amount),
    fee: rupees(item.fee),
    tax: rupees(item.tax),
    credit: rupees(item.credit),
    debit: rupees(item.debit),
    currency: item.currency || 'INR',
    method: item.method ?? null,
    order_id: item.order_id ?? null,
    order_receipt: item.order_receipt ?? null,
    payment_id: item.payment_id ?? null,
    description: item.description ?? null,
    notes: item.notes ?? null,
    settled: Boolean(item.settled),
    settlement_id: item.settlement_id ?? null,
    settlement_utr: item.settlement_utr ?? null,
    created_at: isoFromUnix(item.created_at)!,
    settled_at: isoFromUnix(item.settled_at),
  };
}

/**
 * Insert or update gateway lines (keyed by entity_id), e.g. when a payment
 * that was captured earlier later shows up settled.
 */
export async function upsertGatewayTransactions(input: GatewayInput[], client?: PoolClient): Promise<number> {
  // One row per entity (latest wins): ON CONFLICT can't update a row twice in one statement
  const rows = [...new Map(input.map((r) => [r.entity_id, r])).values()];
  if (rows.length === 0) return 0;
  const run = async (c: PoolClient) => {
    const col = <K extends keyof GatewayInput>(k: K) => rows.map((r) => r[k]);
    const result = await c.query(
      `INSERT INTO gateway_transactions
         (provider, entity_id, entity_type, amount, fee, tax, credit, debit, currency, method,
          order_id, order_receipt, payment_id, description, notes, settled, settlement_id,
          settlement_utr, created_at, settled_at)
       SELECT * FROM unnest(
         $1::text[], $2::text[], $3::text[], $4::numeric[], $5::numeric[], $6::numeric[], $7::numeric[],
         $8::numeric[], $9::text[], $10::text[], $11::text[], $12::text[], $13::text[], $14::text[],
         $15::jsonb[], $16::boolean[], $17::text[], $18::text[], $19::timestamptz[], $20::timestamptz[])
       ON CONFLICT (entity_id) DO UPDATE SET
         amount = EXCLUDED.amount, fee = EXCLUDED.fee, tax = EXCLUDED.tax,
         credit = EXCLUDED.credit, debit = EXCLUDED.debit, settled = EXCLUDED.settled,
         settlement_id = EXCLUDED.settlement_id, settlement_utr = EXCLUDED.settlement_utr,
         settled_at = EXCLUDED.settled_at, notes = EXCLUDED.notes`,
      [
        col('provider'), col('entity_id'), col('entity_type'), col('amount'), col('fee'), col('tax'),
        col('credit'), col('debit'), col('currency'), col('method'), col('order_id'), col('order_receipt'),
        col('payment_id'), col('description'), rows.map((r) => (r.notes == null ? null : JSON.stringify(r.notes))),
        col('settled'), col('settlement_id'), col('settlement_utr'), col('created_at'), col('settled_at'),
      ],
    );
    return result.rowCount ?? 0;
  };
  return client ? run(client) : withTransaction(run);
}

// ═══════════════════════════════════════════════════════════════════════
//  API CLIENT
// ═══════════════════════════════════════════════════════════════════════

export interface RazorpayCredentials {
  keyId: string;
  keySecret: string;
}

export function credentialsFromEnv(): RazorpayCredentials | null {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  return keyId && keySecret ? { keyId, keySecret } : null;
}

export class RazorpayApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** Fetch every recon item for settlements received on one day (all pages). */
export async function fetchReconForDay(
  date: { year: number; month: number; day: number },
  creds: RazorpayCredentials,
  fetchImpl: typeof fetch = fetch,
): Promise<RazorpayReconItem[]> {
  const auth = 'Basic ' + Buffer.from(`${creds.keyId}:${creds.keySecret}`).toString('base64');
  const items: RazorpayReconItem[] = [];

  for (let skip = 0; ; skip += PAGE_SIZE) {
    const params = new URLSearchParams({
      year: String(date.year),
      month: String(date.month).padStart(2, '0'),
      day: String(date.day).padStart(2, '0'),
      count: String(PAGE_SIZE),
      skip: String(skip),
    });
    const response = await fetchImpl(`${API_BASE}/settlements/recon/combined?${params}`, {
      headers: { Authorization: auth },
    });
    const body = (await response.json().catch(() => ({}))) as {
      items?: RazorpayReconItem[];
      error?: { description?: string };
    };
    if (!response.ok) {
      throw new RazorpayApiError(body.error?.description ?? `Razorpay API returned ${response.status}`, response.status);
    }
    const page = body.items ?? [];
    items.push(...page);
    if (page.length < PAGE_SIZE) return items;
  }
}

/** Every calendar day from `from` to `to` inclusive (YYYY-MM-DD). */
export function daysBetween(from: string, to: string): { year: number; month: number; day: number }[] {
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
    throw new Error('from and to must be YYYY-MM-DD dates with from <= to');
  }
  const days = [];
  for (const d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    days.push({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() });
  }
  if (days.length > MAX_SYNC_DAYS) throw new Error(`A sync can cover at most ${MAX_SYNC_DAYS} days`);
  return days;
}

/**
 * Pull the recon report for every day in [from, to] and upsert it into
 * gateway_transactions for the current dataset.
 */
export async function syncRazorpay(
  from: string,
  to: string,
  creds: RazorpayCredentials,
  fetchImpl: typeof fetch = fetch,
): Promise<{ days: number; items: number; settlements: number }> {
  const days = daysBetween(from, to);
  const all: GatewayInput[] = [];
  for (const day of days) {
    const items = await fetchReconForDay(day, creds, fetchImpl);
    all.push(...items.map(normaliseReconItem));
  }
  await upsertGatewayTransactions(all);
  return {
    days: days.length,
    items: all.length,
    settlements: new Set(all.map((r) => r.settlement_id).filter(Boolean)).size,
  };
}
