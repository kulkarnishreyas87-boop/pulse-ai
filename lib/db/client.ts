import { neon } from "@neondatabase/serverless";

export type Row = Record<string, any>;

/** The only thing the app needs from Postgres. Neon's HTTP driver implements it in production, PGlite in tests. */
export interface Db {
  query(text: string, params?: unknown[]): Promise<Row[]>;
}

/**
 * Tables:
 *  - kv:      the job queue's state, leases, cached scores and per-run working data (TTL'd).
 *  - briefs:  every published weekly brief, the archive the web page reads.
 *  - domains: Kavita's monitored domains, edited on the Settings page.
 * Each statement is idempotent, so running them on every cold start is safe.
 */
export const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS kv (
     key        text PRIMARY KEY,
     value      jsonb NOT NULL,
     expires_at timestamptz
   )`,
  `CREATE INDEX IF NOT EXISTS kv_expires_idx ON kv (expires_at) WHERE expires_at IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS briefs (
     week         text PRIMARY KEY,
     window_start timestamptz NOT NULL,
     published_at timestamptz NOT NULL DEFAULT now(),
     brief        jsonb NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS briefs_window_idx ON briefs (window_start DESC)`,
  `CREATE TABLE IF NOT EXISTS domains (
     id         text PRIMARY KEY,
     position   integer NOT NULL,
     config     jsonb NOT NULL,
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,
];

/** Neon's pooled connection string. The Vercel Neon integration sets DATABASE_URL (and POSTGRES_URL). */
export const databaseUrl = () => (process.env.DATABASE_URL || process.env.POSTGRES_URL || "").trim();

let override: Db | null | undefined;
let cached: Db | null | undefined;
const ready = new WeakMap<Db, Promise<void>>();

/** Tests inject a Db (or null to simulate "no database"); pass undefined to restore normal behaviour. */
export function setDb(d: Db | null | undefined) {
  override = d;
}

/** The configured database, or null when none is set (development then falls back to local files). */
export function db(): Db | null {
  if (override !== undefined) return override;
  if (cached !== undefined) return cached;
  const url = databaseUrl();
  if (!url) return (cached = null);
  const sql = neon(url);
  return (cached = { query: async (text, params = []) => (await sql.query(text, params as any[])) as Row[] });
}

export const hasDb = () => db() !== null;

/** A Db that creates the tables on first use. For callers that need a synchronous handle (the job queue). */
export function lazyDb(): Db | null {
  if (!db()) return null;
  return {
    query: async (text, params) => {
      const d = (await getDb())!;
      return d.query(text, params);
    },
  };
}

/** Creates the tables if they do not exist yet, once per process. Returns the database, or null if none. */
export async function getDb(): Promise<Db | null> {
  const d = db();
  if (!d) return null;
  let p = ready.get(d);
  if (!p) {
    p = (async () => {
      for (const stmt of SCHEMA) await d.query(stmt);
    })();
    ready.set(d, p);
    p.catch(() => ready.delete(d)); // a failed attempt (network blip) must be retried next time
  }
  await p;
  return d;
}

export async function requireDb(): Promise<Db> {
  const d = await getDb();
  if (!d) throw new Error("DATABASE_URL is not configured");
  return d;
}
