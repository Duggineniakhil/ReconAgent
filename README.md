<div align="center">
  <h1>ReconAgent 🤖💼</h1>
  <p><strong>AI-powered financial reconciliation system</strong></p>
  
  [![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)
  [![React](https://img.shields.io/badge/React-19-blue.svg)](https://reactjs.org/)
  [![PostgreSQL](https://img.shields.io/badge/PostgreSQL-14+-blue.svg)](https://www.postgresql.org/)
  [![Gemini](https://img.shields.io/badge/AI-Gemini%202.0%20Flash-orange.svg)](https://aistudio.google.com/)
  [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
</div>

<br/>

ReconAgent is an AI-powered financial reconciliation system that automates the tedious process of matching ledger records (e.g., invoices) against bank transactions. Instead of relying solely on brittle, hardcoded exact-match rules, ReconAgent employs a Large Language Model (Gemini 2.0) equipped with specialized tools to autonomously investigate and resolve complex financial discrepancies.

## 🌟 The Problem & Our Solution
Financial reconciliation typically requires human intervention when records don't perfectly align due to:
- **Rounding differences** or FX discrepancies.
- **Date drift** (delays between invoice and payment settlement).
- **Name variants** or abbreviations (e.g., "Acme Corp" vs. "Acme Corporation").
- **Missing transactions** or duplicate reference numbers (fraud prevention).

**ReconAgent** solves this by mimicking a human accountant's thought process. It uses an autonomous agent loop that queries the database, calculates similarities, checks for fraud heuristics, and makes reasoned decisions about whether to approve a match or flag it for manual review.

## 🏗️ Architecture

ReconAgent is built with a modern stack featuring a Node.js/Express API, PostgreSQL database, and a Vite + React + Tailwind frontend. The AI agent runs as an event loop powered by **Gemini 2.0 Flash**.

> **Note on Efficiency:** The architecture includes an **Exact-Match Precheck**. Before invoking the LLM, the system queries the database for trivial exact matches (perfect reference and amount alignment). If found, it bypasses the LLM entirely, saving tokens, cost, and latency for obvious reconciliations.

```mermaid
graph TD
    subgraph Data Layer
        DB[(PostgreSQL)]
        DB --> L[ledger_records]
        DB --> B[bank_transactions]
        DB --> M[matches]
        DB --> E[exceptions]
        DB --> A[audit_log]
    end

    subgraph Backend API (Node.js/Express)
        Ingest[POST /api/ingest]
        Reconcile[POST /api/reconcile]
        Metrics[GET /api/metrics]
        Exceptions[GET /api/exceptions]
        Matches[GET /api/matches]
        Resolve[POST /api/exceptions/:id/resolve]
        Audit[GET /api/audit-log/:ledgerId]
    end

    subgraph AI Agent Loop
        Precheck{Exact Match Precheck}
        Agent(Gemini 2.0 Flash)
        Agent -->|Tool Call| T1[find_exact_candidates]
        Agent -->|Tool Call| T2[find_fuzzy_candidates]
        Agent -->|Tool Call| T3[compare_names]
        Agent -->|Tool Call| T4[check_duplicate_ref]
        Agent -->|Terminal| Guard{Server guardrails}
        Guard --> Commit[commit_match / flag_exception]
    end

    subgraph Frontend (React/Vite/Tailwind v4)
        Dash[Dashboard & Metrics]
        EQ[Exceptions Queue]
        MV[Matches View]
        Trace[Investigation Trace Modal]
    end

    Ingest --> DB
    Reconcile --> Precheck
    Precheck -->|Match| DB
    Precheck -->|Miss| Agent
    Agent <--> DB
    Metrics --> DB
    Exceptions --> DB
    Matches --> DB

    Dash --> Metrics
    Dash --> Reconcile
    Dash --> Ingest
    EQ --> Exceptions
    MV --> Matches
```

## 🛡️ Guardrails

The model proposes; the server decides. Every `commit_match` is re-checked against the database before anything is written, and becomes an exception (logged as a `guardrail_override` step in the trace) if:

- the bank transaction doesn't exist,
- it is already matched to another invoice,
- its reference appears on more than one bank transaction,
- confidence is below **0.85**, or
- the amount differs by more than **1%**.

The schema backs this up: each ledger record has at most one match and one exception, and each bank transaction can be matched only once. Each record's outcome and its audit rows are written in one transaction. The agent gets at most **6 investigative tool calls** per record, and ingest/reconcile runs can't overlap. Matches approved by a human reviewer are stored with method `manual` and excluded from the agent's metrics.

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
   GEMINI_MODEL=gemini-2.0-flash
   ```
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

You can then ingest this data via the frontend dashboard by clicking **"Reset & Ingest Data"**, which uploads it to PostgreSQL.

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
