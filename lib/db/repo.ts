import type { Brief, Domain } from "../schema";
import { tbl, type Db } from "./client";

/* Briefs: one row per week. "Latest" is simply the newest window, so re-running an old week can never hide this week. */

export async function saveBrief(d: Db, brief: Brief): Promise<void> {
  await d.query(
    `INSERT INTO ${tbl("briefs")} AS b (week, window_start, brief, published_at) VALUES ($1, $2::timestamptz, $3::jsonb, now())
     ON CONFLICT (week) DO UPDATE SET brief = EXCLUDED.brief, window_start = EXCLUDED.window_start, published_at = now()`,
    [brief.week, brief.windowStart, JSON.stringify(brief)],
  );
}

export async function loadBrief(d: Db, week: string): Promise<unknown | null> {
  const rows = await d.query(`SELECT brief FROM ${tbl("briefs")} WHERE week = $1`, [week]);
  return rows.length ? rows[0].brief : null;
}

export async function loadLatestBrief(d: Db): Promise<unknown | null> {
  const rows = await d.query(`SELECT brief FROM ${tbl("briefs")} ORDER BY window_start DESC LIMIT 1`);
  return rows.length ? rows[0].brief : null;
}

export async function loadWeeks(d: Db, limit = 52): Promise<string[]> {
  const rows = await d.query(`SELECT week FROM ${tbl("briefs")} ORDER BY window_start DESC LIMIT $1`, [limit]);
  return rows.map((r) => r.week as string);
}

/* Domains: ordered rows. */

export async function loadDomains(d: Db): Promise<unknown[]> {
  const rows = await d.query(`SELECT config FROM ${tbl("domains")} ORDER BY position`);
  return rows.map((r) => r.config);
}

/** Upserts every domain with its position, then removes the ones that are gone. */
export async function replaceDomains(d: Db, list: Domain[]): Promise<void> {
  for (let i = 0; i < list.length; i++) {
    await d.query(
      `INSERT INTO ${tbl("domains")} AS x (id, position, config, updated_at) VALUES ($1, $2, $3::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET position = EXCLUDED.position, config = EXCLUDED.config, updated_at = now()`,
      [list[i].id, i, JSON.stringify(list[i])],
    );
  }
  await d.query(`DELETE FROM ${tbl("domains")} WHERE id <> ALL($1::text[])`, [list.map((x) => x.id)]);
}

/*
 * Undo history: the domain lists as they were before each of the last saves, newest last. Several
 * steps are kept, so even a run of bad saves (by anyone, since Settings is open) can be walked back.
 */

const HISTORY_KEY = "domains:history";
const LEGACY_BACKUP_KEY = "domains:previous";

export async function loadDomainHistory(d: Db): Promise<unknown[]> {
  const rows = await d.query(`SELECT key, value FROM ${tbl("kv")} WHERE key = ANY($1::text[])`, [[HISTORY_KEY, LEGACY_BACKUP_KEY]]);
  const history = rows.find((r) => r.key === HISTORY_KEY)?.value;
  if (Array.isArray(history)) return history;
  const legacy = rows.find((r) => r.key === LEGACY_BACKUP_KEY)?.value; // the single backup kept by the previous version
  return legacy ? [legacy] : [];
}

export async function saveDomainHistory(d: Db, history: unknown[]): Promise<void> {
  await d.query(
    `INSERT INTO ${tbl("kv")} AS k (key, value, expires_at) VALUES ($1, $2::jsonb, NULL)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = NULL`,
    [HISTORY_KEY, JSON.stringify(history)],
  );
  await d.query(`DELETE FROM ${tbl("kv")} WHERE key = $1`, [LEGACY_BACKUP_KEY]);
}
