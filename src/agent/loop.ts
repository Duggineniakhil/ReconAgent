/**
 * src/agent/loop.ts
 *
 * Core agent loop for reconciling a single ledger record.
 * Uses Google Gemini function calling.
 *
 * Implements:
 *   - Exact-match precheck (skips LLM for trivial cases)
 *   - Gemini chat with function calling
 *   - audit_log write on every tool call
 *   - 6-turn hard stop
 *   - commit_match / flag_exception terminal handling
 */

import {
  GoogleGenerativeAI,
  type GenerativeModel,
  type Content,
  type FunctionCall,
  type Part,
} from '@google/generative-ai';
import { query } from '../db';
import {
  findExactCandidates,
  findFuzzyCandidates,
  compareNames,
  checkDuplicateRef,
} from '../tools';
import { SYSTEM_PROMPT } from './system_prompt';
import { FUNCTION_DECLARATIONS } from './tool_schemas';

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

const MAX_TURNS = 6;
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
): Promise<void> {
  await query(
    `INSERT INTO audit_log (ledger_id, turn_number, tool_name, tool_input, tool_result)
     VALUES ($1, $2, $3, $4, $5)`,
    [ledgerId, turnNumber, toolName, JSON.stringify(toolInput), JSON.stringify(toolResult)],
  );
}

// ═══════════════════════════════════════════════════════════════════════
//  TOOL EXECUTION
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

    // Terminal tools: return confirmation (DB writes happen in the loop)
    case 'commit_match':
      return { status: 'committed' };

    case 'flag_exception':
      return { status: 'flagged' };

    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  TERMINAL TOOL HANDLERS
// ═══════════════════════════════════════════════════════════════════════

async function executeCommitMatch(
  ledgerId: number,
  input: Record<string, unknown>,
): Promise<void> {
  const bankResult = await query<{ id: number }>(
    `SELECT id FROM bank_transactions WHERE txn_id = $1`,
    [input.bank_txn_id],
  );
  const bankId = bankResult.rows[0]?.id ?? null;

  await query(
    `INSERT INTO matches (ledger_id, bank_txn_id, method, confidence, reasoning)
     VALUES ($1, $2, $3, $4, $5)`,
    [ledgerId, bankId, input.method, input.confidence, input.reasoning],
  );
}

async function executeFlagException(
  ledgerId: number,
  input: Record<string, unknown>,
): Promise<void> {
  let bestCandidateId: number | null = null;
  const candidateStr = input.best_candidate_id as string | undefined;
  if (candidateStr && candidateStr !== '' && candidateStr !== 'null') {
    const bankResult = await query<{ id: number }>(
      `SELECT id FROM bank_transactions WHERE txn_id = $1`,
      [candidateStr],
    );
    bestCandidateId = bankResult.rows[0]?.id ?? null;
  }

  await query(
    `INSERT INTO exceptions (ledger_id, reason, best_candidate_bank_txn_id, reasoning)
     VALUES ($1, $2, $3, $4)`,
    [ledgerId, input.reason, bestCandidateId, input.reasoning],
  );
}

// ═══════════════════════════════════════════════════════════════════════
//  PRECHECK — skip LLM for trivial exact matches
// ═══════════════════════════════════════════════════════════════════════

