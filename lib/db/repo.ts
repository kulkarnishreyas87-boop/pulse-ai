import type { Brief, Domain } from "../schema";
import type { Db } from "./client";

/* Briefs: one row per week. "Latest" is simply the newest window, so re-running an old week can never hide this week. */

export async function saveBrief(d: Db, brief: Brief): Promise<void> {
  await d.query(
    `INSERT INTO briefs (week, window_start, brief, published_at) VALUES ($1, $2::timestamptz, $3::jsonb, now())
     ON CONFLICT (week) DO UPDATE SET brief = EXCLUDED.brief, window_start = EXCLUDED.window_start, published_at = now()`,
    [brief.week, brief.windowStart, JSON.stringify(brief)],
  );
}

export async function loadBrief(d: Db, week: string): Promise<unknown | null> {
  const rows = await d.query(`SELECT brief FROM briefs WHERE week = $1`, [week]);
  return rows.length ? rows[0].brief : null;
}

export async function loadLatestBrief(d: Db): Promise<unknown | null> {
  const rows = await d.query(`SELECT brief FROM briefs ORDER BY window_start DESC LIMIT 1`);
  return rows.length ? rows[0].brief : null;
}

export async function loadWeeks(d: Db, limit = 52): Promise<string[]> {
  const rows = await d.query(`SELECT week FROM briefs ORDER BY window_start DESC LIMIT $1`, [limit]);
  return rows.map((r) => r.week as string);
}

/* Domains: ordered rows. */

export async function loadDomains(d: Db): Promise<unknown[]> {
  const rows = await d.query(`SELECT config FROM domains ORDER BY position`);
  return rows.map((r) => r.config);
}

/** Upserts every domain with its position, then removes the ones that are gone. */
export async function replaceDomains(d: Db, list: Domain[]): Promise<void> {
  for (let i = 0; i < list.length; i++) {
    await d.query(
      `INSERT INTO domains (id, position, config, updated_at) VALUES ($1, $2, $3::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET position = EXCLUDED.position, config = EXCLUDED.config, updated_at = now()`,
      [list[i].id, i, JSON.stringify(list[i])],
    );
  }
  await d.query(`DELETE FROM domains WHERE id <> ALL($1::text[])`, [list.map((x) => x.id)]);
}
