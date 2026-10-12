import { z } from "zod";
import defaults from "@/data/domains.default.json";
import { Domain } from "./schema";
import { isKnownCategory } from "./arxivCategories";
import { hasDb, requireDb } from "./db/client";
import { loadDomains, loadDomainsBackup, replaceDomains, saveDomainsBackup } from "./db/repo";

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

async function devBackupFile() {
  const { join } = await import("node:path");
  return join(process.cwd(), ".cache", "domains.previous.json");
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

async function writeBackup(list: Domain[]): Promise<void> {
  if (hasDb()) return saveDomainsBackup(await requireDb(), list);
  if (process.env.NODE_ENV !== "production") {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    const file = await devBackupFile();
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(list, null, 2));
  }
}

/** The list as it was before the last save, or null if there has been no save yet. */
export async function getPreviousDomains(): Promise<Domain[] | null> {
  try {
    let raw: unknown = null;
    if (hasDb()) raw = await loadDomainsBackup(await requireDb());
    else if (process.env.NODE_ENV !== "production") {
      const { readFile } = await import("node:fs/promises");
      raw = JSON.parse(await readFile(await devBackupFile(), "utf8"));
    }
    const parsed = DomainList.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Saves a new domain list. Settings has no passcode (the owner's choice), so every save first keeps
 * the current list as a backup: any change, by anyone, can be undone in one click.
 */
export async function saveDomains(list: Domain[]): Promise<DomainSource> {
  const valid = DomainList.parse(list);
  const current = (await getDomains()).domains;
  await writeBackup(current);
  return writeList(valid);
}

/** Swaps the current list with the backup. Pressing undo twice re-applies the change. */
export async function undoDomains(): Promise<Domain[]> {
  const previous = await getPreviousDomains();
  if (!previous) throw new Error("There is no earlier version to restore.");
  const current = (await getDomains()).domains;
  await writeList(previous);
  await writeBackup(current);
  return previous;
}