async function tryPrecheck(
  ledger: LedgerRow,
): Promise<ReconciliationResult | null> {
  // Find all bank txns with this reference
  const refResult = await query<{ id: number; txn_id: string; amount: number }>(
    `SELECT id, txn_id, amount::float AS amount
     FROM   bank_transactions
     WHERE  utr_ref = $1`,
    [ledger.payment_ref],
  );

  // Must be exactly 1 row with that reference (no duplicates)
  if (refResult.rows.length !== 1) return null;

  const bankTxn = refResult.rows[0];

  // Amount must match exactly
  if (Number(bankTxn.amount) !== ledger.amount) return null;

  // Clean trivial match — commit directly, no LLM needed
  const reasoning = `Precheck: exact match on reference ${ledger.payment_ref} and amount ${ledger.amount}. Single unique reference, no ambiguity.`;

  await query(
    `INSERT INTO matches (ledger_id, bank_txn_id, method, confidence, reasoning)
     VALUES ($1, $2, 'exact', 1.000, $3)`,
    [ledger.id, bankTxn.id, reasoning],
  );

  const auditInput = { reference: ledger.payment_ref, amount: ledger.amount };
  const auditResult = {
    matched: true,
    bank_txn_id: bankTxn.txn_id,
    bank_db_id: bankTxn.id,
    method: 'exact',
  };
  await writeAuditLog(ledger.id, 0, 'precheck_exact', auditInput, auditResult);

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
 * 3. Hard-stop at 6 turns
 */
export async function reconcileRecord(
  ledgerId: number,
): Promise<ReconciliationResult> {
  // ── Fetch ledger record ─────────────────────────────────────────────
  const ledgerResult = await query<LedgerRow>(
    `SELECT id, invoice_id, customer_name, amount::float AS amount,
            invoice_date::text AS invoice_date, payment_ref
     FROM   ledger_records WHERE id = $1`,
    [ledgerId],
  );
  const ledger = ledgerResult.rows[0];
  if (!ledger) throw new Error(`Ledger record id=${ledgerId} not found`);

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

  let turnCount = 0;

  const contents: Content[] = [
    { role: 'user', parts: [{ text: userMessage }] }
  ];

  // Send initial message
  let response = await model.generateContent({ contents });
  let parts = response.response.candidates?.[0]?.content?.parts ?? [];
  contents.push({ role: 'model', parts });

  let functionCalls = extractFunctionCalls(parts);

  while (turnCount < MAX_TURNS) {
    turnCount++;

    // If no function calls, the model gave a text response (shouldn't happen)
    if (functionCalls.length === 0) {
      await query(
        `INSERT INTO exceptions (ledger_id, reason, reasoning)
         VALUES ($1, 'unexplained_discrepancy', $2)`,
        [ledger.id, 'Agent responded with text only, no terminal tool called.'],
      );
      return {
        ledger_id: ledger.id,
        invoice_id: ledger.invoice_id,
        outcome: 'exception',
        exception_reason: 'unexplained_discrepancy',
        reasoning: 'Agent responded with text only, no terminal tool called.',
        trace,
        turns: turnCount,
        precheck: false,
      };
    }

    // Execute each function call and build responses
    const functionResponseParts: Part[] = [];
    let terminalCalled = false;
    let terminalResult: ReconciliationResult | null = null;

    for (const fc of functionCalls) {
      const input = (fc.args ?? {}) as Record<string, unknown>;
      const isTerminal = fc.name === 'commit_match' || fc.name === 'flag_exception';

      // Execute the tool
      const result = await executeTool(fc.name, input);

      // Log to audit_log
      await writeAuditLog(ledger.id, turnCount, fc.name, input, result);

      // Record in trace
      trace.push({ turn: turnCount, tool_name: fc.name, tool_input: input, tool_result: result });

      // Handle terminal tools
      if (isTerminal) {
        terminalCalled = true;

        if (fc.name === 'commit_match') {
          await executeCommitMatch(ledger.id, input);
          terminalResult = {
            ledger_id: ledger.id,
            invoice_id: ledger.invoice_id,
            outcome: 'matched',
            method: input.method as string,
            confidence: input.confidence as number,
            reasoning: input.reasoning as string,
            matched_bank_txn_id: input.bank_txn_id as string,
            trace,
            turns: turnCount,
            precheck: false,
          };
        } else {
          await executeFlagException(ledger.id, input);
          terminalResult = {
            ledger_id: ledger.id,
            invoice_id: ledger.invoice_id,
            outcome: 'exception',
            exception_reason: input.reason as string,
            reasoning: input.reasoning as string,
            best_candidate_id: (input.best_candidate_id as string) || null,
            trace,
            turns: turnCount,
            precheck: false,
          };
        }
      }

      // Build function response part for Gemini
      functionResponseParts.push({
        functionResponse: {
          name: fc.name,
          response: result as Record<string, unknown>,
        },
      });
    }

    // If a terminal tool was called, we're done
    if (terminalCalled && terminalResult) {
      return terminalResult;
    }

    // Send function results back to Gemini
    contents.push({ role: 'user', parts: functionResponseParts });
    response = await model.generateContent({ contents });
    parts = response.response.candidates?.[0]?.content?.parts ?? [];
    contents.push({ role: 'model', parts });

    functionCalls = extractFunctionCalls(parts);
  }

  // ── Hard-stop: exceeded MAX_TURNS ──────────────────────────────────
  const timeoutReasoning = `Agent exceeded ${MAX_TURNS} turn limit without reaching a conclusion.`;
  await query(
    `INSERT INTO exceptions (ledger_id, reason, reasoning)
     VALUES ($1, 'unexplained_discrepancy', $2)`,
    [ledger.id, timeoutReasoning],
  );
  await writeAuditLog(ledger.id, turnCount, 'hard_stop', {}, { reason: 'turn_limit_exceeded' });

  return {
    ledger_id: ledger.id,
    invoice_id: ledger.invoice_id,
    outcome: 'timeout',
    exception_reason: 'unexplained_discrepancy',
    reasoning: timeoutReasoning,
    trace,
    turns: turnCount,
    precheck: false,
  };
}
