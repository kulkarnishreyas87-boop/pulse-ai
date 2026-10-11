/**
 * CLI for step 4: compose the weekly brief from per-domain section results.
 *   npm run compose -- --week 2026-W40
 * Reads .cache/section-<week>-<domain>.json (from `npm run brief`), writes .cache/brief-<week>.json and
 * brief-latest.json for the local page, and publishes to Neon when DATABASE_URL is set.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { Domain } from "../lib/schema";
import { lastCompletedWeek, parseWeekId } from "../lib/week";
import { composeBrief, WORD_BUDGET, type DomainInput } from "../lib/pipeline/compose";
import { publishBrief } from "../lib/store";
import { hasDb } from "../lib/db/client";

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};

async function main() {
  const win = arg("week") ? parseWeekId(arg("week")!) : lastCompletedWeek();
  const domains = z
    .array(Domain)
    .parse(JSON.parse(readFileSync(new URL("../data/domains.default.json", import.meta.url), "utf8")))
    .filter((d) => d.active);

  const inputs: DomainInput[] = [];
  const missing: string[] = [];
  for (const d of domains) {
    const sf = new URL(`../.cache/section-${win.week}-${d.id}.json`, import.meta.url);
    const inf = new URL(`../.cache/ingest-${win.week}-${d.id}.json`, import.meta.url);
    if (!existsSync(sf)) {
      missing.push(d.name);
      continue;
    }
    const res = JSON.parse(readFileSync(sf, "utf8"));
    const ingest = existsSync(inf) ? JSON.parse(readFileSync(inf, "utf8")) : null;
    inputs.push({
      section: res.section,
      ranked: res.ranked,
      stale: ingest?.stale ?? false,
      papersSeen: ingest?.stats.afterDedupe ?? 0,
      papersScored: res.stats.scored,
    });
  }
  if (!inputs.length) throw new Error(`No section results for ${win.week}. Run: npm run brief -- --all --week ${win.week}`);

  const brief = composeBrief(inputs, win, { missingDomains: missing });
  const json = JSON.stringify(brief, null, 2);
  writeFileSync(new URL(`../.cache/brief-${win.week}.json`, import.meta.url), json);
  writeFileSync(new URL(`../.cache/brief-latest.json`, import.meta.url), json);

  const m = brief.meta;
  console.log(`Week ${brief.week}: ${m.wordCount} words (~${m.readingMinutes} min, budget ${WORD_BUDGET}), ${m.papersSeen} papers seen, ${m.papersScored} scored`);
  console.log(`Top three:\n${brief.topThree.map((c) => `  - [${c.domain}] ${c.title}`).join("\n")}`);
  for (const s of brief.sections) console.log(`  ${s.domainName}: ${s.status}, ${s.cards.length} cards${s.featured.length ? ` (+${s.featured.length} featured above)` : ""}`);
  console.log(`Dropped for budget: ${m.droppedForBudget}, duplicates removed: ${m.duplicatesRemoved}`);
  if (missing.length) console.log(`MISSING domains (brief marked partial): ${missing.join(", ")}`);

  if (hasDb()) {
    await publishBrief(brief);
    console.log("Published to Neon.");
  } else {
    console.log("DATABASE_URL not set: saved locally only (.cache/brief-latest.json, shown by the dev page).");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
