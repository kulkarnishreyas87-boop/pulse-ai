import { createHash } from "node:crypto";
import { defaultKv, type Kv } from "./jobs/kv";
import { rateLimited } from "./admin";

/**
 * Rate limits that hold across every serverless instance: counters live in the database (an atomic
 * increment per window), not in one instance's memory. Used for the open Settings endpoints.
 * If storage is unavailable the in-memory limiter still applies, so a database blip never opens the gate.
 */
export interface Limit {
  name: string;
  max: number;
  windowSec: number;
  perClient: boolean; // false = one shared budget for everyone (for example, a daily cap on AI calls)
}

export const LIMITS = {
  save: { name: "save", max: 10, windowSec: 60, perClient: true },
  undo: { name: "undo", max: 20, windowSec: 60, perClient: true },
  suggest: { name: "suggest", max: 5, windowSec: 60, perClient: true },
  suggestDaily: { name: "suggest-day", max: 50, windowSec: 86_400, perClient: false }, // bounds Gemini spend from the open page
} satisfies Record<string, Limit>;

/** A short, one-way identifier for the caller, so raw IP addresses are never stored. */
export function clientId(headers: Headers): string {
  const ip = (headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || headers.get("x-real-ip") || "unknown";
  return createHash("sha256").update(`research-pulse:${ip}`).digest("hex").slice(0, 16);
}

export async function overLimit(limit: Limit, headers: Headers, opts: { kv?: Kv; now?: number } = {}): Promise<boolean> {
  const now = opts.now ?? Date.now();
  const bucket = Math.floor(now / (limit.windowSec * 1000));
  const who = limit.perClient ? clientId(headers) : "all";
  const key = `rl:${limit.name}:${who}:${bucket}`;
  try {
    const kv = opts.kv ?? defaultKv();
    const n = await kv.incr(key, limit.windowSec + 5);
    return n > limit.max;
  } catch {
    return rateLimited(key, limit.max, limit.windowSec * 1000, now);
  }
}
