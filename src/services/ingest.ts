import fs from 'fs';
import path from 'path';
import { query, getClient } from '../db';

/**
 * Parse a simple CSV string into rows of key-value objects.
 * Handles quoted fields (commas inside quotes, escaped double-quotes).
 */
function parseCsv(raw: string): Record<string, string>[] {
  const lines = raw.trim().split('\n').map(l => l.replace(/\r$/, ''));
  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0]);
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] ?? '';
    }
    rows.push(row);
  }
  return rows;
}

/** Parse a single CSV line respecting quoted fields */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++; // skip escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        fields.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }
  fields.push(current);
  return fields;
}

/**
 * Load ledger_records.csv and bank_transactions.csv into the database.
 * Clears existing data first (truncate cascade) for a clean reload.
 */
export async function ingestData(dataDir?: string): Promise<{ ledgerCount: number; bankCount: number }> {
  const dir = dataDir ?? path.resolve(__dirname, '../../data');

  const ledgerCsv = fs.readFileSync(path.join(dir, 'ledger_records.csv'), 'utf-8');
  const bankCsv   = fs.readFileSync(path.join(dir, 'bank_transactions.csv'), 'utf-8');

  const ledgerRows = parseCsv(ledgerCsv);
  const bankRows   = parseCsv(bankCsv);

  const client = await getClient();

  try {
    await client.query('BEGIN');

    // Truncate in dependency order (children first)
    await client.query('TRUNCATE audit_log, exceptions, matches, bank_transactions, ledger_records CASCADE');

    // ── Insert ledger records ─────────────────────────────────────────
    for (const row of ledgerRows) {
      await client.query(
        `INSERT INTO ledger_records (invoice_id, customer_name, amount, invoice_date, payment_ref)
         VALUES ($1, $2, $3, $4, $5)`,
        [row.invoice_id, row.customer_name, row.amount, row.invoice_date, row.payment_ref],
      );
    }

    // ── Insert bank transactions ──────────────────────────────────────
    for (const row of bankRows) {
      await client.query(
        `INSERT INTO bank_transactions (txn_id, utr_ref, amount, txn_date, payer_name, status)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [row.txn_id, row.utr_ref, row.amount, row.txn_date, row.payer_name, row.status],
      );
    }

    await client.query('COMMIT');

    return { ledgerCount: ledgerRows.length, bankCount: bankRows.length };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
