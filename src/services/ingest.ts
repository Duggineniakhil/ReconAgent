import fs from 'fs';
import path from 'path';
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../db';
import config from '../config';
import {
  parseCsv,
  mapRows,
  findDuplicates,
  LEDGER_FIELDS,
  BANK_FIELDS,
  type ColumnMapping,
  type DateFormat,
  type RowError,
} from './csv_import';

export { parseCsv } from './csv_import';

export interface LedgerInput {
  invoice_id: string;
  customer_name: string;
  amount: number | string;
  invoice_date: string;
  payment_ref: string | null;
}

export interface BankInput {
  txn_id: string;
  utr_ref: string | null;
  amount: number | string;
  txn_date: string;
  payer_name: string;
  status: string | null;
}

export interface DatasetInfo {
  id: number;
  name: string;
  source: 'demo' | 'upload';
  ledger_count: number;
  bank_count: number;
  created_at: string;
}

/**
 * Replace all ledger/bank data (and every outcome derived from it) with a new
 * dataset, in one transaction. Runs are kept: they hold their own metrics.
 */
export async function loadDataset(
  name: string,
  source: 'demo' | 'upload',
  ledger: LedgerInput[],
  bank: BankInput[],
): Promise<DatasetInfo> {
  return withTransaction(async (client: PoolClient) => {
    await client.query('TRUNCATE audit_log, exceptions, matches, bank_transactions, ledger_records RESTART IDENTITY CASCADE');

    // Bulk insert via unnest: one round trip per table regardless of size
    await client.query(
      `INSERT INTO ledger_records (invoice_id, customer_name, amount, invoice_date, payment_ref)
       SELECT * FROM unnest($1::text[], $2::text[], $3::numeric[], $4::date[], $5::text[])`,
      [
        ledger.map((r) => r.invoice_id),
        ledger.map((r) => r.customer_name),
        ledger.map((r) => r.amount),
        ledger.map((r) => r.invoice_date),
        ledger.map((r) => r.payment_ref || null),
      ],
    );
    await client.query(
      `INSERT INTO bank_transactions (txn_id, utr_ref, amount, txn_date, payer_name, status)
       SELECT * FROM unnest($1::text[], $2::text[], $3::numeric[], $4::date[], $5::text[], $6::text[])`,
      [
        bank.map((r) => r.txn_id),
        bank.map((r) => r.utr_ref || null),
        bank.map((r) => r.amount),
        bank.map((r) => r.txn_date),
        bank.map((r) => r.payer_name),
        bank.map((r) => r.status || null),
      ],
    );

    const result = await client.query<DatasetInfo>(
      `INSERT INTO datasets (name, source, ledger_count, bank_count)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [name, source, ledger.length, bank.length],
    );
    return result.rows[0];
  });
}

/** The dataset currently loaded (latest load), or null if none recorded. */
export async function currentDataset(client?: PoolClient): Promise<DatasetInfo | null> {
  const sql = `SELECT * FROM datasets ORDER BY id DESC LIMIT 1`;
  const result = client ? await client.query<DatasetInfo>(sql) : await query<DatasetInfo>(sql);
  return result.rows[0] ?? null;
}

/**
 * Load the synthetic demo dataset (ledger_records.csv + bank_transactions.csv)
 * from the data folder. Only this dataset is scored against ground_truth.json.
 */
export async function ingestData(dataDir?: string): Promise<{ ledgerCount: number; bankCount: number; dataset: DatasetInfo }> {
  const dir = dataDir ?? config.dataDir;

  const ledgerRows = parseCsv(fs.readFileSync(path.join(dir, 'ledger_records.csv'), 'utf-8'));
  const bankRows = parseCsv(fs.readFileSync(path.join(dir, 'bank_transactions.csv'), 'utf-8'));

  const dataset = await loadDataset(
    'Demo dataset (synthetic)',
    'demo',
    ledgerRows as unknown as LedgerInput[],
    bankRows as unknown as BankInput[],
  );
  return { ledgerCount: ledgerRows.length, bankCount: bankRows.length, dataset };
}

// ═══════════════════════════════════════════════════════════════════════
//  UPLOADS
// ═══════════════════════════════════════════════════════════════════════

export interface UploadFile {
  csv: string;
  mapping: ColumnMapping;
}

export interface UploadRequest {
  name?: string;
  dateFormat?: DateFormat;
  ledger: UploadFile;
  bank: UploadFile;
}

export interface FileErrors {
  file: 'ledger' | 'bank';
  errors: RowError[];
}

/** Errors reported per file are capped so a bad file doesn't produce a huge response. */
const MAX_ERRORS = 50;

/**
 * Validate an upload and, if every row is valid, load it as the current dataset.
 * Nothing is written when there are errors.
 */
export async function importUpload(
  req: UploadRequest,
): Promise<{ ok: true; dataset: DatasetInfo; skipped: number } | { ok: false; errors: FileErrors[] }> {
  const dateFormat = req.dateFormat ?? 'auto';

  const ledgerRows = parseCsv(req.ledger.csv);
  const bankRows = parseCsv(req.bank.csv);

  const ledger = mapRows(ledgerRows, req.ledger.mapping, LEDGER_FIELDS, dateFormat);
  // Withdrawal rows have no deposit amount: skip them instead of rejecting the file
  const bank = mapRows(bankRows, req.bank.mapping, BANK_FIELDS, dateFormat, 'amount');

  // Bank statements often have no transaction ID column: number the rows
  bank.records.forEach((r, i) => {
    if (!r.txn_id) r.txn_id = `BANK-${String(i + 1).padStart(5, '0')}`;
  });

  const ledgerErrors = [
    ...ledger.errors,
    ...(ledgerRows.length === 0 ? [{ row: 1, field: '', message: 'File has no data rows' }] : []),
    ...findDuplicates(ledger.records, 'invoice_id', 'Invoice ID'),
  ];
  const bankErrors = [
    ...bank.errors,
    ...(bank.records.length === 0 && !bank.errors.length ? [{ row: 1, field: '', message: 'File has no rows with an amount' }] : []),
    ...findDuplicates(bank.records, 'txn_id', 'Transaction ID'),
  ];

  const errors: FileErrors[] = [];
  if (ledgerErrors.length) errors.push({ file: 'ledger', errors: ledgerErrors.slice(0, MAX_ERRORS) });
  if (bankErrors.length) errors.push({ file: 'bank', errors: bankErrors.slice(0, MAX_ERRORS) });
  if (errors.length) return { ok: false, errors };

  const dataset = await loadDataset(
    req.name?.trim() || 'Uploaded dataset',
    'upload',
    ledger.records as unknown as LedgerInput[],
    bank.records as unknown as BankInput[],
  );
  return { ok: true, dataset, skipped: bank.skipped };
}
