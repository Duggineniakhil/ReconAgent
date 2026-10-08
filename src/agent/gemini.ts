/**
 * Gemini client: lazy model singleton, a process-wide rate limiter and
 * retry with exponential backoff for rate-limit / transient errors.
 */
import crypto from 'crypto';
import {
  GoogleGenerativeAI,
  type GenerativeModel,
  type Content,
  type Part,
} from '@google/generative-ai';
import { SYSTEM_PROMPT } from './system_prompt';
import { FUNCTION_DECLARATIONS } from './tool_schemas';

export const MODEL_NAME = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

/** Short hash of the system prompt + tool schemas, so runs can be grouped by prompt version. */
export const PROMPT_VERSION = crypto
  .createHash('sha256')
  .update(SYSTEM_PROMPT + JSON.stringify(FUNCTION_DECLARATIONS))
  .digest('hex')
  .slice(0, 8);

/** Requests per minute across the whole process (0 = unlimited). Gemini free tier allows 15. */
const RPM = Number(process.env.GEMINI_RPM ?? 15);
const MAX_RETRIES = Number(process.env.GEMINI_MAX_RETRIES ?? 5);
const RETRY_BASE_MS = Number(process.env.GEMINI_RETRY_BASE_MS ?? 2000);
const RETRY_MAX_MS = 60_000;

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Spaces requests evenly: each caller reserves the next free slot.
let nextSlot = 0;
async function waitForSlot(): Promise<void> {
  if (RPM <= 0) return;
  const now = Date.now();
  const slot = Math.max(now, nextSlot);
  nextSlot = slot + 60_000 / RPM;
  if (slot > now) await sleep(slot - now);
}

function isRetryable(err: unknown): boolean {
  const status = (err as { status?: number }).status;
  if (status === 429 || (status !== undefined && status >= 500)) return true;
  // Network failures surface without a status
  return status === undefined && /fetch failed|ECONNRESET|ETIMEDOUT|socket hang up/i.test(String((err as Error).message));
}

export interface ModelReply {
  parts: Part[];
  inputTokens: number;
  outputTokens: number;
}

/** One model round-trip, rate-limited and retried on 429 / 5xx / network errors. */
export async function generate(contents: Content[]): Promise<ModelReply> {
  const model = getModel();
  for (let attempt = 0; ; attempt++) {
    await waitForSlot();
    try {
      const response = await model.generateContent({ contents });
      const usage = response.response.usageMetadata;
      return {
        parts: response.response.candidates?.[0]?.content?.parts ?? [],
        inputTokens: usage?.promptTokenCount ?? 0,
        outputTokens: usage?.candidatesTokenCount ?? 0,
      };
    } catch (err) {
      if (attempt >= MAX_RETRIES || !isRetryable(err)) throw err;
      const delay = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS) * (0.75 + Math.random() * 0.5);
      console.warn(`[Gemini] ${(err as Error).message.slice(0, 120)}; retry ${attempt + 1}/${MAX_RETRIES} in ${Math.round(delay)}ms`);
      await sleep(delay);
    }
  }
}
