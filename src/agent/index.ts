/**
 * Agent module — barrel export.
 */
export { SYSTEM_PROMPT } from './system_prompt';
export { FUNCTION_DECLARATIONS } from './tool_schemas';
export { reconcileRecord } from './loop';
export type { ReconciliationResult, ToolCallTrace, TokenUsage, ReconcileOptions } from './loop';
export { MODEL_NAME, PROMPT_VERSION, QuotaExhaustedError } from './gemini';
