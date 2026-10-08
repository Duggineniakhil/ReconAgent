/**
 * CSV import: parsing, column mapping and row validation for user uploads.
 *
 * Bank statements and ledger exports all name their columns differently, so
 * an upload is (1) parsed, (2) mapped from file columns to our fields — with
 * suggestions from common header synonyms — and (3) validated row by row.
 */

// ═══════════════════════════════════════════════════════════════════════
//  CSV PARSING
// ═══════════════════════════════════════════════════════════════════════

/**
 * Parse CSV text into an array of rows (arrays of fields).
 * Handles quoted fields with commas, escaped quotes and newlines, CRLF, and a BOM.
 * Fully blank lines are skipped.
 */
export function parseCsvRows(raw: string): string[][] {
  const text = raw.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  const endRow = () => {
    row.push(field);
    if (row.length > 1 || row[0].trim() !== '') rows.push(row);
    row = [];
    field = '';
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      endRow();
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) endRow();
  return rows;
}

/** Parse CSV text into objects keyed by the (trimmed) header row. */
export function parseCsv(raw: string): Record<string, string>[] {
  const [header, ...rows] = parseCsvRows(raw);
  if (!header) return [];
  const keys = header.map((h) => h.trim());
  return rows.map((values) => Object.fromEntries(keys.map((k, j) => [k, values[j] ?? ''])));
}

// ═══════════════════════════════════════════════════════════════════════
//  FIELD DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════

export type FieldType = 'text' | 'amount' | 'date';

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  /** Lower-case header names that probably mean this field. */
  synonyms: string[];
}

export const LEDGER_FIELDS: FieldDef[] = [
  { key: 'invoice_id', label: 'Invoice ID', type: 'text', required: true,
    synonyms: ['invoice_id', 'invoice id', 'invoice no', 'invoice number', 'invoice', 'inv no', 'bill no', 'document no', 'voucher no'] },
  { key: 'customer_name', label: 'Customer name', type: 'text', required: true,
    synonyms: ['customer_name', 'customer name', 'customer', 'party name', 'party', 'client', 'client name', 'name', 'buyer'] },
  { key: 'amount', label: 'Amount', type: 'amount', required: true,
    synonyms: ['amount', 'invoice amount', 'total', 'total amount', 'grand total', 'net amount', 'amount (inr)', 'value'] },
  { key: 'invoice_date', label: 'Invoice date', type: 'date', required: true,
    synonyms: ['invoice_date', 'invoice date', 'date', 'bill date', 'document date', 'voucher date'] },
  { key: 'payment_ref', label: 'Payment reference', type: 'text', required: false,
    synonyms: ['payment_ref', 'payment ref', 'payment reference', 'reference', 'ref', 'ref no', 'utr', 'utr no', 'transaction ref'] },
];

export const BANK_FIELDS: FieldDef[] = [
  { key: 'txn_id', label: 'Transaction ID', type: 'text', required: false,
    synonyms: ['txn_id', 'txn id', 'transaction id', 'transaction_id', 'tran id', 'payment id', 'id'] },
  { key: 'utr_ref', label: 'UTR / reference', type: 'text', required: false,
    synonyms: ['utr_ref', 'utr', 'utr no', 'utr number', 'reference', 'ref no', 'ref no./cheque no.', 'chq/ref no', 'cheque no', 'rrn', 'bank reference'] },
  { key: 'amount', label: 'Amount', type: 'amount', required: true,
    synonyms: ['amount', 'credit', 'credit amount', 'deposit', 'deposit amt', 'cr amount', 'amount (inr)', 'transaction amount'] },
  { key: 'txn_date', label: 'Transaction date', type: 'date', required: true,
    synonyms: ['txn_date', 'txn date', 'transaction date', 'date', 'value date', 'tran date', 'posting date', 'settlement date'] },
  { key: 'payer_name', label: 'Payer name', type: 'text', required: true,
    synonyms: ['payer_name', 'payer name', 'payer', 'remitter', 'remitter name', 'name', 'description', 'narration', 'particulars'] },
  { key: 'status', label: 'Status', type: 'text', required: false,
    synonyms: ['status', 'txn status', 'transaction status'] },
];

/** field key → CSV header (or null when unmapped) */
export type ColumnMapping = Record<string, string | null>;

// Ignore case and punctuation: 'Chq./Ref.No.' and 'chq ref no' compare equal
const normaliseHeader = (h: string) => h.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Suggest a header for each field: exact synonym matches first, then headers
 * containing a synonym. Each header is used at most once.
 */
export function suggestMapping(headers: string[], fields: FieldDef[]): ColumnMapping {
  const mapping: ColumnMapping = {};
  const used = new Set<string>();
  const norm = headers.map(normaliseHeader);

  const pick = (field: FieldDef, test: (h: string, syn: string) => boolean) => {
    for (const syn of field.synonyms.map(normaliseHeader)) {
      const idx = norm.findIndex((h, i) => !used.has(headers[i]) && test(h, syn));
      if (idx !== -1) return headers[idx];
    }
    return null;
  };

  for (const field of fields) mapping[field.key] = null;
  for (const pass of [(h: string, s: string) => h === s, (h: string, s: string) => s.length > 2 && h.includes(s)]) {
    for (const field of fields) {
      if (mapping[field.key]) continue;
      const header = pick(field, pass);
      if (header) {
        mapping[field.key] = header;
        used.add(header);
      }
    }
  }
  return mapping;
}

