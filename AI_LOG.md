# ReconAgent AI Log

This document tracks the AI-assisted development of the ReconAgent project.

## AI-Assisted Components
The entire ReconAgent system was built from scratch with the assistance of an autonomous AI coding agent. The major components developed include:
- **Synthetic Data Generation**: TypeScript scripts to predictably generate realistic accounting edge cases (rounding errors, date drift, name variants, split payments, duplicate references) and a `ground_truth.json` answer key. Uses a fixed PRNG seed (Mulberry32, seed 42) for full reproducibility.
- **Database Schema & Migrations**: Designed the PostgreSQL schemas (`ledger_records`, `bank_transactions`, `matches`, `exceptions`, `audit_log`) with proper FK constraints, CHECK constraints on enums, and NUMERIC(12,2) for monetary values.
- **Agent Loop & Tools**: Implemented the core AI loop using the `@google/generative-ai` SDK, including defining complex tool schemas (`find_exact_candidates`, `find_fuzzy_candidates`, `compare_names`, `check_duplicate_ref`) and handling multi-turn tool execution with a 6-turn hard stop.
- **Exact-Match Precheck**: Before invoking the LLM, the system queries the database for trivial exact matches (unique reference + exact amount). If found, it bypasses the LLM entirely, saving tokens, cost, and latency for ~60% of records.
- **Backend Express API**: Created a robust REST API to manage ingestion, trigger reconciliation runs, fetch metrics (with precision/recall/accuracy computed against ground truth), and resolve exceptions with human-in-the-loop review.
- **Frontend Dashboard**: Built a light "ledger" themed React SPA using Vite, Tailwind CSS v4, and Lucide React. Features a glassmorphic design with Newsreader serif headings, IBM Plex Sans for UI text, and IBM Plex Mono for all numeric data. Includes a dense data table for matches, expandable exception rows, and an investigation trace modal styled as a vertical audit log.

## System Prompt Used for the Reconciliation Agent
The following System Prompt is injected into the `gemini-2.0-flash` model (configurable via `GEMINI_MODEL` env var) to govern its autonomous reconciliation loop:

> You are ReconAgent, a financial reconciliation agent. Your job is to determine whether a single ledger entry has a matching bank/payment-gateway transaction.
> 
> You will be given one ledger record. You have tools to search for candidate bank transactions, compare fields, and check for anomalies. Investigate methodically and efficiently — do not call tools you don't need.
> 
> INVESTIGATION STRATEGY (use your judgment, but this is the sane order):
> 1. Always start with find_exact_candidates.
> 2. If no exact match, call find_fuzzy_candidates to search by amount/date proximity.
> 3. If multiple plausible candidates, call compare_names to disambiguate.
> 4. Before committing ANY match, always call check_duplicate_ref — a reused reference is a red flag.
> 5. If no reasonable candidate or meaningful unexplained discrepancies, flag as exception.
> 
> RULES:
> - End every investigation with exactly one terminal tool: commit_match or flag_exception.
> - commit_match requires confidence >= 0.85. Below that, call flag_exception instead.
> - Never commit a match on a reference flagged as duplicate.
> - Write reasoning in plain language a non-technical reviewer could read in five seconds.
> - Maximum of 6 tool calls per record.

## Bug Fix: Overcoming Gemini API Role Validation
During the development of the Agent Loop, the system encountered a critical failure when attempting to return tool results to the LLM. 

### The Problem
The agent would correctly initiate a tool call (e.g., `find_exact_candidates`), but when the Node.js backend attempted to feed the results back to the model, the Gemini API responded with a fatal HTTP 400 error:
> `[400 Bad Request] Invalid JSON payload received... Proto field is not repeating, cannot start list.`
> `[400 Bad Request] Function call is missing a thought_signature...`

### The Root Cause
The initial implementation used the `@google/generative-ai` SDK's built-in `chat.sendMessage()` abstraction. Under the hood, this helper injected a deprecated `function` role into the payload. Furthermore, when returning arrays of database rows directly in the `functionResponse`, the strict validation rejected the top-level array.

### The Fix
To solve this, the AI coding agent had to:
1. **Ditch the Chat Helper**: The loop was rewritten to abandon `chat.sendMessage()` and instead use `model.generateContent({ contents })`, manually managing the `Content[]` history array.
2. **Role Correction**: The loop explicitly forced the `role` to be `'user'` when appending the `functionResponse` part, bypassing the deprecated `function` role issue.
3. **Payload Wrapping**: All array returns from the tools were wrapped in an object (`{ candidates: [...] }`) before being submitted back to the model.

Once these architectural changes were implemented, the agent successfully performed complex multi-turn investigations.
