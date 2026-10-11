/**
 * Live check of the r2 rubric and the weekly takeaway on real data (needs GEMINI_API_KEY).
 *   npm run rubric-check -- --week 2026-W40
 * Re-scores the cached shortlists (.cache/ingest-<week>-<domain>.json) with the current rubric, prints
 * how spread out each signal is (a rubric that gives everyone the same score cannot rank), how many
 * papers pass per domain, which tags appear, and then writes a takeaway for each cached section.
 */
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { Domain, type PaperScore } from "../lib/schema";
import { generateJson, takeLlmStats } from "../lib/ai/gemini";
import { judgePapers } from "../lib/pipeline/judge";
import { rankPapers, signalScore, signalTags } from "../lib/pipeline/rank";
import { synthesizeSection } from "../lib/pipeline/synthesize";
import { lastCompletedWeek } from "../lib/week";

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const week = arg("week") ?? lastCompletedWeek().week;

const hist = (xs: number[]) => {
  const h: Record<number, number> = {};
  for (const x of xs) h[x] = (h[x] ?? 0) + 1;
  return Object.entries(h).map(([k, v]) => `${k}:${v}`).join(" ");
};
/** Share of papers holding the most common value: 1.0 means the dimension cannot tell papers apart. */
const modeShare = (xs: number[]) => Math.max(...Object.values(xs.reduce<Record<number, number>>((a, x) => ((a[x] = (a[x] ?? 0) + 1), a), {}))) / xs.length;

async function main() {
  const domains = z.array(Domain).parse(JSON.parse(readFileSync("data/domains.default.json", "utf8")));
  const all: PaperScore[] = [];
  const t0 = Date.now();
  for (const d of domains) {
    const f = `.cache/ingest-${week}-${d.id}.json`;
    if (!existsSync(f)) continue;
    const ingest = JSON.parse(readFileSync(f, "utf8"));
    const j = await judgePapers(ingest.shortlist, d, generateJson);
    const scored = ingest.shortlist.flatMap((paper: any) => (j.scores.get(paper.id) ? [{ paper, score: j.scores.get(paper.id)! }] : []));
    const ranked = rankPapers(scored);
    all.push(...scored.map((s: any) => s.score));
    const tags = ranked.flatMap((r) => signalTags(r.score));
    console.log(`\n${d.name}: ${scored.length} scored, ${ranked.filter((r) => r.passes).length} pass. Tags: ${tags.length ? [...new Set(tags)].map((t) => `${t} x${tags.filter((x) => x === t).length}`).join(", ") : "none"}`);
    for (const r of ranked.filter((r) => signalTags(r.score).length).slice(0, 3)) {
      console.log(`   ${signalTags(r.score).join("+")}: ${r.paper.title.slice(0, 70)}\n      "${r.score.rationale.slice(0, 150)}"`);
    }

    const sf = `.cache/section-${week}-${d.id}.json`;
    if (existsSync(sf)) {
      const sec = JSON.parse(readFileSync(sf, "utf8"));
      const s = await synthesizeSection(sec.section, ranked, d, generateJson);
      console.log(s.takeaway ? `   THIS WEEK: ${s.takeaway}  [${s.ids.length} papers]` : `   (no takeaway: ${s.rejected})`);
    }
  }
  const S = (k: keyof PaperScore) => all.map((s) => Number(s[k]));
  console.log(`\n=== r2 rubric over ${all.length} real papers (${((Date.now() - t0) / 1000).toFixed(0)}s) ===`);
  console.log(`surprising_result  ${hist(S("surprising_result"))}   most common value covers ${(modeShare(S("surprising_result")) * 100).toFixed(0)}%`);
  console.log(`reframing          ${hist(S("reframing"))}   most common value covers ${(modeShare(S("reframing")) * 100).toFixed(0)}%`);
  console.log(`introduces_bench   ${all.filter((s) => s.introduces_benchmark).length} of ${all.length}`);
  console.log(`signal (max of 3)  ${hist(all.map(signalScore))}   most common value covers ${(modeShare(all.map(signalScore)) * 100).toFixed(0)}%`);
  console.log(`evidence           ${hist(S("evidence_quality"))}`);
  console.log(`hype               ${hist(S("hype_risk"))}`);
  console.log(`(r1 baseline on the same papers: novelty 3 covered 76%)`);
  const st = takeLlmStats();
  console.log(`AI: ${st.calls} calls, ${st.promptTokens + st.outputTokens} tokens, ${st.retries} retried, ${st.parseFailures} malformed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