// ═══════════════════════════════════════════════════════════════════════
//  VALUE PARSING
// ═══════════════════════════════════════════════════════════════════════

/**
 * Parse an amount as written in Indian bank/ledger exports:
 * "₹1,23,456.70", "Rs. 500", "INR 1,000", "(250.00)" (negative), "1,000 Cr".
 * Returns null if it isn't a number.
 */
export function parseAmount(raw: string): number | null {
  let s = raw.trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (/\bdr\.?$/i.test(s)) negative = true;
  s = s.replace(/\b(cr|dr)\.?$/i, '').replace(/₹|\brs\.?|\binr\b/gi, '').replace(/[,\s]/g, '');
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  }
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const value = Math.round(parseFloat(s) * 100) / 100;
  return negative ? -value : value;
}

export type DateFormat = 'auto' | 'YMD' | 'DMY' | 'MDY';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function toIso(y: number, m: number, d: number): string | null {
  if (y < 100) y += 2000;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Parse a date to 'YYYY-MM-DD'. Accepts 2026-08-07, 07/08/2026, 07-08-26,
 * 07-Aug-2026, 7 Aug 2026 (a trailing time is ignored). Numeric day/month
 * order follows `format`; 'auto' assumes day-first unless the year leads.
 */
export function parseDate(raw: string, format: DateFormat = 'auto'): string | null {
  const s = raw.trim().replace(/[T\s]\d{1,2}:\d{2}(:\d{2})?.*$/, '');

  // Month names: 07-Aug-2026, 7 Aug 2026, 07/Aug/26
  const named = s.match(/^(\d{1,2})[\s\-/.]([A-Za-z]{3,9})[\s\-/.,]+(\d{2,4})$/);
  if (named) {
    const m = MONTHS.indexOf(named[2].slice(0, 3).toLowerCase()) + 1;
    return m ? toIso(+named[3], m, +named[1]) : null;
  }

  const parts = s.match(/^(\d{1,4})[\-/.](\d{1,2})[\-/.](\d{1,4})$/);
  if (!parts) return null;
  const [a, b, c] = [parts[1], parts[2], parts[3]];

  if (a.length === 4 || format === 'YMD') return toIso(+a, +b, +c);
  if (format === 'MDY') return toIso(+c, +a, +b);
  return toIso(+c, +b, +a); // DMY (auto default — Indian exports)
}

// ═══════════════════════════════════════════════════════════════════════
//  ROW MAPPING + VALIDATION
// ═══════════════════════════════════════════════════════════════════════

export interface RowError {
  /** 1-based line number in the file, counting the header as line 1. */
  row: number;
  field: string;
  message: string;
}

export interface MappedRows {
  records: Record<string, string | number | null>[];
  errors: RowError[];
  /** Rows dropped because `skipIfEmpty` was blank. */
  skipped: number;
}

/**
 * Apply a column mapping to parsed rows, converting amounts and dates and
 * reporting every invalid value with its row number.
 *
 * Rows where the `skipIfEmpty` field is blank are dropped rather than
 * rejected: bank statements put withdrawals and deposits in separate
 * columns, so with "Deposit" mapped as the amount, withdrawal rows are empty.
 */
export function mapRows(
  rows: Record<string, string>[],
  mapping: ColumnMapping,
  fields: FieldDef[],
  dateFormat: DateFormat = 'auto',
  skipIfEmpty?: string,
): MappedRows {
  const errors: RowError[] = [];

  for (const field of fields) {
    if (field.required && !mapping[field.key]) {
      errors.push({ row: 1, field: field.key, message: `${field.label} is required: choose a column for it` });
    }
  }
  if (errors.length) return { records: [], errors, skipped: 0 };

  const skipHeader = skipIfEmpty ? mapping[skipIfEmpty] : null;
  let skipped = 0;
  const records: Record<string, string | number | null>[] = [];

  rows.forEach((row, i) => {
    const line = i + 2;
    if (skipHeader && !(row[skipHeader] ?? '').trim()) {
      skipped++;
      return;
    }
    const record: Record<string, string | number | null> = {};

    for (const field of fields) {
      const header = mapping[field.key];
      const raw = header ? (row[header] ?? '').trim() : '';

      if (!raw) {
        if (field.required) errors.push({ row: line, field: field.key, message: `${field.label} is empty` });
        record[field.key] = null;
        continue;
      }

      if (field.type === 'amount') {
        const value = parseAmount(raw);
        if (value === null) errors.push({ row: line, field: field.key, message: `"${raw}" is not an amount` });
        record[field.key] = value;
      } else if (field.type === 'date') {
        const value = parseDate(raw, dateFormat);
        if (value === null) errors.push({ row: line, field: field.key, message: `"${raw}" is not a valid date` });
        record[field.key] = value;
      } else {
        record[field.key] = raw;
      }
    }
    records.push(record);
  });

  return { records, errors, skipped };
}

/** Report values of `key` that appear more than once (e.g. invoice IDs). */
export function findDuplicates(records: Record<string, unknown>[], key: string, label: string): RowError[] {
  const seen = new Map<unknown, number>();
  const errors: RowError[] = [];
  records.forEach((r, i) => {
    const value = r[key];
    if (value === null || value === undefined) return;
    const first = seen.get(value);
    if (first !== undefined) {
      errors.push({ row: i + 2, field: key, message: `${label} "${value}" duplicates row ${first}` });
    } else {
      seen.set(value, i + 2);
    }
  });
  return errors;
}
