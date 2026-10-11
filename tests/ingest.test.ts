import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Domain, type Paper } from "../lib/schema";
import { isoWeekId, lastCompletedWeek, parseWeekId, arxivStamp } from "../lib/week";
import { buildQuery, parseAtom } from "../lib/sources/arxiv";
import { dedupe, prefilter } from "../lib/pipeline/prefilter";

const domain = Domain.parse({
  id: "rag",
  name: "RAG",
  arxivCats: ["cs.CL"],
  keywords: ["retrieval-augmented generation", "reranking"],
  excludeKeywords: ["image retrieval"],
});

const mk = (o: Partial<Paper>): Paper => ({
  id: "1", title: "", abstract: "", authors: [], published: "2026-10-06T00:00:00Z",
  primaryCategory: "cs.CL", categories: ["cs.CL"], url: "", source: "arxiv", ...o,
});

test("week window: Mon..Sun UTC, ids round-trip", () => {
  const w = lastCompletedWeek(new Date("2026-10-12T02:30:00Z")); // a Monday
  assert.equal(w.week, "2026-W41");
  assert.equal(w.start.toISOString(), "2026-10-05T00:00:00.000Z");
  assert.equal(w.end.toISOString(), "2026-10-11T23:59:59.000Z");
  assert.equal(parseWeekId("2026-W41").start.toISOString(), w.start.toISOString());
  assert.equal(isoWeekId(new Date("2026-01-01T00:00:00Z")), "2026-W01");
  assert.equal(isoWeekId(new Date("2027-01-01T00:00:00Z")), "2026-W53"); // ISO year edge
});

test("a Sunday run still reports the previous completed week", () => {
  assert.equal(lastCompletedWeek(new Date("2026-10-11T22:00:00Z")).week, "2026-W40");
});

test("arXiv query includes categories, quoted keywords and the date range", () => {
  const q = buildQuery(domain, parseWeekId("2026-W41"));
  assert.match(q, /\(cat:cs\.CL\)/);
  assert.match(q, /all:"retrieval-augmented generation"/);
  assert.match(q, /submittedDate:\[202610050000 TO 202610112359\]/);
  assert.equal(arxivStamp(new Date("2026-10-05T00:00:00Z")), "202610050000");
});

test("parses a real arXiv Atom response", () => {
  const { papers, total } = parseAtom(readFileSync(new URL("./fixtures/arxiv-sample.xml", import.meta.url), "utf8"));
  assert.equal(papers.length, 3);
  assert.ok(total >= 3);
  for (const p of papers) {
    assert.match(p.id, /^\d{4}\.\d{4,5}$/, "id has no version suffix");
    assert.ok(p.title && !p.title.includes("\n"), "title whitespace collapsed");
    assert.ok(p.abstract.length > 50);
    assert.ok(p.authors.length > 0);
    assert.ok(p.categories.length > 0);
  }
});

test("rejects garbage instead of returning an empty feed silently", () => {
  assert.throws(() => parseAtom("<html>rate limited</html>"));
});

test("prefilter: title hits beat abstract hits, off-topic dropped, exclude penalised", () => {
  const out = prefilter(
    [
      mk({ id: "a", title: "A study of retrieval-augmented generation", abstract: "We evaluate." }),
      mk({ id: "b", title: "Something else", abstract: "We use reranking once." }),
      mk({ id: "c", title: "Unrelated vision paper", abstract: "Pixels only." }),
      mk({ id: "d", title: "Image retrieval with reranking", abstract: "image retrieval for photos" }),
    ],
    domain,
  );
  assert.deepEqual(out.map((p) => p.id), ["a", "b"]);
  assert.ok(out[0].prefilter.lexical > out[1].prefilter.lexical);
});

test("prefilter: attention is capped so popularity cannot beat relevance", () => {
  const out = prefilter(
    [
      mk({ id: "hot", title: "Reranking trick", abstract: "x", hf: { upvotes: 5000, comments: 0, githubRepo: "g", githubStars: 1 } }),
      mk({ id: "rel", title: "Retrieval-augmented generation and reranking", abstract: "retrieval augmented generation" }),
    ],
    domain,
  );
  assert.equal(out[0].id, "rel");
  assert.ok(out.find((p) => p.id === "hot")!.prefilter.attention <= 2.3);
});

test("prefilter: reserves slots so a keyword-light but widely-upvoted paper is not squeezed out", () => {
  const dense = Array.from({ length: 10 }, (_, i) =>
    mk({ id: `d${i}`, title: "Retrieval-augmented generation retrieval-augmented generation", abstract: "reranking reranking" }),
  );
  const light = mk({ id: "light", title: "Reranking note", abstract: "x", hf: { upvotes: 300, comments: 9, githubRepo: "g", githubStars: 5 } });
  const out = prefilter([...dense, light], domain, 5);
  assert.equal(out.length, 5);
  assert.ok(out.some((p) => p.id === "light"), "high-attention paper must survive the cut");
});

test("dedupe keeps one record per id and preserves the HF signal", () => {
  const hf = { upvotes: 9, comments: 0, githubRepo: null, githubStars: 0 };
  const out = dedupe([mk({ id: "x", source: "hf", hf }), mk({ id: "x", source: "arxiv" })]);
  assert.equal(out.length, 1);
  assert.equal(out[0].source, "arxiv");
  assert.equal(out[0].hf?.upvotes, 9);
});
