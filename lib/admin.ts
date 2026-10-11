import { createHash, timingSafeEqual } from "node:crypto";

export interface AuthResult {
  ok: boolean;
  status: number;
  error?: string;
}

const digest = (s: string) => createHash("sha256").update(s).digest();

/**
 * Gate for anything that changes configuration or spends Gemini quota. The settings page is public
 * on the internet, so without this anyone could rewrite Kavita's domains or burn the API key.
 *  - ADMIN_PASSCODE set: the request must send it in the `x-admin-key` header.
 *  - Not set, development: open, for convenience.
 *  - Not set, production: refused, so a missing variable can never leave the door open.
 */
export function checkAdmin(headers: Headers, env: { passcode?: string; production: boolean }): AuthResult {
  if (!env.passcode) {
    return env.production
      ? { ok: false, status: 503, error: "Editing is disabled: ADMIN_PASSCODE is not configured on the server." }
      : { ok: true, status: 200 };
  }
  const given = headers.get("x-admin-key") ?? "";
  // hash first so the comparison is constant-time and length-independent
  return timingSafeEqual(digest(given), digest(env.passcode))
    ? { ok: true, status: 200 }
    : { ok: false, status: 401, error: "Wrong passcode." };
}

export const adminFromEnv = (headers: Headers) =>
  checkAdmin(headers, { passcode: process.env.ADMIN_PASSCODE, production: process.env.NODE_ENV === "production" });

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

/** Tiny per-instance limiter so a loop cannot hammer the AI endpoint. Not a substitute for the passcode. */
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
