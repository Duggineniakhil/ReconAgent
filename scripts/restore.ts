import { getClient, closePool } from '../src/db';
import { runMigration } from '../src/db/migration';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Restores database_backup.json (written by backup_and_clear.ts).
 * Replaces all existing data, inside a single transaction.
 */
async function run() {
  const backupPath = path.join(__dirname, '..', 'database_backup.json');
  if (!fs.existsSync(backupPath)) {
    console.error('Backup file not found at', backupPath);
    process.exit(1);
  }

  console.log('Reading backup...');
  const data = JSON.parse(fs.readFileSync(backupPath, 'utf8'));

  await runMigration();
  const client = await getClient();

  try {
    await client.query('BEGIN');
    await client.query(`TRUNCATE audit_log, exceptions, matches, settlement_matches, gateway_transactions,
                        bank_transactions, ledger_records CASCADE`);

    for (const r of data.ledger_records) {
      await client.query(
        `INSERT INTO ledger_records (id, invoice_id, customer_name, amount, invoice_date, payment_ref)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [r.id, r.invoice_id, r.customer_name, r.amount, r.invoice_date, r.payment_ref],
      );
    }

    for (const r of data.bank_transactions) {
      await client.query(
        `INSERT INTO bank_transactions (id, txn_id, utr_ref, amount, txn_date, payer_name, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [r.id, r.txn_id, r.utr_ref, r.amount, r.txn_date, r.payer_name, r.status],
      );
    }

    // Older backups predate gateway support
    for (const r of data.gateway_transactions ?? []) {
      await client.query(
        `INSERT INTO gateway_transactions
           (id, provider, entity_id, entity_type, amount, fee, tax, credit, debit, currency, method, order_id,
            order_receipt, payment_id, description, notes, settled, settlement_id, settlement_utr, created_at, settled_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)`,
        [r.id, r.provider, r.entity_id, r.entity_type, r.amount, r.fee, r.tax, r.credit, r.debit, r.currency,
         r.method, r.order_id, r.order_receipt, r.payment_id, r.description,
         r.notes == null ? null : JSON.stringify(r.notes), r.settled, r.settlement_id, r.settlement_utr,
         r.created_at, r.settled_at],
      );
    }

    // Timestamps are passed as Date objects so pg writes them in local time,
    // matching how the TIMESTAMP (without time zone) columns were read.
    for (const r of data.matches) {
      await client.query(
        `INSERT INTO matches (id, ledger_id, bank_txn_id, gateway_txn_id, method, confidence, reasoning, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [r.id, r.ledger_id, r.bank_txn_id, r.gateway_txn_id ?? null, r.method, r.confidence, r.reasoning, new Date(r.created_at)],
      );
    }

    for (const r of data.exceptions) {
      await client.query(
        `INSERT INTO exceptions (id, ledger_id, reason, best_candidate_bank_txn_id, best_candidate_gateway_txn_id,
                                 reasoning, status, resolved_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [r.id, r.ledger_id, r.reason, r.best_candidate_bank_txn_id, r.best_candidate_gateway_txn_id ?? null,
         r.reasoning, r.status, r.resolved_by, new Date(r.created_at)],
      );
    }

    for (const r of data.settlement_matches ?? []) {
      await client.query(
        `INSERT INTO settlement_matches
           (id, settlement_id, settlement_utr, status, bank_txn_id, expected_amount, bank_amount, difference, reasoning, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [r.id, r.settlement_id, r.settlement_utr, r.status, r.bank_txn_id, r.expected_amount, r.bank_amount,
         r.difference, r.reasoning, new Date(r.created_at)],
      );
    }

    for (const r of data.audit_log) {
      await client.query(
        `INSERT INTO audit_log (id, ledger_id, turn_number, tool_name, tool_input, tool_result, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [r.id, r.ledger_id, r.turn_number, r.tool_name, JSON.stringify(r.tool_input), JSON.stringify(r.tool_result), new Date(r.created_at)],
      );
    }

    // The backup holds the synthetic demo data, so it is scored against ground truth
    await client.query(
      `INSERT INTO datasets (name, source, ledger_count, bank_count) VALUES ($1, 'demo', $2, $3)`,
      ['Demo dataset (restored backup)', data.ledger_records.length, data.bank_transactions.length],
    );

    // Move sequences past the restored ids
    for (const table of ['ledger_records', 'bank_transactions', 'gateway_transactions', 'matches', 'exceptions', 'settlement_matches', 'audit_log']) {
      await client.query(
        `SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 0) + 1, false)`,
      );
    }

    await client.query('COMMIT');
    console.log('Database restored successfully!');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    process.exitCode = 1;
  } finally {
    client.release();
    await closePool();
  }
}

run();
