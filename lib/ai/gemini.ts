import { GoogleGenAI } from "@google/genai";
import type { ZodType } from "zod";

// Pinned for reproducible results. If Google retires it we fall through to the alias below, so a
// model retirement degrades gracefully instead of silently producing empty briefs.
const MODELS = [
  process.env.GEMINI_MODEL ?? "gemini-3.8-flash",
  ...(process.env.GEMINI_FALLBACK_MODELS ?? "gemini-flash-latest").split(",").map((s) => s.trim()).filter(Boolean),
];
let modelIdx = 0;
const MODEL = MODELS[0];
// Free-tier Flash allows only a handful of requests per minute. Space calls out instead of failing.
const MIN_GAP_MS = Number(process.env.GEMINI_MIN_GAP_MS ?? 1000);
// A hung request must not hold a job until the platform kills the function.
const REQUEST_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS ?? 45_000);

let ai: GoogleGenAI | null = null;
function client(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
  return (ai ??= new GoogleGenAI({ apiKey }));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let lastCallAt = 0;

export interface RawCall {
  text: string;
  promptTokens?: number;
  outputTokens?: number;
}

/** One raw request to Gemini, with spacing, a timeout, and fallback if a model has been retired. */
async function geminiCall(system: string, prompt: string): Promise<RawCall> {
  const wait = lastCallAt + MIN_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
  for (;;) {
    try {
      const res = await client().models.generateContent({
        model: MODELS[modelIdx],
        contents: prompt,
        config: {
          systemInstruction: system,
          responseMimeType: "application/json",
          temperature: 0,
          abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      });
      return {
        text: res.text ?? "",
        promptTokens: res.usageMetadata?.promptTokenCount,
        outputTokens: res.usageMetadata?.candidatesTokenCount,
      };
    } catch (e) {
      const retired = /no longer available|not found|404/i.test(String(e));
      if (retired && modelIdx < MODELS.length - 1) {
        console.warn(`[gemini] ${MODELS[modelIdx]} unavailable, switching to ${MODELS[modelIdx + 1]}`);
        modelIdx++;
        continue;
      }
      throw e;
    }
  }
}

export const activeModel = () => MODELS[modelIdx];

export interface JsonRequest<T> {
  system: string;
  prompt: string;
  schema: ZodType<T>;
}

/** The only shape the pipeline depends on, so tests can inject a fake instead of calling Gemini. */
export type JsonLlm = <T>(req: JsonRequest<T>) => Promise<T>;

/** Counters for observability: reset per job so each job's note can say what it cost. */
export interface LlmStats {
  calls: number;
  retries: number;
  parseFailures: number;
  promptTokens: number;
  outputTokens: number;
}
const zero = (): LlmStats => ({ calls: 0, retries: 0, parseFailures: 0, promptTokens: 0, outputTokens: 0 });
let stats = zero();

/** Returns the counters since the last call and starts a fresh count. */
export function takeLlmStats(): LlmStats {
  const s = stats;
  stats = zero();
  return s;
}

/**
 * Wraps a raw call in the behaviour every AI stage relies on: JSON mode output validated with Zod, one
 * repair attempt with the validation error fed back, and backoff on transient errors. Throws if it still
 * fails, so the caller can degrade the domain. `call` and `wait` are injectable so this is testable.
 */
export function createJsonLlm(call: (system: string, prompt: string) => Promise<RawCall>, wait: (ms: number) => Promise<void> = sleep): JsonLlm {
  return async (opts) => {
    let prompt = opts.prompt;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (attempt > 0) stats.retries++;
        stats.calls++;
        const raw = await call(opts.system, prompt);
        stats.promptTokens += raw.promptTokens ?? 0;
        stats.outputTokens += raw.outputTokens ?? 0;
        const parsed = opts.schema.safeParse(JSON.parse(raw.text));
        if (parsed.success) return parsed.data;
        stats.parseFailures++;
        lastErr = parsed.error;
        prompt =
          `${opts.prompt}\n\nYour previous answer failed validation: ${parsed.error.message}\n` +
          `Return only corrected JSON that matches the requested shape.`;
      } catch (e) {
        lastErr = e;
        if (e instanceof SyntaxError) stats.parseFailures++;
        if (String(e).includes("GEMINI_API_KEY")) throw e; // no point retrying a missing key
        await wait(1500 * 2 ** attempt); // backoff for 429/5xx or bad JSON
      }
    }
    throw new Error(`Gemini call failed after retries: ${String(lastErr)}`);
  };
}

export const generateJson: JsonLlm = createJsonLlm(geminiCall);

export const geminiModel = MODEL;
