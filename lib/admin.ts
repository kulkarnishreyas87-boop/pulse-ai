import { createHash, timingSafeEqual } from "node:crypto";

export interface AuthResult {
  ok: boolean;
  status: number;
  error?: string;
}

const digest = (s: string) => createHash("sha256").update(s).digest();

/**
 * Gate for the scheduler endpoints. Vercel Cron sends `Authorization: Bearer $CRON_SECRET` automatically
 * when CRON_SECRET is set, and the GitHub Actions ticker sends the same header. Fails closed in production.
 */
export function checkCron(headers: Headers, env: { secret?: string; production: boolean }): AuthResult {
  if (!env.secret) {
    return env.production
      ? { ok: false, status: 503, error: "CRON_SECRET is not configured on the server." }
      : { ok: true, status: 200 };
  }
  const m = /^Bearer (.+)$/.exec(headers.get("authorization") ?? "");
  return m && timingSafeEqual(digest(m[1]), digest(env.secret)) ? { ok: true, status: 200 } : { ok: false, status: 401, error: "Unauthorized." };
}

export const cronFromEnv = (headers: Headers) =>
  checkCron(headers, { secret: process.env.CRON_SECRET, production: process.env.NODE_ENV === "production" });

/** Tiny per-instance limiter so a script cannot hammer the open endpoints (AI suggestions, saves, undo). */
const hits = new Map<string, number[]>();
export function rateLimited(key: string, max = 10, windowMs = 60_000, now = Date.now()): boolean {
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= max) {
    hits.set(key, recent);
    return true;
  }
  recent.push(now);
  hits.set(key, recent);
  return false;
}
