/**
 * CLI for step 2: fetch a week of papers for one domain, prefilter, print the shortlist.
 *   npm run ingest -- --domain rag
 *   npm run ingest -- --domain agents --week 2026-W40 --top 25
 * Writes the full result to .cache/ so later steps (and you) can inspect it.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { Domain } from "../lib/schema";
import { lastCompletedWeek, parseWeekId } from "../lib/week";
import { runIngest } from "../lib/pipeline/ingest";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const domains = z
    .array(Domain)
    .parse(JSON.parse(readFileSync(new URL("../data/domains.default.json", import.meta.url), "utf8")));
  const id = arg("domain") ?? domains[0].id;
  const domain = domains.find((d) => d.id === id);
  if (!domain) throw new Error(`Unknown domain "${id}". Options: ${domains.map((d) => d.id).join(", ")}`);

  const win = arg("week") ? parseWeekId(arg("week")!) : lastCompletedWeek();
  const top = Number(arg("top") ?? 25);

  console.log(`\nDomain: ${domain.name}  |  Week ${win.week}  (${win.start.toISOString()} to ${win.end.toISOString()})`);
  const t0 = Date.now();
  const res = await runIngest(domain, win, { topN: top });
  console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log("Query:", res.query || "(arXiv unavailable)");
  console.log("Stats:", res.stats, res.stale ? "\n!! STALE: arXiv failed, results rest on Hugging Face only" : "");

  console.log("\n  score  lex  attn  hf↑  id           title");
  for (const p of res.shortlist) {
    const s = p.prefilter;
    console.log(
      `  ${s.total.toFixed(1).padStart(5)}  ${String(s.lexical).padStart(3)}  ${s.attention.toFixed(1).padStart(4)}  ${String(p.hf?.upvotes ?? 0).padStart(3)}  ${p.id.padEnd(11)}  ${p.title.slice(0, 78)}`,
    );
  }

  mkdirSync(new URL("../.cache/", import.meta.url), { recursive: true });
  const out = new URL(`../.cache/ingest-${win.week}-${domain.id}.json`, import.meta.url);
  writeFileSync(out, JSON.stringify(res, null, 2));
  console.log(`\nSaved ${out.pathname.replace(/^\/([A-Za-z]:)/, "$1")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
