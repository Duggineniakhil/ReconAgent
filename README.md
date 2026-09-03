# ReconAgent 🤖💼

ReconAgent is an AI-powered financial reconciliation system that automates the tedious process of matching ledger records (e.g., invoices) against bank transactions. Instead of relying solely on brittle, hardcoded exact-match rules, ReconAgent employs a Large Language Model (Gemini) equipped with specialized tools to investigate and resolve complex discrepancies.

## The Problem
Financial reconciliation typically requires human intervention when records don't perfectly align due to:
- Rounding differences or FX discrepancies.
- Date drift (delays between invoice and payment dates).
- Name variants or abbreviations (e.g., "Acme Corp" vs. "Acme Corporation").
- Split payments (one transaction paying multiple invoices).
- Missing transactions or duplicate reference numbers.

ReconAgent solves this by mimicking a human accountant's thought process. It uses an autonomous agent loop that can query the database, calculate similarities, and make reasoned decisions about whether to approve a match or flag it as an exception.

## Architecture

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
    end

    subgraph AI Agent Loop
        Agent(Gemini 3.6 Flash)
        Agent -->|Tool Call| T1[find_exact_candidates]
        Agent -->|Tool Call| T2[find_fuzzy_candidates]
        Agent -->|Tool Call| T3[compare_names]
        Agent -->|Tool Call| T4[check_duplicate_ref]
        Agent -->|Terminal| Resolve[match_record / flag_exception]
    end

    subgraph Frontend (React/Vite/Tailwind v4)
        Dash[Dashboard & Metrics]
        EQ[Exceptions Queue]
        MV[Matches View]
        Trace[Investigation Trace Modal]
    end

    Ingest --> DB
    Reconcile --> Agent
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

## How to Run Locally

### Prerequisites
- Node.js (v18+)
- PostgreSQL instance running locally.
- A Google Gemini API key.

### 1. Environment Setup
Create a `.env` file in the root directory:
```
DB_USER=postgres
DB_PASSWORD=yourpassword
DB_HOST=localhost
DB_PORT=5432
DB_NAME=reconagent
GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL=gemini-3.6-flash
```

### 2. Backend Setup
Install dependencies and run the database migrations:
```bash
npm install
npm run migrate
```

Start the backend server (runs on `http://localhost:3000`):
```bash
npm run dev
```

### 3. Frontend Setup
In a separate terminal, navigate to the `client/` directory:
```bash
cd client
npm install
npm run dev
```
The React dashboard will be available at `http://localhost:5173`.

## How to Run the Generator
To populate the database with synthetic testing data, you must generate the CSV files. 

Run the data generation script from the root directory:
```bash
npm run generate-data
```
This script uses a fixed random seed to generate ~70 ledger records and ~75 bank transactions, explicitly crafting edge cases like rounding differences, date drift, and name variants. The data is written to the `data/` folder as `ledger_records.csv`, `bank_transactions.csv`, and `ground_truth.json`.

You can then ingest this data via the frontend dashboard by clicking **"Reset & Ingest Data"**, which uploads it to PostgreSQL.

## How Metrics are Computed
The metrics system (`/api/metrics`) dynamically evaluates the AI agent's performance by comparing its final decisions against the deterministic `ground_truth.json` answer key generated during the data creation step.

- **True Positives (TP)**: The agent correctly matched a ledger record to the expected bank transaction.
- **False Positives (FP)**: The agent matched a record to the *wrong* bank transaction, OR matched a record that was supposed to be an exception.
- **False Negatives (FN)**: The agent flagged a record as an exception when it *should* have been matched, OR missed the correct match.
- **True Negatives (TN)**: The agent correctly flagged a record as an exception (e.g., missing bank transaction).

The formulas used:
- **Precision**: `TP / (TP + FP)` (How many of the agent's matches were actually correct?)
- **Recall**: `TP / (TP + FN)` (How many of the actual true matches did the agent successfully find?)
- **Accuracy**: `(TP + TN) / (TP + TN + FP + FN)`
