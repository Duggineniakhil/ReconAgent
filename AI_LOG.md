# ReconAgent AI Log

This document tracks the AI-assisted development of the ReconAgent project.

## AI-Assisted Components
The entire ReconAgent system was built from scratch with the assistance of an autonomous AI coding agent. The major components developed include:
- **Synthetic Data Generation**: Python/TypeScript scripts to predictably generate realistic accounting edge cases (rounding errors, date drift) and a `ground_truth.json` answer key.
- **Database Schema & Migrations**: Designed the PostgreSQL schemas (`ledger_records`, `bank_transactions`, `matches`, `exceptions`, `audit_log`) and wrote the initialization scripts.
- **Agent Loop & Tools**: Implemented the core AI loop using the `@google/generative-ai` SDK, including defining complex tool schemas (`find_fuzzy_candidates`, `compare_names`) and handling multi-turn tool execution.
- **Backend Express API**: Created a robust REST API to manage ingestion, trigger reconciliation runs, fetch metrics, and resolve exceptions.
- **Frontend Dashboard**: Built a modern, dark-themed React SPA using Vite, Tailwind CSS v4, Lucide React, and Recharts to visualize the system's performance and trace the agent's audit logs.

## System Prompt Used for the Reconciliation Agent
The following System Prompt was injected into the `gemini-3.6-flash` model to govern its autonomous reconciliation loop:

> You are an expert financial reconciliation agent. Your job is to match a ledger record (e.g., an invoice) to exactly one bank transaction, or flag it as an exception if a safe match cannot be made.
> 
> You have access to tools to search the bank statement. You should:
> 1. Start by searching for exact or near-exact matches (by amount and date).
> 2. If nothing obvious appears, broaden the search using fuzzy parameters (e.g., wider date window, +/- 1% amount variance).
> 3. Use the compare_names tool if you need to check if a payer name matches the customer name.
> 4. If you find a potential match but the reference number seems generic or missing, check for duplicate references.
> 
> You MUST call a terminal tool (`match_record` or `flag_exception`) to end the process. 
> Only match a record if you are highly confident. If there is unresolved ambiguity (multiple equally good candidates) or a significant unexplained discrepancy, flag it as an exception.

## Bug Fix: Overcoming Gemini API Role Validation
During the development of the Agent Loop, the system encountered a critical failure when attempting to return tool results to the LLM. 

### The Problem
The agent would correctly initiate a tool call (e.g., `find_exact_candidates`), but when the Node.js backend attempted to feed the results back to the model, the Gemini API responded with a fatal HTTP 400 error:
> `[400 Bad Request] Invalid JSON payload received... Proto field is not repeating, cannot start list.`
> `[400 Bad Request] Function call is missing a thought_signature...`

### The Root Cause
The initial implementation used the `@google/generative-ai` SDK's built-in `chat.sendMessage()` abstraction. Under the hood, this helper injected a deprecated `function` role into the payload. Furthermore, when returning arrays of database rows directly in the `functionResponse`, the strict validation of the `gemini-3.6-flash` model rejected the top-level array.

### The Fix
To solve this, the AI coding agent had to:
1. **Ditch the Chat Helper**: The loop was rewritten to abandon `chat.sendMessage()` and instead use `model.generateContent({ contents })`, manually managing the `Content[]` history array.
2. **Role Correction**: The loop explicitly forced the `role` to be `'user'` when appending the `functionResponse` part, bypassing the deprecated `function` role issue.
3. **Payload Wrapping**: All array returns from the tools were wrapped in an object (`{ candidates: [...] }`) before being submitted back to the model.

Once these architectural changes were implemented, the agent successfully performed complex multi-turn investigations.
