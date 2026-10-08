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
      bank_txn_id INT           UNIQUE REFERENCES bank_transactions(id),
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
  // bank_txn_id stays nullable: a match may point at a gateway payment instead (see below)
  await query(`ALTER TABLE matches ALTER COLUMN ledger_id SET NOT NULL`);
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

  // ── gateway_transactions ────────────────────────────────────────────
  // Lines of a payment gateway's settlement report (Razorpay recon API):
  // payments, refunds, transfers and adjustments, converted to rupees.
  // For a payment, credit = amount - fee (fee includes GST; tax is the GST part).
  await query(`
    CREATE TABLE IF NOT EXISTS gateway_transactions (
      id             SERIAL        PRIMARY KEY,
      provider       TEXT          NOT NULL DEFAULT 'razorpay',
      entity_id      TEXT          UNIQUE NOT NULL,
      entity_type    TEXT          NOT NULL CHECK (entity_type IN ('payment','refund','transfer','adjustment')),
      amount         NUMERIC(12,2) NOT NULL,
      fee            NUMERIC(12,2) NOT NULL DEFAULT 0,
      tax            NUMERIC(12,2) NOT NULL DEFAULT 0,
      credit         NUMERIC(12,2) NOT NULL DEFAULT 0,
      debit          NUMERIC(12,2) NOT NULL DEFAULT 0,
      currency       TEXT          NOT NULL DEFAULT 'INR',
      method         TEXT,
      order_id       TEXT,
      order_receipt  TEXT,
      payment_id     TEXT,
      description    TEXT,
      notes          JSONB,
      settled        BOOLEAN       NOT NULL DEFAULT false,
      settlement_id  TEXT,
      settlement_utr TEXT,
      created_at     TIMESTAMPTZ   NOT NULL,
      settled_at     TIMESTAMPTZ
    );
  `);
  await query(`CREATE INDEX IF NOT EXISTS gateway_transactions_settlement_idx ON gateway_transactions (settlement_id)`);
  await query(`CREATE INDEX IF NOT EXISTS gateway_transactions_receipt_idx ON gateway_transactions (order_receipt)`);
  console.log('[Migration] ✔ gateway_transactions');

  // ── settlement_matches ──────────────────────────────────────────────
  // Outcome of matching each gateway settlement to the bank credit it produced.
  await query(`
    CREATE TABLE IF NOT EXISTS settlement_matches (
      id              SERIAL        PRIMARY KEY,
      settlement_id   TEXT          UNIQUE NOT NULL,
      settlement_utr  TEXT,
      status          TEXT          NOT NULL CHECK (status IN ('matched','mismatch','missing')),
      bank_txn_id     INT           UNIQUE REFERENCES bank_transactions(id),
      expected_amount NUMERIC(12,2) NOT NULL,
      bank_amount     NUMERIC(12,2),
      difference      NUMERIC(12,2),
      reasoning       TEXT          NOT NULL,
      run_id          INT           REFERENCES runs(id) ON DELETE SET NULL,
      created_at      TIMESTAMP     DEFAULT now()
    );
  `);
  console.log('[Migration] ✔ settlement_matches');

  // ── Invoices can be matched to a gateway payment instead of a bank txn ──
  await query(`ALTER TABLE matches ADD COLUMN IF NOT EXISTS gateway_txn_id INT REFERENCES gateway_transactions(id)`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS matches_gateway_txn_id_key ON matches (gateway_txn_id)`);
  await query(`ALTER TABLE matches ALTER COLUMN bank_txn_id DROP NOT NULL`);
  await query(`ALTER TABLE matches DROP CONSTRAINT IF EXISTS matches_target_check`);
  await query(`ALTER TABLE matches ADD CONSTRAINT matches_target_check CHECK (num_nonnulls(bank_txn_id, gateway_txn_id) = 1)`);
  await query(`ALTER TABLE exceptions ADD COLUMN IF NOT EXISTS best_candidate_gateway_txn_id INT REFERENCES gateway_transactions(id)`);

  // Who owns each bank credit: an invoice (direct match) or a gateway settlement
  await query(`
    CREATE OR REPLACE VIEW bank_claims AS
      SELECT m.bank_txn_id, l.invoice_id AS claimed_by
      FROM matches m JOIN ledger_records l ON l.id = m.ledger_id
      WHERE m.bank_txn_id IS NOT NULL
      UNION ALL
      SELECT s.bank_txn_id, 'settlement ' || s.settlement_id
      FROM settlement_matches s
      WHERE s.bank_txn_id IS NOT NULL
  `);

  // A bank credit claimed by a settlement can't also be matched to an invoice
  // (each table's own UNIQUE index covers claims within that table).
  await query(`
    CREATE OR REPLACE FUNCTION prevent_double_bank_claim() RETURNS trigger AS $$
    BEGIN
      IF NEW.bank_txn_id IS NULL THEN
        RETURN NEW;
      END IF;
      IF TG_TABLE_NAME = 'matches'
         AND EXISTS (SELECT 1 FROM settlement_matches WHERE bank_txn_id = NEW.bank_txn_id) THEN
        RAISE EXCEPTION 'bank transaction % is already claimed by a settlement', NEW.bank_txn_id
          USING ERRCODE = 'unique_violation';
      END IF;
      IF TG_TABLE_NAME = 'settlement_matches'
         AND EXISTS (SELECT 1 FROM matches WHERE bank_txn_id = NEW.bank_txn_id) THEN
        RAISE EXCEPTION 'bank transaction % is already matched to an invoice', NEW.bank_txn_id
          USING ERRCODE = 'unique_violation';
      END IF;
      RETURN NEW;
    END
    $$ LANGUAGE plpgsql
  `);
  for (const table of ['matches', 'settlement_matches']) {
    await query(`DROP TRIGGER IF EXISTS ${table}_bank_claim ON ${table}`);
    await query(`
      CREATE TRIGGER ${table}_bank_claim
      BEFORE INSERT OR UPDATE OF bank_txn_id ON ${table}
      FOR EACH ROW EXECUTE FUNCTION prevent_double_bank_claim()
    `);
  }

  // Runs record what they did with settlements
  await query(`ALTER TABLE runs ADD COLUMN IF NOT EXISTS settlements JSONB`);
  console.log('[Migration] ✔ gateway matching');

  console.log('[Migration] Schema migration complete — all 9 tables ready.');
}
