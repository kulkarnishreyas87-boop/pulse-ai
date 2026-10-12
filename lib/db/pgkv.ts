import { tbl, type Db } from "./client";
import type { Kv } from "../jobs/kv";

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * The job queue's storage on Postgres. `setNx` is one atomic statement:
 * insert, or take over the row ONLY if the existing one has expired. Postgres serialises concurrent
 * inserts on the same key, so exactly one caller can win a lease. That statement is what makes
 * claiming a job safe when several serverless invocations race. `incr` is atomic the same way, which
 * makes rate limits shared across every serverless instance.
 */
export class PgKv implements Kv {
  constructor(private d: Db, private now: () => number = Date.now) {}

  async get<T>(key: string): Promise<T | null> {
    const rows = await this.d.query(
      `SELECT value FROM ${tbl("kv")} WHERE key = $1 AND (expires_at IS NULL OR expires_at > $2::timestamptz)`,
      [key, iso(this.now())],
    );
    return rows.length ? (rows[0].value as T) : null;
  }

  async mget<T>(keys: string[]): Promise<(T | null)[]> {
    if (!keys.length) return [];
    const found = new Map<string, T>();
    for (let i = 0; i < keys.length; i += 200) {
      const rows = await this.d.query(
        `SELECT key, value FROM ${tbl("kv")} WHERE key = ANY($1::text[]) AND (expires_at IS NULL OR expires_at > $2::timestamptz)`,
        [keys.slice(i, i + 200), iso(this.now())],
      );
      for (const r of rows) found.set(r.key, r.value as T);
    }
    return keys.map((k) => found.get(k) ?? null);
  }

  async set(key: string, value: unknown, ttlSec = 0): Promise<void> {
    await this.d.query(
      `INSERT INTO ${tbl("kv")} AS k (key, value, expires_at) VALUES ($1, $2::jsonb, $3::timestamptz)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at`,
      [key, JSON.stringify(value), ttlSec ? iso(this.now() + ttlSec * 1000) : null],
    );
  }

  async setNx(key: string, value: unknown, ttlSec: number): Promise<boolean> {
    const rows = await this.d.query(
      `INSERT INTO ${tbl("kv")} AS k (key, value, expires_at) VALUES ($1, $2::jsonb, $3::timestamptz)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at
         WHERE k.expires_at IS NOT NULL AND k.expires_at <= $4::timestamptz
       RETURNING key`,
      [key, JSON.stringify(value), iso(this.now() + ttlSec * 1000), iso(this.now())],
    );
    return rows.length > 0;
  }

  /** Atomically adds one and returns the new count; an expired counter starts again at 1. */
  async incr(key: string, ttlSec: number): Promise<number> {
    const rows = await this.d.query(
      `INSERT INTO ${tbl("kv")} AS k (key, value, expires_at) VALUES ($1, '1'::jsonb, $2::timestamptz)
       ON CONFLICT (key) DO UPDATE SET
         value = CASE WHEN k.expires_at IS NOT NULL AND k.expires_at <= $3::timestamptz THEN '1'::jsonb
                      ELSE to_jsonb((k.value #>> '{}')::int + 1) END,
         expires_at = CASE WHEN k.expires_at IS NOT NULL AND k.expires_at <= $3::timestamptz THEN EXCLUDED.expires_at
                      ELSE k.expires_at END
       RETURNING (value #>> '{}')::int AS n`,
      [key, iso(this.now() + ttlSec * 1000), iso(this.now())],
    );
    return Number(rows[0].n);
  }

  async del(key: string): Promise<void> {
    await this.d.query(`DELETE FROM ${tbl("kv")} WHERE key = $1`, [key]);
  }

  /** Housekeeping: remove rows that expired more than a day ago so the table does not grow without bound. */
  async sweep(): Promise<number> {
    const rows = await this.d.query(`DELETE FROM ${tbl("kv")} WHERE expires_at IS NOT NULL AND expires_at < $1::timestamptz RETURNING key`, [
      iso(this.now() - 86_400_000),
    ]);
    return rows.length;
  }
}
