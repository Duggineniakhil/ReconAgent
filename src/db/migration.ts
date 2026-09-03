import { query } from '../db';

/**
 * Full schema migration for ReconAgent.
 * Creates all five tables in dependency order.
 * Uses IF NOT EXISTS so this is safe to run repeatedly.
 */
export async function runMigration(): Promise<void> {
  console.log('[Migration] Starting schema migration...');

  // ── ledger_records ──────────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS ledger_records (
      id            SERIAL        PRIMARY KEY,
      invoice_id    TEXT          UNIQUE NOT NULL,
      customer_name TEXT          NOT NULL,
      amount        NUMERIC(12,2) NOT NULL,
      invoice_date  DATE          NOT NULL,
      payment_ref   TEXT
    );
  `);
  console.log('[Migration] ✔ ledger_records');

  // ── bank_transactions ───────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS bank_transactions (
      id         SERIAL        PRIMARY KEY,
      txn_id     TEXT          UNIQUE NOT NULL,
      utr_ref    TEXT,
      amount     NUMERIC(12,2) NOT NULL,
      txn_date   DATE          NOT NULL,
      payer_name TEXT          NOT NULL,
      status     TEXT
    );
  `);
  console.log('[Migration] ✔ bank_transactions');

  // ── matches ─────────────────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS matches (
      id          SERIAL        PRIMARY KEY,
      ledger_id   INT           REFERENCES ledger_records(id),
      bank_txn_id INT           REFERENCES bank_transactions(id),
      method      TEXT          CHECK (method IN ('exact','fuzzy','reasoned')),
      confidence  NUMERIC(4,3)  NOT NULL,
      reasoning   TEXT          NOT NULL,
      created_at  TIMESTAMP     DEFAULT now()
    );
  `);
  console.log('[Migration] ✔ matches');

  // ── exceptions ──────────────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS exceptions (
      id                        SERIAL    PRIMARY KEY,
      ledger_id                 INT       REFERENCES ledger_records(id),
      reason                    TEXT      CHECK (reason IN (
                                            'no_candidate',
                                            'ambiguous_candidates',
                                            'duplicate_reference',
                                            'unexplained_discrepancy'
                                          )),
      best_candidate_bank_txn_id INT      REFERENCES bank_transactions(id),
      reasoning                 TEXT      NOT NULL,
      status                    TEXT      DEFAULT 'open'
                                          CHECK (status IN ('open','approved','rejected')),
      resolved_by               TEXT,
      created_at                TIMESTAMP DEFAULT now()
    );
  `);
  console.log('[Migration] ✔ exceptions');

  // ── audit_log ───────────────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id          SERIAL    PRIMARY KEY,
      ledger_id   INT       REFERENCES ledger_records(id),
      turn_number INT       NOT NULL,
      tool_name   TEXT      NOT NULL,
      tool_input  JSONB     NOT NULL,
      tool_result JSONB,
      created_at  TIMESTAMP DEFAULT now()
    );
  `);
  console.log('[Migration] ✔ audit_log');

  console.log('[Migration] Schema migration complete — all 5 tables ready.');
}
