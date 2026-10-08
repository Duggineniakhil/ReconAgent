/**
 * src/agent/loop.ts
 *
 * Core agent loop for reconciling a single ledger record.
 * Uses Google Gemini function calling.
 *
 * Implements:
 *   - Exact-match precheck (skips LLM for trivial cases)
 *   - Gemini function calling with a hard budget of investigative tool calls
 *   - audit_log write on every tool call
 *   - commit_match / flag_exception terminal handling, re-checked by
 *     server-side guardrails and written atomically
 */

import {
  GoogleGenerativeAI,
  type GenerativeModel,
  type Content,
  type FunctionCall,
  type Part,
} from '@google/generative-ai';
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../db';
import {
  findExactCandidates,
  findFuzzyCandidates,
  compareNames,
  checkDuplicateRef,
} from '../tools';
import { SYSTEM_PROMPT } from './system_prompt';
import { FUNCTION_DECLARATIONS } from './tool_schemas';
import { checkCommit, type CommitTarget, type ExceptionReason } from './guardrails';

// ═══════════════════════════════════════════════════════════════════════
//  TYPES
// ═══════════════════════════════════════════════════════════════════════

export interface ToolCallTrace {
  turn: number;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_result: unknown;
}

export interface ReconciliationResult {
  ledger_id: number;
  invoice_id: string;
  outcome: 'matched' | 'exception' | 'timeout';
  method?: string;
  confidence?: number;
  reasoning?: string;
  matched_bank_txn_id?: string;
  exception_reason?: string;
  best_candidate_id?: string | null;
  trace: ToolCallTrace[];
  turns: number;
  precheck: boolean;
}

interface LedgerRow {
  id: number;
  invoice_id: string;
  customer_name: string;
  amount: number;
  invoice_date: string;
  payment_ref: string;
}

// ═══════════════════════════════════════════════════════════════════════
//  CONSTANTS
// ═══════════════════════════════════════════════════════════════════════

/** Investigative (non-terminal) tool calls allowed per record. */
const MAX_TOOL_CALLS = 6;
/** Model round-trips allowed; leaves room to reach a terminal call after the budget runs out. */
const MAX_MODEL_TURNS = MAX_TOOL_CALLS + 2;
const MODEL_NAME = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

// ═══════════════════════════════════════════════════════════════════════
//  GEMINI CLIENT  (lazy singleton)
// ═══════════════════════════════════════════════════════════════════════

let _model: GenerativeModel | null = null;

function getModel(): GenerativeModel {
  if (!_model) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY not set');
    const genAI = new GoogleGenerativeAI(apiKey);
    _model = genAI.getGenerativeModel({
      model: MODEL_NAME,
      systemInstruction: SYSTEM_PROMPT,
      tools: [{ functionDeclarations: FUNCTION_DECLARATIONS }],
    });
  }
  return _model;
}

// ═══════════════════════════════════════════════════════════════════════
//  AUDIT LOG
// ═══════════════════════════════════════════════════════════════════════

async function writeAuditLog(
  ledgerId: number,
  turnNumber: number,
  toolName: string,
  toolInput: Record<string, unknown>,
  toolResult: unknown,
  client?: PoolClient,
): Promise<void> {
  const sql = `INSERT INTO audit_log (ledger_id, turn_number, tool_name, tool_input, tool_result)
               VALUES ($1, $2, $3, $4, $5)`;
  const params = [ledgerId, turnNumber, toolName, JSON.stringify(toolInput), JSON.stringify(toolResult)];
  if (client) await client.query(sql, params);
  else await query(sql, params);
}

// ═══════════════════════════════════════════════════════════════════════
//  TOOL EXECUTION  (investigative tools only)
// ═══════════════════════════════════════════════════════════════════════

