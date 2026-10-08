import axios from 'axios';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000/api';

const api = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

/** Pull the server's error message out of an axios error. */
export function apiError(err: unknown): string {
  if (axios.isAxiosError(err)) return err.response?.data?.error ?? err.message;
  return err instanceof Error ? err.message : String(err);
}

export interface Dataset {
  id: number;
  name: string;
  source: 'demo' | 'upload';
  ledger_count: number;
  bank_count: number;
  created_at: string;
}

export interface IngestResponse {
  success: boolean;
  counts: { ledgerCount: number; bankCount: number };
  dataset: Dataset;
}

export interface CaseTypeStats {
  total: number;
  correct: number;
  pending: number;
}

export interface Metrics {
  total_records: string;
  total_matches: string;
  total_exceptions: string;
  open_exceptions: string;
  rejected_exceptions: string;
  has_ground_truth: boolean;
  pending_records?: number;
  evaluated_records?: number;
  precision?: number;
  recall?: number;
  accuracy?: number;
  confusion_matrix?: { TP: number; FP: number; FN: number; TN: number };
  by_case_type?: Record<string, CaseTypeStats>;
}

export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export interface Run {
  id: number;
  dataset_id: number | null;
  dataset_name?: string | null;
  dataset_source?: 'demo' | 'upload' | null;
  status: RunStatus;
  model: string;
  prompt_version: string;
  concurrency: number;
  total: number;
  processed: number;
  matched: number;
  exceptions: number;
  errors: number;
  precheck_hits: number;
  llm_calls: number;
  input_tokens: number;
  output_tokens: number;
  failures: { ledger_id: number; error: string }[];
  metrics: Omit<Metrics, 'total_records' | 'total_matches' | 'total_exceptions' | 'open_exceptions' | 'rejected_exceptions' | 'has_ground_truth'> | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

export type FieldType = 'text' | 'amount' | 'date';
export type DateFormat = 'auto' | 'YMD' | 'DMY' | 'MDY';
export type ColumnMapping = Record<string, string | null>;

export interface FilePreview {
  headers: string[];
  rowCount: number;
  sample: Record<string, string>[];
  fields: { key: string; label: string; type: FieldType; required: boolean }[];
  suggested: ColumnMapping;
}

export interface UploadPreview {
  ledger: FilePreview;
  bank: FilePreview;
}

export interface RowError {
  row: number;
  field: string;
  message: string;
}

export interface UploadErrors {
  error: string;
  files: { file: 'ledger' | 'bank'; errors: RowError[] }[];
}

export interface Match {
  match_id: number;
  ledger_id: number;
  method: 'exact' | 'fuzzy' | 'reasoned' | 'manual';
  confidence: number;
  reasoning: string;
  invoice_id: string;
  customer_name: string;
  ledger_amount: number;
  ledger_ref: string;
  /** Set for direct bank matches. */
  bank_txn_id: string | null;
  bank_amount: number | null;
  /** Set when the invoice was matched to a Razorpay payment. */
  gateway_entity_id: string | null;
  gateway_amount: number | null;
  gateway_fee: number | null;
  gateway_method: string | null;
  gateway_settlement_id: string | null;
}

export interface Exception {
  exception_id: number;
  ledger_id: number;
  reason: string;
  reasoning: string;
  status: string;
  best_candidate_bank_txn_id: number | null;
  invoice_id: string;
  customer_name: string;
  ledger_amount: number;
  ledger_ref: string;
  best_candidate_txn_id: string | null;
  best_candidate_amount: number | null;
  best_candidate_kind: 'bank' | 'gateway' | null;
}

export type SettlementStatus = 'matched' | 'mismatch' | 'missing';

export interface Settlement {
  settlement_id: string;
  settlement_utr: string | null;
  settled_at: string | null;
  payment_count: number;
  gross: number;
  fees: number;
  tax: number;
  refunds: number;
  other: number;
  net: number;
  /** Null until a run has reconciled this settlement. */
  outcome: {
    status: SettlementStatus;
    reasoning: string;
    difference: number | null;
    bank_amount: number | null;
    bank_txn_id: string | null;
    bank_date: string | null;
  } | null;
}

export interface SettlementLine {
  entity_id: string;
  entity_type: 'payment' | 'refund' | 'transfer' | 'adjustment';
  amount: number;
  fee: number;
  tax: number;
  net: number;
  method: string | null;
  order_receipt: string | null;
  payment_id: string | null;
  created_at: string;
  matched_invoice: string | null;
}

export interface FeeRow {
  payments: number;
  gross: number;
  fees: number;
  tax: number;
  effective_rate: number;
}

export interface FeeSummary {
  total: FeeRow;
  by_method: (FeeRow & { method: string })[];
}

export interface AuditLog {
  turn: number;
  tool_name: string;
  tool_input: any;
  tool_result: any;
  created_at: string;
}

export const fetchMetrics = async (): Promise<Metrics> => {
  const { data } = await api.get('/metrics');
  return data;
};

export const triggerIngest = async (): Promise<IngestResponse> => {
  const { data } = await api.post('/ingest');
  return data;
};

export const fetchDataset = async (): Promise<Dataset | null> => {
  const { data } = await api.get('/dataset');
  return data;
};

export const previewUpload = async (ledgerCsv: string, bankCsv: string): Promise<UploadPreview> => {
  const { data } = await api.post('/datasets/preview', { ledgerCsv, bankCsv });
  return data;
};

/** Resolves with the new dataset, or with the row-level errors when validation fails (422). */
export const uploadDataset = async (body: {
  name: string;
  dateFormat: DateFormat;
  ledger: { csv: string; mapping: ColumnMapping };
  bank: { csv: string; mapping: ColumnMapping };
}): Promise<{ dataset: Dataset } | UploadErrors> => {
  try {
    const { data } = await api.post('/datasets/upload', body);
    return data;
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 422) return err.response.data;
    throw err;
  }
};

