import { z } from "zod";
import defaults from "@/data/domains.default.json";
import { Domain } from "./schema";
import { isKnownCategory } from "./arxivCategories";
import { hasDb, requireDb } from "./db/client";
import { loadDomainHistory, loadDomains, replaceDomains, saveDomainHistory } from "./db/repo";

export const MAX_DOMAINS = 10;

/** The full domain list, validated. Caps and uniqueness protect cost, the word budget and the query. */
export const DomainList = z
  .array(Domain)
  .min(1, "Keep at least one domain")
  .max(MAX_DOMAINS, `At most ${MAX_DOMAINS} domains`)
  .superRefine((list, ctx) => {
    const ids = new Set<string>();
    const names = new Set<string>();
    list.forEach((d, i) => {
      if (ids.has(d.id)) ctx.addIssue({ code: "custom", message: `Duplicate id "${d.id}"`, path: [i, "id"] });
      if (names.has(d.name.trim().toLowerCase())) ctx.addIssue({ code: "custom", message: `Duplicate name "${d.name}"`, path: [i, "name"] });
      ids.add(d.id);
      names.add(d.name.trim().toLowerCase());
      for (const c of d.arxivCats) {
        if (!isKnownCategory(c)) ctx.addIssue({ code: "custom", message: `Unknown arXiv category "${c}"`, path: [i, "arxivCats"] });
      }
      if (d.active && d.keywords.length === 0) {
        ctx.addIssue({ code: "custom", message: `"${d.name}" needs at least one keyword`, path: [i, "keywords"] });
      }
    });
  });

export function slugify(name: string, taken: Iterable<string> = []): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "domain";
  const used = new Set(taken);
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  return id;
}

export const defaultDomains: Domain[] = DomainList.parse(defaults);

export type DomainSource = "neon" | "dev-file" | "default";

async function devFile() {
  const { join } = await import("node:path");
  return join(process.cwd(), ".cache", "domains.json");
}

/** Neon in production; a local file in development when no database is set; the shipped defaults otherwise. */
export async function getDomains(): Promise<{ domains: Domain[]; source: DomainSource }> {
  if (hasDb()) {
    try {
      const rows = await loadDomains(await requireDb());
      const parsed = DomainList.safeParse(rows);
      if (rows.length && parsed.success) return { domains: parsed.data, source: "neon" };
    } catch {
      /* fall through to defaults: a storage blip must not stop the weekly run */
    }
    return { domains: defaultDomains, source: "default" };
  }
  if (process.env.NODE_ENV !== "production") {
    try {
      const { readFile } = await import("node:fs/promises");
      const parsed = DomainList.safeParse(JSON.parse(await readFile(await devFile(), "utf8")));
      if (parsed.success) return { domains: parsed.data, source: "dev-file" };
    } catch {
      /* no file yet */
    }
  }
  return { domains: defaultDomains, source: "default" };
}

export const HISTORY_DEPTH = 10;

async function devHistoryFile() {
  const { join } = await import("node:path");
  return join(process.cwd(), ".cache", "domains.history.json");
}

/** Writes the list where getDomains reads it from. Throws if there is nowhere durable to write. */
async function writeList(valid: Domain[]): Promise<DomainSource> {
  if (hasDb()) {
    await replaceDomains(await requireDb(), valid);
    return "neon";
  }
  if (process.env.NODE_ENV !== "production") {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    const file = await devFile();
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(valid, null, 2));
    return "dev-file";
  }
  throw new Error("No database is configured. Add DATABASE_URL (your Neon connection string) to save domains.");
}

/** Earlier versions of the list, newest last. Invalid entries are dropped rather than trusted. */
export async function getDomainHistory(): Promise<Domain[][]> {
  let raw: unknown[] = [];
  try {
    if (hasDb()) raw = await loadDomainHistory(await requireDb());
    else if (process.env.NODE_ENV !== "production") {
      const { readFile } = await import("node:fs/promises");
      raw = JSON.parse(await readFile(await devHistoryFile(), "utf8"));
    }
  } catch {
    raw = [];
  }
  return raw.flatMap((x) => {
    const p = DomainList.safeParse(x);
    return p.success ? [p.data] : [];
  });
}

async function writeHistory(history: Domain[][]): Promise<void> {
  const trimmed = history.slice(-HISTORY_DEPTH);
  if (hasDb()) return saveDomainHistory(await requireDb(), trimmed);
  if (process.env.NODE_ENV !== "production") {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    const file = await devHistoryFile();
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(trimmed, null, 2));
  }
}

/** The list as it was before the last save, or null if there has been no save yet. */
export async function getPreviousDomains(): Promise<Domain[] | null> {
  const h = await getDomainHistory();
  return h.length ? h[h.length - 1] : null;
}

/**
 * Saves a new domain list. Settings has no passcode (the owner's choice), so every save first records
 * the current list: the last 10 versions can be walked back one step at a time.
 */
export async function saveDomains(list: Domain[]): Promise<DomainSource> {
  const valid = DomainList.parse(list);
  const current = (await getDomains()).domains;
  const history = await getDomainHistory();
  await writeHistory([...history, current]);
  return writeList(valid);
}

/** Restores the version before the last save and removes it from the history (press again to go further back). */
export async function undoDomains(): Promise<{ domains: Domain[]; remaining: number }> {
  const history = await getDomainHistory();
  const previous = history.pop();
  if (!previous) throw new Error("There is no earlier version to restore.");
  await writeList(previous);
  await writeHistory(history);
  return { domains: previous, remaining: history.length };
}
