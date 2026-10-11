/**
 * Scores the pipeline against hand labels.
 *   npm run eval -- --init --week 2026-W40     writes eval/golden.json from the ranked papers, labels blank
 *   npm run eval -- --week 2026-W40            reports recall and precision per domain
 *
 * The labels are YOUR judgement of what a good analyst would not want to miss ("must") or would
 * consider noise or hype ("should_not"). Nothing here invents them.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { evaluate, type GoldenItem } from "../eval/metrics";
import { lastCompletedWeek } from "../lib/week";

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const week = arg("week") ?? lastCompletedWeek().week;
const GOLDEN = new URL("../eval/golden.json", import.meta.url);
const DOMAINS = ["agents", "rag", "code", "cv-industrial"];

function loadSection(domain: string) {
  const f = new URL(`../.cache/section-${week}-${domain}.json`, import.meta.url);
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
}

if (process.argv.includes("--init")) {
  const labels: (GoldenItem & { title: string; pipelineSaid: string })[] = [];
  for (const d of DOMAINS) {
    const s = loadSection(d);
    if (!s) continue;
    for (const r of s.ranked) {
      labels.push({ id: r.paper.id, domain: d, label: "neutral", note: "", title: r.paper.title, pipelineSaid: r.passes ? "passed" : r.why });
    }
  }
  writeFileSync(GOLDEN, JSON.stringify({ week, labels }, null, 2));
  console.log(`Wrote eval/golden.json with ${labels.length} papers. Set each label to "must", "should_not" or leave "neutral".`);
} else {
  if (!existsSync(GOLDEN)) throw new Error("eval/golden.json not found. Run with --init first, then label papers.");
  const golden: GoldenItem[] = JSON.parse(readFileSync(GOLDEN, "utf8")).labels;
  const fmt = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(0)}%`);
  for (const d of DOMAINS) {
    const s = loadSection(d);
    if (!s) continue;
    const r = evaluate(d, s.section.cards.map((c: any) => c.arxivId), golden);
    console.log(`${d.padEnd(14)} recall ${fmt(r.recall)} (${r.mustFound}/${r.mustTotal})  precision ${fmt(r.precision)}  noise-in-brief ${r.shouldNotSelected}`);
    if (r.missed.length) console.log(`   missed: ${r.missed.join(", ")}`);
    if (r.wrongly.length) console.log(`   wrongly included: ${r.wrongly.join(", ")}`);
  }
}