export const fetchRuns = async (): Promise<Run[]> => {
  const { data } = await api.get('/runs');
  return data;
};

export const startRun = async (options: { limit?: number; concurrency?: number } = {}): Promise<Run> => {
  const { data } = await api.post('/runs', options);
  return data;
};

export const cancelRun = async (id: number): Promise<void> => {
  await api.post(`/runs/${id}/cancel`);
};

/**
 * Stream live updates for a run. Calls `onUpdate` with the run row on connect
 * and after every processed record; closes itself once the run has finished.
 * Returns a function that closes the stream early.
 */
export function subscribeRun(id: number, onUpdate: (run: Run) => void): () => void {
  const source = new EventSource(`${API_URL}/runs/${id}/events`);
  source.onmessage = (event) => {
    const run: Run = JSON.parse(event.data);
    onUpdate(run);
    if (run.status !== 'running') source.close();
  };
  // On a dropped connection EventSource reconnects by itself, and the server
  // replays the current run row on every connect, so nothing is missed.
  return () => source.close();
}

export const fetchMatches = async (): Promise<Match[]> => {
  const { data } = await api.get('/matches');
  return data;
};

export const fetchExceptions = async (): Promise<Exception[]> => {
  const { data } = await api.get('/exceptions');
  return data;
};

export const resolveException = async (
  id: number,
  action: 'match' | 'reject',
  target?: { kind: 'bank' | 'gateway'; id: string },
): Promise<{ success: boolean; message: string }> => {
  const body = target?.kind === 'gateway'
    ? { action, gateway_entity_id: target.id }
    : { action, bank_txn_id: target?.id };
  const { data } = await api.post(`/exceptions/${id}/resolve`, body);
  return data;
};

export const fetchSettlements = async (): Promise<Settlement[]> => {
  const { data } = await api.get('/settlements');
  return data;
};

export const fetchSettlementLines = async (id: string): Promise<SettlementLine[]> => {
  const { data } = await api.get(`/settlements/${encodeURIComponent(id)}`);
  return data;
};

export const fetchGatewayFees = async (): Promise<FeeSummary> => {
  const { data } = await api.get('/gateway/fees');
  return data;
};

export const fetchRazorpayStatus = async (): Promise<{ configured: boolean; mode: 'test' | 'live' | null }> => {
  const { data } = await api.get('/razorpay/status');
  return data;
};

export const syncRazorpay = async (from: string, to: string): Promise<{ days: number; items: number; settlements: number }> => {
  const { data } = await api.post('/razorpay/sync', { from, to });
  return data;
};

export const fetchAuditLog = async (ledgerId: number): Promise<AuditLog[]> => {
  const { data } = await api.get(`/audit-log/${ledgerId}`);
  return data;
};
