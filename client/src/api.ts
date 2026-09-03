import axios from 'axios';

const api = axios.create({
  baseURL: 'http://localhost:3000/api', // Hardcoded for demo, normally env var
  headers: {
    'Content-Type': 'application/json',
  },
});

export interface IngestResponse {
  success: boolean;
  counts: { ledgerCount: number; bankCount: number };
}

export interface ReconcileResponse {
  success: boolean;
  processed: number;
  errors: any[];
}

export interface Metrics {
  total_records: string;
  total_matches: string;
  total_exceptions: string;
  precision?: number;
  recall?: number;
  accuracy?: number;
  confusion_matrix?: { TP: number; FP: number; FN: number; TN: number };
}

export interface Match {
  match_id: number;
  method: string;
  confidence: number;
  reasoning: string;
  invoice_id: string;
  customer_name: string;
  ledger_amount: number;
  ledger_ref: string;
  bank_txn_id: string;
  bank_amount: number;
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

export const triggerReconcile = async (limit?: number): Promise<ReconcileResponse> => {
  const url = limit ? `/reconcile?limit=${limit}` : '/reconcile';
  const { data } = await api.post(url);
  return data;
};

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
  bank_txn_id?: string
): Promise<{ success: boolean; message: string }> => {
  const { data } = await api.post(`/exceptions/${id}/resolve`, { action, bank_txn_id });
  return data;
};

export const fetchAuditLog = async (ledgerId: number): Promise<AuditLog[]> => {
  const { data } = await api.get(`/audit-log/${ledgerId}`);
  return data;
};
