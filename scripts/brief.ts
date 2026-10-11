/**
 * CLI for step 3: score, rank, write and verify one domain with Gemini Flash.
 *   npm run brief -- --domain rag
 *   npm run brief -- --domain agents --week 2026-W40
 *   npm run brief -- --all
 * Needs GEMINI_API_KEY in .env.local. Reuses .cache/ingest-*.json when present, and caches scores
 * in .cache/scores.json so re-runs do not spend quota.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { Domain, type PaperScore } from "../lib/schema";
import { lastCompletedWeek, parseWeekId } from "../lib/week";
import { runIngest, type IngestResult } from "../lib/pipeline/ingest";
import { buildSection } from "../lib/pipeline/domainBrief";
import type { ScoreCache } from "../lib/pipeline/judge";
import { generateJson, geminiModel } from "../lib/ai/gemini";

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const flag = (n: string) => process.argv.includes(`--${n}`);

const CACHE_DIR = new URL("../.cache/", import.meta.url);
const SCORES = new URL("scores.json", CACHE_DIR);

function fileScoreCache(): ScoreCache {
  mkdirSync(CACHE_DIR, { recursive: true });
  const data: Record<string, PaperScore> = existsSync(SCORES) ? JSON.parse(readFileSync(SCORES, "utf8")) : {};
  return {
    async get(k) {
      return data[k];
    },
    async set(k, s) {
      data[k] = s;
      writeFileSync(SCORES, JSON.stringify(data));
    },
  };
}

async function main() {
  if (!process.env.GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY is not set. Copy .env.example to .env.local and add your key.");
    process.exit(1);
  }
  const domains = z
    .array(Domain)
    .parse(JSON.parse(readFileSync(new URL("../data/domains.default.json", import.meta.url), "utf8")));
  const chosen = flag("all") ? domains : domains.filter((d) => d.id === (arg("domain") ?? domains[0].id));
  if (!chosen.length) throw new Error(`Unknown domain. Options: ${domains.map((d) => d.id).join(", ")}`);
  const win = arg("week") ? parseWeekId(arg("week")!) : lastCompletedWeek();
  const cache = fileScoreCache();
  console.log(`Model: ${geminiModel}  |  Week ${win.week}`);

  for (const domain of chosen) {
    console.log(`\n=== ${domain.name} ===`);
    const ingestFile = new URL(`ingest-${win.week}-${domain.id}.json`, CACHE_DIR);
    const ingest: IngestResult = existsSync(ingestFile)
      ? JSON.parse(readFileSync(ingestFile, "utf8"))
      : await runIngest(domain, win);
    if (!existsSync(ingestFile)) writeFileSync(ingestFile, JSON.stringify(ingest, null, 2));

    const t0 = Date.now();
    const res = await buildSection(domain, ingest, { llm: generateJson, cache, log: console.log });
    console.log(`status=${res.section.status}  ${((Date.now() - t0) / 1000).toFixed(1)}s`, res.stats);

    console.log("\nRanked (top 12):");
    for (const r of res.ranked.slice(0, 12)) {
      console.log(`  ${r.passes ? "✔" : "·"} ${r.total.toFixed(2)}  ${r.paper.id}  ${r.paper.title.slice(0, 70)}\n       ${r.why}`);
    }
    for (const c of res.section.cards) {
      console.log(`\n[${c.verdict.toUpperCase()}] ${c.title}\n  why: ${c.whyItMatters || "(none)"}\n  summary: ${c.summary}\n  angle: ${c.clientAngle || "(none)"}\n  caveats: ${c.caveats}\n  ${c.confidence}`);
    }
    writeFileSync(new URL(`section-${win.week}-${domain.id}.json`, CACHE_DIR), JSON.stringify(res, null, 2));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
