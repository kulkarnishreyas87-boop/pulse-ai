import { neon } from "@neondatabase/serverless";

export type Row = Record<string, any>;

/** The only thing the app needs from Postgres. Neon's HTTP driver implements it in production, PGlite in tests. */
export interface Db {
  query(text: string, params?: unknown[]): Promise<Row[]>;
}

/**
 * Which Postgres schema the app reads and writes. Production uses "public" (the live data). Everything
 * else (local dev, CLI scripts, experiments) defaults to "dev", so nothing run on a laptop can touch
 * production data unless DB_SCHEMA=public is set on purpose.
 */
export function dbSchema(): string {
  const s = (process.env.DB_SCHEMA || (process.env.NODE_ENV === "production" ? "public" : "dev")).trim();
  if (!/^[a-z_][a-z0-9_]{0,40}$/.test(s)) throw new Error(`Invalid DB_SCHEMA "${s}"`);
  return s;
}

/** Schema-qualified table name, for building queries. */
export const tbl = (name: "kv" | "briefs" | "domains") => `"${dbSchema()}".${name}`;

/**
 * Tables:
 *  - kv:      the job queue's state, leases, cached scores, rate-limit counters and working data (TTL'd).
 *  - briefs:  every published weekly brief, the archive the web page reads.
 *  - domains: Kavita's monitored domains, edited on the Settings page.
 * Each statement is idempotent, so running them on every cold start is safe.
 */
export function schemaSql(schema = dbSchema()): string[] {
  const q = (n: string) => `"${schema}".${n}`;
  return [
    `CREATE SCHEMA IF NOT EXISTS "${schema}"`,
    `CREATE TABLE IF NOT EXISTS ${q("kv")} (
       key        text PRIMARY KEY,
       value      jsonb NOT NULL,
       expires_at timestamptz
     )`,
    `CREATE INDEX IF NOT EXISTS kv_expires_idx ON ${q("kv")} (expires_at) WHERE expires_at IS NOT NULL`,
    `CREATE TABLE IF NOT EXISTS ${q("briefs")} (
       week         text PRIMARY KEY,
       window_start timestamptz NOT NULL,
       published_at timestamptz NOT NULL DEFAULT now(),
       brief        jsonb NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS briefs_window_idx ON ${q("briefs")} (window_start DESC)`,
    `CREATE TABLE IF NOT EXISTS ${q("domains")} (
       id         text PRIMARY KEY,
       position   integer NOT NULL,
       config     jsonb NOT NULL,
       updated_at timestamptz NOT NULL DEFAULT now()
     )`,
  ];
}

/** Neon's pooled connection string. The Vercel Neon integration sets DATABASE_URL (and POSTGRES_URL). */
export const databaseUrl = () => (process.env.DATABASE_URL || process.env.POSTGRES_URL || "").trim();

let override: Db | null | undefined;
let cached: Db | null | undefined;
// schema setup runs once per database and schema
const ready = new WeakMap<Db, Map<string, Promise<void>>>();

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
  const schema = dbSchema();
  let perDb = ready.get(d);
  if (!perDb) ready.set(d, (perDb = new Map()));
  let p = perDb.get(schema);
  if (!p) {
    p = (async () => {
      for (const stmt of schemaSql(schema)) await d.query(stmt);
    })();
    perDb.set(schema, p);
    p.catch(() => perDb!.delete(schema)); // a failed attempt (network blip) must be retried next time
  }
  await p;
  return d;
}

export async function requireDb(): Promise<Db> {
  const d = await getDb();
  if (!d) throw new Error("DATABASE_URL is not configured");
  return d;
}
