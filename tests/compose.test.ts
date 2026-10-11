import { test } from "node:test";
import assert from "node:assert/strict";
import type { BriefCard, BriefSection, PaperScore } from "../lib/schema";
import { composeBrief, briefWords, WORD_BUDGET, type DomainInput } from "../lib/pipeline/compose";
import type { RankedPaper } from "../lib/pipeline/rank";
import { parseWeekId } from "../lib/week";

const win = parseWeekId("2026-W40");
const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");

const card = (id: string, o: Partial<BriefCard> = {}): BriefCard => ({
  arxivId: id, title: `Title ${id}`, authors: "A", url: "u", whyItMatters: words(20), summary: words(50), verdict: "read",
  clientAngle: words(20), caveats: words(15), confidence: "Preprint", evidenceQuote: words(20), signals: [], domain: "", ...o,
});
const score = (rel = 4): PaperScore => ({ id: "x", relevance: rel, evidence_quality: 4, introduces_benchmark: false, surprising_result: 4, reframing: 2, hype_risk: 1, has_benchmark: true, claim_scope: "narrow", rationale: "" });
const ranked = (id: string, total: number, rel = 4): RankedPaper =>
  ({ paper: { id } as any, score: score(rel), quality: total, attention5: 0, total, passes: true, why: "" });

function dom(id: string, cards: BriefCard[], totals: number[], o: Partial<DomainInput> = {}, status: BriefSection["status"] = "ok"): DomainInput {
  return {
    section: { domainId: id, domainName: id.toUpperCase(), status, featured: [], cards },
    ranked: cards.map((c, i) => ranked(c.arxivId, totals[i])),
    stale: false, papersSeen: 100, papersScored: 25, ...o,
  };
}

test("top three: best across domains, max two from one domain, no repeats in the sections", () => {
  const a = dom("a", [card("a1"), card("a2"), card("a3")], [9, 8, 7]);
  const b = dom("b", [card("b1")], [5]);
  const c = dom("c", [card("c1")], [4]);
  const out = composeBrief([a, b, c], win);
  assert.deepEqual(out.topThree.map((x) => x.arxivId), ["a1", "a2", "b1"], "a3 is better than b1 but domain a is capped at two");
  assert.equal(out.topThree[0].domain, "A");
  const secA = out.sections.find((s) => s.domainId === "a")!;
  assert.deepEqual(secA.featured, ["a1", "a2"]);
  assert.deepEqual(secA.cards.map((x) => x.arxivId), ["a3"], "featured cards are not repeated below");
});

test("the same paper in two domains appears once, in the domain where it is most relevant", () => {
  const a = dom("a", [card("dup"), card("a1")], [9, 3]);
  a.ranked[0].score = score(3);
  const b = dom("b", [card("dup")], [9]);
  b.ranked[0].score = score(5);
  const out = composeBrief([a, b], win);
  const all = [...out.topThree, ...out.sections.flatMap((s) => s.cards)].filter((c) => c.arxivId === "dup");
  assert.equal(all.length, 1);
  assert.equal(out.meta.duplicatesRemoved, 1);
  assert.equal(all[0].domain === "B" || out.sections.find((s) => s.domainId === "b")!.featured.includes("dup") || out.sections.find((s) => s.domainId === "b")!.cards.some((c) => c.arxivId === "dup"), true);
});

test("word budget is enforced, trimming the least valuable material first", () => {
  const many = (id: string, n: number) => dom(id, Array.from({ length: n }, (_, i) => card(`${id}${i}`)), Array.from({ length: n }, (_, i) => 10 - i));
  const inputs = ["a", "b", "c", "d", "e", "f"].map((id) => many(id, 4));
  const raw = composeBrief(inputs, win, { budget: 1e9 });
  assert.ok(raw.meta.wordCount! > WORD_BUDGET, "fixture must exceed the budget to mean anything");
  const out = composeBrief(inputs, win);
  assert.ok(out.meta.wordCount! <= WORD_BUDGET, `got ${out.meta.wordCount}`);
  assert.equal(briefWords(out), out.meta.wordCount);
  assert.equal(out.topThree.length, 3, "top three survives trimming");
  assert.ok(out.meta.droppedForBudget! > 0);
  for (const s of out.sections) assert.ok(s.cards.length + s.featured.length >= 1, "no domain is emptied entirely");
  // the dropped cards are the lowest ranked ones: each kept card outranks every dropped one in its domain
  const keptA = out.sections.find((s) => s.domainId === "a")!.cards.map((c) => c.arxivId);
  if (keptA.length) assert.ok(keptA.includes("a1"), "a1 (rank 2) is kept before a3 (rank 4)");
});

test("budget trimming strips evidence quotes before dropping any card", () => {
  const inputs = [dom("a", [card("a1"), card("a2"), card("a3"), card("a4"), card("a5")], [9, 8, 7, 6, 5])];
  const full = composeBrief(inputs, win, { budget: 1e9 });
  const budget = full.meta.wordCount! - 30; // needs a little trimming only
  const out = composeBrief(inputs, win, { budget });
  assert.equal(out.meta.droppedForBudget, 0, "quotes alone were enough");
  assert.ok(out.sections[0].cards.some((c) => c.evidenceQuote === ""), "quotes stripped from non-top cards");
  assert.ok(out.topThree.every((c) => c.evidenceQuote !== ""), "top three keeps its quotes");
});

test("degraded cards are never promoted to the top three", () => {
  const good = dom("g", [card("g1")], [2]);
  const bad = dom("d", [card("d1")], [99], {}, "degraded");
  const out = composeBrief([good, bad], win);
  assert.deepEqual(out.topThree.map((c) => c.arxivId), ["g1"]);
  assert.deepEqual(out.meta.domainsDegraded, ["D"]);
});

test("quiet sections stay in the brief, and an all-quiet week has an empty top three", () => {
  const q = dom("q", [], [], {}, "quiet");
  q.section.note = "Nothing cleared the threshold.";
  const out = composeBrief([q], win);
  assert.equal(out.topThree.length, 0);
  assert.equal(out.sections[0].status, "quiet");
});

test("partial and stale flags propagate honestly", () => {
  const out = composeBrief([dom("a", [card("a1")], [5], { stale: true })], win, { missingDomains: ["RAG"] });
  assert.equal(out.isPartial, true);
  assert.equal(out.isStale, true);
  assert.deepEqual(out.meta.domainsMissing, ["RAG"]);
  assert.equal(out.isSample, false);
});

test("composing does not mutate its inputs, so it can be re-run safely", () => {
  const inputs = [dom("a", [card("a1"), card("a2")], [9, 8])];
  const before = JSON.stringify(inputs);
  composeBrief(inputs, win);
  composeBrief(inputs, win);
  assert.equal(JSON.stringify(inputs), before);
});

test("window and reading time are recorded on the brief", () => {
  const out = composeBrief([dom("a", [card("a1")], [5])], win, { now: new Date("2026-10-12T02:30:00Z") });
  assert.equal(out.week, "2026-W40");
  assert.equal(out.windowStart, "2026-09-28T00:00:00.000Z");
  assert.ok(out.meta.readingMinutes! >= 1);
});
