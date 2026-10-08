<div align="center">
  <h1>ReconAgent 🤖💼</h1>
  <p><strong>AI-powered financial reconciliation system</strong></p>
  
  [![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)
  [![React](https://img.shields.io/badge/React-19-blue.svg)](https://reactjs.org/)
  [![PostgreSQL](https://img.shields.io/badge/PostgreSQL-14+-blue.svg)](https://www.postgresql.org/)
  [![Gemini](https://img.shields.io/badge/AI-Gemini%203.8%20Flash-orange.svg)](https://aistudio.google.com/)
  [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
</div>

<br/>

ReconAgent is an AI-powered financial reconciliation system that automates the tedious process of matching ledger records (e.g., invoices) against bank transactions. Instead of relying solely on brittle, hardcoded exact-match rules, ReconAgent employs a Large Language Model (Gemini 3.8 Flash) equipped with specialized tools to autonomously investigate and resolve complex financial discrepancies.

## 🌟 The Problem & Our Solution
Financial reconciliation typically requires human intervention when records don't perfectly align due to:
- **Rounding differences** or FX discrepancies.
- **Date drift** (delays between invoice and payment settlement).
- **Name variants** or abbreviations (e.g., "Acme Corp" vs. "Acme Corporation").
- **Missing transactions** or duplicate reference numbers (fraud prevention).

**ReconAgent** solves this by mimicking a human accountant's thought process. It uses an autonomous agent loop that queries the database, calculates similarities, checks for fraud heuristics, and makes reasoned decisions about whether to approve a match or flag it for manual review.

## 🏗️ Architecture

ReconAgent is built with a modern stack featuring a Node.js/Express API, PostgreSQL database, and a Vite + React + Tailwind frontend. The AI agent runs as an event loop powered by **Gemini 3.8 Flash** (configurable via `GEMINI_MODEL`).

> **Note on Efficiency:** The architecture includes an **Exact-Match Precheck**. Before invoking the LLM, the system queries the database for trivial exact matches (perfect reference and amount alignment). If found, it bypasses the LLM entirely, saving tokens, cost, and latency for obvious reconciliations.

```mermaid
graph TD
    subgraph Data Layer
        DB[(PostgreSQL)]
        DB --> D[datasets]
        DB --> L[ledger_records]
        DB --> B[bank_transactions]
        DB --> R[runs]
        DB --> M[matches]
        DB --> E[exceptions]
        DB --> A[audit_log]
    end

    subgraph Backend API (Node.js/Express)
        Upload[POST /api/datasets/preview + /upload]
        Ingest[POST /api/ingest]
        Runs[POST /api/runs]
        Events[GET /api/runs/:id/events SSE]
        Metrics[GET /api/metrics]
        Review[GET /api/exceptions, /matches, /audit-log<br/>POST /api/exceptions/:id/resolve]
    end

    subgraph Run Worker
        Pool[Worker pool + rate limiter + retry]
        Precheck{Exact Match Precheck}
        Agent(Gemini 3.8 Flash)
        Agent -->|Tool Call| T1[find_exact_candidates]
        Agent -->|Tool Call| T2[find_fuzzy_candidates]
        Agent -->|Tool Call| T3[compare_names]
        Agent -->|Tool Call| T4[check_duplicate_ref]
        Agent -->|Terminal| Guard{Server guardrails}
        Guard --> Commit[commit_match / flag_exception]
    end

    subgraph Frontend (React/Vite/Tailwind v4)
        Dash[Dashboard & live run progress]
        UP[CSV upload + column mapping]
        RV[Runs history]
        EQ[Exceptions Queue]
        MV[Matches View]
        Trace[Investigation Trace Modal]
    end

    Upload --> DB
    Ingest --> DB
    Runs --> Pool
    Pool --> Precheck
    Precheck -->|Match| DB
    Precheck -->|Miss| Agent
    Agent <--> DB
    Pool -->|progress| Events
    Metrics --> DB
    Review --> DB

    UP --> Upload
    Dash --> Ingest
    Dash --> Runs
    Dash --> Events
    Dash --> Metrics
    RV --> Runs
    EQ --> Review
    MV --> Review
    Trace --> Review
```

## 🛡️ Guardrails

The model proposes; the server decides. Every `commit_match` is re-checked against the database before anything is written, and becomes an exception (logged as a `guardrail_override` step in the trace) if:

- the bank transaction doesn't exist,
- it is already matched to another invoice,
- its reference appears on more than one bank transaction,
- confidence is below **0.85**, or
- the amount differs by more than **1%**.

The schema backs this up: each ledger record has at most one match and one exception, and each bank transaction can be matched only once. Each record's outcome and its audit rows are written in one transaction. The agent gets at most **6 investigative tool calls** per record, and runs and data loads can't overlap. Matches approved by a human reviewer are stored with method `manual` and excluded from the agent's metrics.

## ⚙️ Reconciliation Runs

**Start run** on the dashboard (or `POST /api/runs` with an optional `limit` and `concurrency`) creates a background run over all pending records and returns immediately. While it works:

- **Live progress** streams to the dashboard over Server-Sent Events (`GET /api/runs/:id/events`): records processed, matched, exceptions, errors, precheck hits, LLM calls and tokens, plus an ETA. Runs can be stopped mid-way.
- **Gemini calls are rate-limited** process-wide (`GEMINI_RPM`, default 15 for the free tier) and **retried with exponential backoff** on 429, 5xx and network errors. Other errors (e.g. a bad API key) fail the record without retrying, and a run stops itself after 5 consecutive failures.
- **Every run is kept** with its model, a hash of the prompt and tool schemas (`prompt_version`), token usage and final metrics, so you can compare how prompt or model changes affect accuracy on the **Runs** tab. Matches, exceptions and trace steps are tagged with the run that produced them.
- If the server stops mid-run, the run is marked `interrupted` on the next start, and its unprocessed records stay pending for the next run.

## 📤 Uploading Your Own Data

**Upload CSVs** takes an invoice export and a bank statement:

1. **Preview:** ReconAgent reads the headers and suggests which column holds each field (invoice number, party name, amount, date, UTR/reference…), recognising common names from Tally-style exports and Indian bank statements.
2. **Map:** confirm or change each column, with sample values shown alongside. If there is no transaction ID column, rows are numbered automatically.
3. **Import:** every row is validated first. Amounts like `₹1,23,456.70`, `Rs. 500` or `(250.00)` and dates like `07/08/2026`, `07-Aug-26` or `2026-08-07` are understood. Any invalid row blocks the import and is reported with its line number. Statement rows with no deposit amount (withdrawals) are skipped.

Try it with [`data/samples/`](data/samples/). Uploaded data has no answer key, so precision and recall are shown only for the demo dataset.

## 🚀 How to Run Locally

### Option A: Docker
```bash
cp .env.example .env   # then set GEMINI_API_KEY
docker compose up --build
```
Dashboard: `http://localhost:5173` · API: `http://localhost:3000` · Postgres is exposed on host port `5433`.

### Option B: Manual

**Prerequisites:** Node.js 20+, a running PostgreSQL 14+ instance, and a [Gemini API key](https://aistudio.google.com/apikey).

1. **Environment.** Copy `.env.example` to `.env` and fill it in:
   ```
   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/reconagent
   GEMINI_API_KEY=your_gemini_api_key
   GEMINI_MODEL=gemini-3.8-flash
   ```
   Optional: `GEMINI_RPM` (default 15) and `RUN_CONCURRENCY` (default 2).
2. **Backend** (runs on `http://localhost:3000`, migrations run on startup):
   ```bash
   npm install
   npm run dev
   ```
3. **Frontend** (runs on `http://localhost:5173`; set `VITE_API_URL` in `client/.env` if the API isn't on port 3000):
   ```bash
   cd client
   npm install
   npm run dev
   ```

## ✅ Tests

```bash
npm test
```
Unit tests cover the guardrails, metrics, name comparison and CSV parsing. Integration tests run the real agent loop against Postgres with a scripted fake Gemini (precheck, guardrail overrides, double-claim prevention, tool-call budget). They run only when `TEST_DATABASE_URL` points at a **disposable** database, because they truncate every table:

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/reconagent_test npm test
```

## 💾 Backup & Restore

`npm run db:backup` writes all tables to `database_backup.json` and then **clears the database**. `npm run db:restore` loads that file back.

## 🧪 How to Run the Generator
To populate the database with synthetic testing data, you must generate the CSV files. 

Run the data generation script from the root directory:
```bash
npm run generate-data
```
This script uses a fixed random seed to generate ~70 ledger records and ~75 bank transactions, explicitly crafting edge cases like rounding differences, date drift, and name variants. The data is written to the `data/` folder as `ledger_records.csv`, `bank_transactions.csv`, and `ground_truth.json`.

You can then load this data from the dashboard with **"Load demo data"**, which replaces the current dataset.

## 📊 How Metrics are Computed
`/api/metrics` scores the **agent's own decisions** against the `ground_truth.json` answer key produced by the generator. Manual (human) matches are excluded, and records the agent hasn't processed yet are reported as `pending_records` instead of being counted as errors.

Precision and recall are **pair-level**:
- **True Positive (TP)**: matched to the expected bank transaction.
- **False Positive (FP)**: matched to the wrong transaction, or matched a record that should have been an exception.
- **False Negative (FN)**: the expected pair wasn't found, either because the record was flagged or matched elsewhere. A wrong match therefore counts as both FP and FN.
- **True Negative (TN)**: correctly flagged as an exception.

The formulas:
- **Precision**: `TP / (TP + FP)`: how many of the agent's matches were correct?
- **Recall**: `TP / (TP + FN)`: how many of the true matches did it find?
- **Accuracy**: correctly decided records / decided records. This is **record-level**, so each record counts once.

The response also includes `by_case_type`, with correct and pending counts for each edge case (rounding, date drift, name variants, split payments, duplicates, missing transactions).