async function executeTool(
  toolName: string,
  toolInput: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  switch (toolName) {
    case 'find_exact_candidates': {
      const candidates = await findExactCandidates(
        toolInput.reference as string,
        toolInput.amount as number,
      );
      return { candidates };
    }

    case 'find_fuzzy_candidates': {
      const candidates = await findFuzzyCandidates(
        toolInput.amount as number,
        toolInput.date as string,
        toolInput.customer_name as string | undefined,
      );
      return { candidates };
    }

    case 'compare_names':
      return compareNames(
        toolInput.name_a as string,
        toolInput.name_b as string,
      ) as unknown as Record<string, unknown>;

    case 'check_duplicate_ref':
      return checkDuplicateRef(toolInput.reference as string) as unknown as Record<string, unknown>;

    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  TERMINAL HANDLERS  (each runs in a single transaction)
// ═══════════════════════════════════════════════════════════════════════

async function loadCommitTarget(
  client: PoolClient,
  txnId: string,
): Promise<(CommitTarget & { id: number }) | null> {
  const result = await client.query<CommitTarget & { id: number }>(
    `SELECT b.id, b.txn_id, b.utr_ref, b.amount::float AS amount,
            (SELECT COUNT(*)::int FROM bank_transactions d WHERE d.utr_ref = b.utr_ref) AS ref_count,
            (SELECT l.invoice_id FROM matches m JOIN ledger_records l ON l.id = m.ledger_id
              WHERE m.bank_txn_id = b.id) AS matched_to
     FROM   bank_transactions b
     WHERE  b.txn_id = $1`,
    [txnId],
  );
  return result.rows[0] ?? null;
}

async function insertException(
  client: PoolClient,
  ledgerId: number,
  reason: ExceptionReason,
  reasoning: string,
  bestCandidateTxnId: string | null,
): Promise<void> {
  let bestCandidateId: number | null = null;
  if (bestCandidateTxnId) {
    const bank = await client.query<{ id: number }>(
      `SELECT id FROM bank_transactions WHERE txn_id = $1`,
      [bestCandidateTxnId],
    );
    bestCandidateId = bank.rows[0]?.id ?? null;
  }
  await client.query(
    `INSERT INTO exceptions (ledger_id, reason, best_candidate_bank_txn_id, reasoning)
     VALUES ($1, $2, $3, $4)`,
    [ledgerId, reason, bestCandidateId, reasoning],
  );
}

/** commit_match: re-check against the DB, then write a match or (if a guardrail trips) an exception. */
async function handleCommitMatch(
  ledger: LedgerRow,
  turn: number,
  input: Record<string, unknown>,
  trace: ToolCallTrace[],
): Promise<ReconciliationResult> {
  const txnId = String(input.bank_txn_id ?? '');
  const confidence = Number(input.confidence) || 0;
  const base = { ledger_id: ledger.id, invoice_id: ledger.invoice_id, trace, turns: turn, precheck: false };

  return withTransaction(async (client) => {
    const target = await loadCommitTarget(client, txnId);
    const check = checkCommit(ledger.amount, confidence, target, txnId);

    const result = { status: check.ok ? 'committed' : 'rejected_by_guardrail' };
    await writeAuditLog(ledger.id, turn, 'commit_match', input, result, client);
    trace.push({ turn, tool_name: 'commit_match', tool_input: input, tool_result: result });

    if (check.ok) {
      await client.query(
        `INSERT INTO matches (ledger_id, bank_txn_id, method, confidence, reasoning)
         VALUES ($1, $2, $3, $4, $5)`,
        [ledger.id, target!.id, input.method, confidence, input.reasoning],
      );
      return {
        ...base,
        outcome: 'matched' as const,
        method: input.method as string,
        confidence,
        reasoning: input.reasoning as string,
        matched_bank_txn_id: txnId,
      };
    }

    const reasoning = `Guardrail blocked the agent's match to ${txnId}: ${check.message} Agent reasoning: ${input.reasoning}`;
    const overrideInput = { bank_txn_id: txnId, reason: check.reason, message: check.message };
    await writeAuditLog(ledger.id, turn, 'guardrail_override', overrideInput, { flagged: true }, client);
    trace.push({ turn, tool_name: 'guardrail_override', tool_input: overrideInput, tool_result: { flagged: true } });
    await insertException(client, ledger.id, check.reason, reasoning, target ? txnId : null);

    return {
      ...base,
      outcome: 'exception' as const,
      exception_reason: check.reason,
      reasoning,
      best_candidate_id: target ? txnId : null,
    };
  });
}

/** Write an exception (from flag_exception, a text-only reply, or the hard stop). */
async function handleException(
  ledger: LedgerRow,
  turn: number,
  toolName: string,
  input: Record<string, unknown>,
  trace: ToolCallTrace[],
  outcome: 'exception' | 'timeout' = 'exception',
): Promise<ReconciliationResult> {
  const reason = input.reason as ExceptionReason;
  const reasoning = String(input.reasoning ?? '');
  const candidate = input.best_candidate_id as string | undefined;
  const bestCandidate = candidate && candidate !== 'null' ? candidate : null;

  await withTransaction(async (client) => {
    const result = { status: 'flagged' };
    await writeAuditLog(ledger.id, turn, toolName, input, result, client);
    trace.push({ turn, tool_name: toolName, tool_input: input, tool_result: result });
    await insertException(client, ledger.id, reason, reasoning, bestCandidate);
  });

  return {
    ledger_id: ledger.id,
    invoice_id: ledger.invoice_id,
    outcome,
    exception_reason: reason,
    reasoning,
    best_candidate_id: bestCandidate,
    trace,
    turns: turn,
    precheck: false,
  };
}

// ═══════════════════════════════════════════════════════════════════════
//  PRECHECK — skip LLM for trivial exact matches
// ═══════════════════════════════════════════════════════════════════════

async function tryPrecheck(
  ledger: LedgerRow,
): Promise<ReconciliationResult | null> {
  // Find all bank txns with this reference that aren't already matched
  const refResult = await query<{ id: number; txn_id: string; amount: number; matched: boolean }>(
    `SELECT b.id, b.txn_id, b.amount::float AS amount,
            EXISTS (SELECT 1 FROM matches m WHERE m.bank_txn_id = b.id) AS matched
     FROM   bank_transactions b
     WHERE  b.utr_ref = $1`,
    [ledger.payment_ref],
  );

  // Must be exactly 1 row with that reference (no duplicates), still unclaimed
  if (refResult.rows.length !== 1) return null;

  const bankTxn = refResult.rows[0];
  if (bankTxn.matched) return null;

  // Amount must match exactly
  if (Number(bankTxn.amount) !== ledger.amount) return null;

  // Clean trivial match — commit directly, no LLM needed
  const reasoning = `Precheck: exact match on reference ${ledger.payment_ref} and amount ${ledger.amount}. Single unique reference, no ambiguity.`;
  const auditInput = { reference: ledger.payment_ref, amount: ledger.amount };
  const auditResult = {
    matched: true,
    bank_txn_id: bankTxn.txn_id,
    bank_db_id: bankTxn.id,
    method: 'exact',
  };

  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO matches (ledger_id, bank_txn_id, method, confidence, reasoning)
       VALUES ($1, $2, 'exact', 1.000, $3)`,
      [ledger.id, bankTxn.id, reasoning],
    );
    await writeAuditLog(ledger.id, 0, 'precheck_exact', auditInput, auditResult, client);
  });

  return {
    ledger_id: ledger.id,
    invoice_id: ledger.invoice_id,
    outcome: 'matched',
    method: 'exact',
    confidence: 1.0,
    reasoning,
    matched_bank_txn_id: bankTxn.txn_id,
    trace: [{ turn: 0, tool_name: 'precheck_exact', tool_input: auditInput, tool_result: auditResult }],
    turns: 0,
    precheck: true,
  };
}

// ═══════════════════════════════════════════════════════════════════════
//  EXTRACT FUNCTION CALLS FROM GEMINI RESPONSE
// ═══════════════════════════════════════════════════════════════════════

function extractFunctionCalls(parts: Part[]): FunctionCall[] {
  const calls: FunctionCall[] = [];
  for (const part of parts) {
    if (part.functionCall) {
      calls.push(part.functionCall);
    }
  }
  return calls;
}

// ═══════════════════════════════════════════════════════════════════════
//  MAIN AGENT LOOP
// ═══════════════════════════════════════════════════════════════════════

/**
 * Reconcile a single ledger record.
 *
 * 1. Try the precheck (trivial exact match → skip LLM)
 * 2. If precheck fails, run the Gemini agent loop
 * 3. Stop investigating after MAX_TOOL_CALLS tool calls
 */
export async function reconcileRecord(
  ledgerId: number,
): Promise<ReconciliationResult> {
  // ── Fetch ledger record ─────────────────────────────────────────────
  const ledgerResult = await query<LedgerRow & { reconciled: boolean }>(
    `SELECT l.id, l.invoice_id, l.customer_name, l.amount::float AS amount,
            l.invoice_date::text AS invoice_date, l.payment_ref,
            EXISTS (SELECT 1 FROM matches m WHERE m.ledger_id = l.id)
              OR EXISTS (SELECT 1 FROM exceptions e WHERE e.ledger_id = l.id) AS reconciled
     FROM   ledger_records l WHERE l.id = $1`,
    [ledgerId],
  );
  const ledger = ledgerResult.rows[0];
  if (!ledger) throw new Error(`Ledger record id=${ledgerId} not found`);
  if (ledger.reconciled) throw new Error(`Ledger record id=${ledgerId} is already reconciled`);

  // Clear audit rows left behind by an interrupted earlier attempt
  await query(`DELETE FROM audit_log WHERE ledger_id = $1`, [ledgerId]);

  // ── Precheck ────────────────────────────────────────────────────────
  const precheckResult = await tryPrecheck(ledger);
  if (precheckResult) return precheckResult;

  // ── Agent loop via Gemini ───────────────────────────────────────────
  const model = getModel();
  const trace: ToolCallTrace[] = [];

  const userMessage = [
    `Investigate this ledger record and determine whether it has a matching bank transaction.`,
    ``,
    `Invoice ID: ${ledger.invoice_id}`,
    `Customer Name: ${ledger.customer_name}`,
    `Amount: ${ledger.amount}`,
    `Invoice Date: ${ledger.invoice_date}`,
    `Payment Reference: ${ledger.payment_ref}`,
  ].join('\n');

  const contents: Content[] = [
    { role: 'user', parts: [{ text: userMessage }] }
  ];

  let toolCalls = 0;
  let turn = 0;

  while (turn < MAX_MODEL_TURNS) {
    turn++;

    const response = await model.generateContent({ contents });
    const parts = response.response.candidates?.[0]?.content?.parts ?? [];
    contents.push({ role: 'model', parts });

    const functionCalls = extractFunctionCalls(parts);

    // If no function calls, the model gave a text response (shouldn't happen)
    if (functionCalls.length === 0) {
      return handleException(ledger, turn, 'no_terminal_call', {
        reason: 'unexplained_discrepancy',
        reasoning: 'Agent responded with text only, no terminal tool called.',
      }, trace);
    }

    const functionResponseParts: Part[] = [];

    for (const fc of functionCalls) {
      const input = (fc.args ?? {}) as Record<string, unknown>;

      // Terminal tools end the investigation; any calls after them are ignored
      if (fc.name === 'commit_match') return handleCommitMatch(ledger, turn, input, trace);
      if (fc.name === 'flag_exception') return handleException(ledger, turn, 'flag_exception', input, trace);

      let result: Record<string, unknown>;
      if (toolCalls >= MAX_TOOL_CALLS) {
        result = { error: `Tool-call budget of ${MAX_TOOL_CALLS} is exhausted. Call commit_match or flag_exception now.` };
      } else {
        toolCalls++;
        result = await executeTool(fc.name, input);
      }

      await writeAuditLog(ledger.id, turn, fc.name, input, result);
      trace.push({ turn, tool_name: fc.name, tool_input: input, tool_result: result });

      functionResponseParts.push({
        functionResponse: { name: fc.name, response: result },
      });
    }

    // Send function results back to Gemini
    contents.push({ role: 'user', parts: functionResponseParts });
  }

  // ── Hard-stop: model never reached a terminal call ──────────────────
  return handleException(ledger, turn, 'hard_stop', {
    reason: 'unexplained_discrepancy',
    reasoning: `Agent did not reach a decision within ${MAX_TOOL_CALLS} tool calls.`,
  }, trace, 'timeout');
}
