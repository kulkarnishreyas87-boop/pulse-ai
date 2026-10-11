import seed from "@/data/seed/brief.json";
import { Brief } from "./schema";
import { getDb, hasDb, requireDb } from "./db/client";
import { loadBrief, loadLatestBrief, loadWeeks, saveBrief } from "./db/repo";

export const seedBrief: Brief = Brief.parse(seed);

/**
 * Local development only: when no database is configured, read the brief the compose CLI wrote to
 * .cache so the page can show real data. Never used in production, where Neon is the source.
 */
async function devFileBrief(week?: string): Promise<Brief | null> {
  if (process.env.NODE_ENV === "production") return null;
  try {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const file = join(process.cwd(), ".cache", week ? `brief-${week}.json` : "brief-latest.json");
    const parsed = Brief.safeParse(JSON.parse(await readFile(file, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function getBrief(week: string): Promise<Brief | null> {
  if (!hasDb()) return devFileBrief(week);
  try {
    const d = await getDb();
    const parsed = Brief.safeParse(d ? await loadBrief(d, week) : null);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The newest brief. If the database is down or empty the page still shows something: the sample brief. */
export async function getLatestBrief(): Promise<Brief> {
  if (!hasDb()) return (await devFileBrief()) ?? seedBrief;
  try {
    const d = await getDb();
    const parsed = Brief.safeParse(d ? await loadLatestBrief(d) : null);
    return parsed.success ? parsed.data : seedBrief;
  } catch {
    return seedBrief; // storage down: show the last known good content, labelled as sample data
  }
}

/** Weeks that have a stored brief, newest first. */
export async function listWeeks(): Promise<string[]> {
  if (!hasDb()) return [];
  try {
    const d = await getDb();
    return d ? await loadWeeks(d) : [];
  } catch {
    return [];
  }
}

/** Saves a composed brief. Idempotent: publishing the same week again replaces it. */
export async function publishBrief(brief: Brief): Promise<void> {
  await saveBrief(await requireDb(), Brief.parse(brief));
}
