import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Brief } from "../lib/schema";
import { MAX_QUERY, queryTerms, searchBriefs } from "../lib/search";

const sample = Brief.parse(JSON.parse(readFileSync(join(import.meta.dirname, "..", "data", "seed", "brief.json"), "utf8")));
const older: Brief = { ...structuredClone(sample), week: "2026-W01" };
const firstCard = sample.sections.flatMap((s) => s.cards)[0];
const titleWord = firstCard.title.split(/\s+/).find((w) => /^[A-Za-z]{6,}$/.test(w))!;

test("search: query words are normalised, de-duplicated and bounded", () => {
  assert.deepEqual(queryTerms("  RAG rag  Agents! a "), ["rag", "agents"]);
  assert.ok(queryTerms("word ".repeat(50)).length <= 8);
  assert.ok(queryTerms("x".repeat(500))[0].length <= MAX_QUERY);
  assert.deepEqual(queryTerms("C++ and node.js"), ["c++", "and", "node.js"]);
  assert.deepEqual(queryTerms("   "), []);
});

test("search: finds a paper by a word from its title, case-insensitively, with its domain", () => {
  const { hits } = searchBriefs([sample], titleWord.toUpperCase());
  const hit = hits.find((h) => h.card.arxivId === firstCard.arxivId);
  assert.ok(hit, "the paper is found");
  assert.ok(hit!.domainId && hit!.domainName, "the hit knows its domain, for linking");
});

test("search: every word must match (no noisy partial results)", () => {
  assert.equal(searchBriefs([sample], `${titleWord} zzqqxxnotaword`).hits.length, 0);
});

test("search: a domain name matches as a domain, linking to its page", () => {
  const s = sample.sections[0];
  const { domains } = searchBriefs([sample], s.domainName.split(/\s+/)[0]);
  assert.ok(domains.some((d) => d.domainId === s.domainId));
});

test("search: title matches rank above mentions in the body, and newer weeks win ties", () => {
  const { hits } = searchBriefs([sample, older], titleWord);
  const scores = hits.map((h) => h.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a), "best first");
  const same = hits.filter((h) => h.card.arxivId === firstCard.arxivId);
  assert.equal(same.length, 2, "found in both weeks");
  assert.equal(same[0].week, sample.week, "the newer week first");
});

test("search: top-three cards are not listed twice for the same week", () => {
  const { hits } = searchBriefs([sample], sample.topThree[0]?.title ?? titleWord);
  const keys = hits.map((h) => `${h.week}:${h.card.arxivId}`);
  assert.equal(new Set(keys).size, keys.length);
});

test("search: an empty query returns nothing rather than everything", () => {
  const r = searchBriefs([sample], "");
  assert.equal(r.hits.length + r.domains.length, 0);
});
