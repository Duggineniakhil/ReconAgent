import { query } from '../db';

/**
 * Full schema migration for ReconAgent.
 * Creates all tables in dependency order.
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
      ledger_id   INT           NOT NULL UNIQUE REFERENCES ledger_records(id),
      bank_txn_id INT           NOT NULL UNIQUE REFERENCES bank_transactions(id),
      method      TEXT          CHECK (method IN ('exact','fuzzy','reasoned','manual')),
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
      ledger_id                 INT       NOT NULL UNIQUE REFERENCES ledger_records(id),
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

  // ── Upgrades for databases created before these constraints existed ──
  // One outcome per ledger record; a bank transaction can only be claimed once.
  // Older versions could double-write outcomes when two runs overlapped, so
  // drop duplicates first: keep the earliest match, and the resolved exception.
  await query(`DELETE FROM matches a USING matches b WHERE a.ledger_id = b.ledger_id AND a.id > b.id`);
  await query(`DELETE FROM matches a USING matches b WHERE a.bank_txn_id = b.bank_txn_id AND a.id > b.id`);
  await query(`
    DELETE FROM exceptions WHERE id IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY ledger_id ORDER BY (status <> 'open') DESC, id) AS rn
        FROM exceptions
      ) ranked WHERE rn > 1
    )
  `);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS matches_ledger_id_key ON matches (ledger_id)`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS matches_bank_txn_id_key ON matches (bank_txn_id)`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS exceptions_ledger_id_key ON exceptions (ledger_id)`);
  await query(`ALTER TABLE matches ALTER COLUMN ledger_id SET NOT NULL, ALTER COLUMN bank_txn_id SET NOT NULL`);
  await query(`ALTER TABLE exceptions ALTER COLUMN ledger_id SET NOT NULL`);
  // Human-approved matches are recorded as 'manual'
  await query(`ALTER TABLE matches DROP CONSTRAINT IF EXISTS matches_method_check`);
  await query(`UPDATE matches SET method = 'manual' WHERE reasoning = 'Manually resolved by user'`);
  await query(`ALTER TABLE matches ADD CONSTRAINT matches_method_check CHECK (method IN ('exact','fuzzy','reasoned','manual'))`);
  console.log('[Migration] ✔ constraints');

  // ── datasets ────────────────────────────────────────────────────────
  // One row per load. The latest row describes the data currently in
  // ledger_records / bank_transactions; only 'demo' data has ground truth.
  await query(`
    CREATE TABLE IF NOT EXISTS datasets (
      id           SERIAL    PRIMARY KEY,
      name         TEXT      NOT NULL,
      source       TEXT      NOT NULL CHECK (source IN ('demo','upload')),
      ledger_count INT       NOT NULL,
      bank_count   INT       NOT NULL,
      created_at   TIMESTAMP DEFAULT now()
    );
  `);
  console.log('[Migration] ✔ datasets');

  // ── runs ────────────────────────────────────────────────────────────
  // A batch reconciliation job. Kept across dataset reloads so runs with
  // different models / prompt versions can be compared.
  await query(`
    CREATE TABLE IF NOT EXISTS runs (
      id             SERIAL    PRIMARY KEY,
      dataset_id     INT       REFERENCES datasets(id) ON DELETE SET NULL,
      status         TEXT      NOT NULL DEFAULT 'running'
                               CHECK (status IN ('running','completed','failed','cancelled','interrupted')),
      model          TEXT      NOT NULL,
      prompt_version TEXT      NOT NULL,
      concurrency    INT       NOT NULL,
      total          INT       NOT NULL,
      processed      INT       NOT NULL DEFAULT 0,
      matched        INT       NOT NULL DEFAULT 0,
      exceptions     INT       NOT NULL DEFAULT 0,
      errors         INT       NOT NULL DEFAULT 0,
      precheck_hits  INT       NOT NULL DEFAULT 0,
      llm_calls      INT       NOT NULL DEFAULT 0,
      input_tokens   INT       NOT NULL DEFAULT 0,
      output_tokens  INT       NOT NULL DEFAULT 0,
      failures       JSONB     NOT NULL DEFAULT '[]',
      metrics        JSONB,
      error          TEXT,
      started_at     TIMESTAMP DEFAULT now(),
      finished_at    TIMESTAMP
    );
  `);
  await query(`ALTER TABLE matches    ADD COLUMN IF NOT EXISTS run_id INT REFERENCES runs(id) ON DELETE SET NULL`);
  await query(`ALTER TABLE exceptions ADD COLUMN IF NOT EXISTS run_id INT REFERENCES runs(id) ON DELETE SET NULL`);
  await query(`ALTER TABLE audit_log  ADD COLUMN IF NOT EXISTS run_id INT REFERENCES runs(id) ON DELETE SET NULL`);
  console.log('[Migration] ✔ runs');

  console.log('[Migration] Schema migration complete — all 7 tables ready.');
}
