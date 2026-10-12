import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { Domain, type Brief, type Paper, type PaperScore } from "../lib/schema";
import { FileKv, MemoryKv, type Kv } from "../lib/jobs/kv";
import { PgKv } from "../lib/db/pgkv";
import { schemaSql, setDb, dbSchema, tbl, type Db } from "../lib/db/client";
import { overLimit, clientId, LIMITS } from "../lib/ratelimit";
import { prefilter, SEMANTIC_ONLY_PERCENTILE } from "../lib/pipeline/prefilter";
import { RANK, effectiveHype, lexicalHype, qualityScore, signalScore } from "../lib/pipeline/rank";
import { cosine, paperText, profileText } from "../lib/ai/embed";
import { tick } from "../lib/jobs/runner";
import type { Ctx } from "../lib/jobs/handlers";
import { parseWeekId } from "../lib/week";

/* ============ Hygiene: development can never write production data ============ */

test("schema: production uses public, everything else defaults to an isolated dev schema", () => {
  const saved = { s: process.env.DB_SCHEMA, n: process.env.NODE_ENV };
  try {
    delete process.env.DB_SCHEMA;
    (process.env as any).NODE_ENV = "production";
    assert.equal(dbSchema(), "public");
    (process.env as any).NODE_ENV = "development";
    assert.equal(dbSchema(), "dev");
    delete (process.env as any).NODE_ENV;
    assert.equal(dbSchema(), "dev", "scripts and tests default to dev too");
    process.env.DB_SCHEMA = "public";
    assert.equal(dbSchema(), "public", "only an explicit choice reaches production");
    process.env.DB_SCHEMA = 'x"; DROP TABLE kv; --';
    assert.throws(() => dbSchema(), /Invalid DB_SCHEMA/, "the schema name cannot inject SQL");
  } finally {
    if (saved.s === undefined) delete process.env.DB_SCHEMA;
    else process.env.DB_SCHEMA = saved.s;
    (process.env as any).NODE_ENV = saved.n;
  }
});

test("schema: data written under dev is invisible under public (same database)", async () => {
  const pg = new PGlite();
  const db: Db = { query: async (t, p) => (await pg.query(t, p as any[])).rows as any[] };
  const saved = process.env.DB_SCHEMA;
  try {
    for (const schema of ["public", "dev"]) for (const s of schemaSql(schema)) await db.query(s);
    process.env.DB_SCHEMA = "dev";
    await new PgKv(db).set("probe", "dev-value");
    assert.equal(tbl("kv"), '"dev".kv');
    process.env.DB_SCHEMA = "public";
    assert.equal(await new PgKv(db).get("probe"), null, "production sees nothing written by development");
    process.env.DB_SCHEMA = "dev";
    assert.equal(await new PgKv(db).get("probe"), "dev-value");
  } finally {
    if (saved === undefined) delete process.env.DB_SCHEMA;
    else process.env.DB_SCHEMA = saved;
  }
});

/* ============ Abuse: limits shared across every server instance ============ */

function incrContract(name: string, make: (now: () => number) => Kv) {
  test(`${name}: incr counts atomically, even under a race, and restarts after expiry`, async () => {
    let t = 1_000_000;
    const kv = make(() => t);
    const results = await Promise.all(Array.from({ length: 10 }, () => kv.incr("c", 60)));
    assert.deepEqual([...results].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], "no lost or duplicated increments");
    t += 61_000;
    assert.equal(await kv.incr("c", 60), 1, "a fresh window starts at 1");
  });
}
incrContract("MemoryKv", (now) => new MemoryKv(now));
incrContract("PgKv", (now) => {
  const pg = new PGlite();
  const db: Db = { query: async (t, p) => (await pg.query(t, p as any[])).rows as any[] };
  const ready = (async () => {
    for (const s of schemaSql()) await db.query(s);
  })();
  const kv = new PgKv(db, now);
  // wait for the schema before the first call
  return new Proxy(kv, { get: (o: any, k) => (typeof o[k] === "function" ? async (...a: any[]) => (await ready, o[k](...a)) : o[k]) });
});
test("FileKv: incr counts and restarts after expiry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rp-incr-"));
  let t = 1_000;
  const kv = new FileKv(dir, () => t);
  assert.equal(await kv.incr("c", 10), 1);
  assert.equal(await kv.incr("c", 10), 2);
  t += 11_000;
  assert.equal(await kv.incr("c", 10), 1);
  rmSync(dir, { recursive: true, force: true });
});

const h = (ip: string) => new Headers({ "x-forwarded-for": `${ip}, 10.0.0.1` });

test("rate limits are per caller, stored (so every server instance shares them), and reset per window", async () => {
  const kv = new MemoryKv();
  const L = { name: "t", max: 3, windowSec: 60, perClient: true };
  const now = 1_000_000_000;
  const a = await Promise.all([1, 2, 3, 4].map(() => overLimit(L, h("1.1.1.1"), { kv, now })));
  assert.deepEqual(a, [false, false, false, true], "fourth call from the same caller is refused");
  assert.equal(await overLimit(L, h("2.2.2.2"), { kv, now }), false, "another caller has its own budget");
  assert.equal(await overLimit(L, h("1.1.1.1"), { kv, now: now + 61_000 }), false, "a new window resets it");
});

test("the daily AI cap is one shared budget for everyone", async () => {
  const kv = new MemoryKv();
  const cap = { ...LIMITS.suggestDaily, max: 2 };
  const now = 1_000_000_000;
  assert.equal(await overLimit(cap, h("1.1.1.1"), { kv, now }), false);
  assert.equal(await overLimit(cap, h("2.2.2.2"), { kv, now }), false);
  assert.equal(await overLimit(cap, h("3.3.3.3"), { kv, now }), true, "a new caller cannot get round the shared cap");
});

test("if storage fails, the limiter still limits (it never fails open)", async () => {
  const broken = { incr: async () => { throw new Error("db down"); } } as unknown as Kv;
  const L = { name: "fallback-test", max: 1, windowSec: 60, perClient: true };
  assert.equal(await overLimit(L, h("9.9.9.9"), { kv: broken, now: 5 }), false);
  assert.equal(await overLimit(L, h("9.9.9.9"), { kv: broken, now: 6 }), true);
});

test("callers are identified by a one-way hash, never the raw IP", () => {
  const id = clientId(h("203.0.113.7"));
  assert.match(id, /^[0-9a-f]{16}$/);
  assert.ok(!id.includes("203"));
  assert.notEqual(id, clientId(h("203.0.113.8")));
});

/* ============ Scoring bias ============ */

const sc = (o: Partial<PaperScore>): PaperScore => ({
  id: "x", relevance: 4, evidence_quality: 4, introduces_benchmark: false, surprising_result: 2, reframing: 2,
  hype_risk: 1, has_benchmark: true, claim_scope: "narrow", rationale: "r", ...o,
});

test("a new benchmark only counts as a strong signal when its evidence is solid", () => {
  assert.equal(signalScore(sc({ introduces_benchmark: true, evidence_quality: 4 })), RANK.benchmarkSignal);
  assert.equal(signalScore(sc({ introduces_benchmark: true, evidence_quality: 3 })), RANK.weakBenchmarkSignal);
  assert.ok(qualityScore(sc({ introduces_benchmark: true, evidence_quality: 2, relevance: 3 })) < RANK.minQuality, "a thin benchmark paper no longer passes on the tag alone");
});

test("hype is checked in code too: promotional wording raises it even when the model says 1", () => {
  assert.equal(lexicalHype("We evaluate on three public benchmarks."), 1);
  assert.equal(lexicalHype("Imagine agile agents on a magic stage."), 1, "no false hits inside ordinary words");
  assert.equal(lexicalHype("We report state-of-the-art accuracy."), 2);
  assert.ok(lexicalHype("An unprecedented breakthrough that solves the problem with human-level skill.") >= 4);
  const calm = "We evaluate on three public benchmarks.";
  const hyped = "An unprecedented, revolutionary breakthrough reaching human-level reasoning.";
  assert.equal(effectiveHype(sc({ hype_risk: 1 }), calm), 1);
  assert.ok(effectiveHype(sc({ hype_risk: 1 }), hyped) >= 4);
  assert.ok(qualityScore(sc({ surprising_result: 4 }), hyped) < qualityScore(sc({ surprising_result: 4 }), calm), "the same scores rank lower with hyped wording");
});

/* ============ Recall: meaning, not only keywords ============ */

const dom = Domain.parse({ id: "rag", name: "Retrieval-augmented generation", keywords: ["retrieval-augmented generation", "rag"], excludeKeywords: ["image retrieval"], arxivCats: ["cs.CL"] });
const paper = (id: string, title: string, abstract: string, sim?: number): Paper => ({
  id, title, abstract, authors: ["A"], published: "2026-10-06T00:00:00Z", primaryCategory: "cs.CL", categories: ["cs.CL"], url: "", source: "arxiv", sim,
});

test("a paper with none of the keywords is shortlisted when its meaning is among the closest", () => {
  const filler = Array.from({ length: 60 }, (_, i) => paper(`f${i}`, `Unrelated study ${i}`, "Protein folding dynamics.", 0.5 + i * 0.001));
  const hidden = paper("hidden", "Grounding LLM answers in fetched documents", "We ground model outputs in passages fetched from a corpus.", 0.95);
  const keyword = paper("kw", "A RAG pipeline", "retrieval-augmented generation for QA", 0.7);
  const out = prefilter([...filler, hidden, keyword], dom, 10);
  const ids = out.map((p) => p.id);
  assert.ok(ids.includes("hidden"), "found by meaning, without any keyword");
  assert.ok(ids.includes("kw"), "keyword papers still qualify");
  assert.ok(!ids.includes("f0"), "dissimilar, keyword-free papers are not let in");
  const h = out.find((p) => p.id === "hidden")!;
  assert.ok(h.prefilter.semantic! >= SEMANTIC_ONLY_PERCENTILE && h.prefilter.lexical === 0);
});

test("an exclude phrase still keeps a paper out, however similar it is", () => {
  const filler = Array.from({ length: 40 }, (_, i) => paper(`f${i}`, `Other ${i}`, "Unrelated.", 0.5));
  const off = paper("off", "Image retrieval at scale", "image retrieval for photo search", 0.99);
  assert.ok(!prefilter([...filler, off], dom, 10).some((p) => p.id === "off"));
});

test("without similarity data the shortlist behaves exactly as keyword-only (graceful fallback)", () => {
  const ps = [paper("a", "A RAG study", "rag rag"), paper("b", "Nothing", "unrelated")];
  const out = prefilter(ps, dom, 10);
  assert.deepEqual(out.map((p) => p.id), ["a"]);
  assert.equal(out[0].prefilter.semantic, undefined);
});

test("embedding helpers: cosine is correct, texts include what matters", () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([0, 0], [1, 1]), 0, "no division by zero");
  assert.match(profileText(dom), /Retrieval-augmented generation.*Topics: retrieval-augmented generation, rag/);
  assert.ok(paperText({ title: "T", abstract: "x".repeat(5000) }).length < 1000, "long abstracts are trimmed");
});

test("end to end: the category-wide fetch plus embeddings bring in a keyword-free relevant paper", async () => {
  const WEEK = "2026-W40";
  const win = parseWeekId(WEEK);
  const clock = { t: win.end.getTime() + 60_000 };
  const published: Brief[] = [];
  const hidden = paper("2609.9999", "Grounding LLM answers in fetched documents", "We ground model outputs in passages fetched from a corpus.");
  const filler = (i: number) => Array.from({ length: 30 }, (_, k) => paper(`2609.${i}${String(k).padStart(3, "0")}`, `Unrelated study ${i}-${k}`, "Protein folding dynamics."));
  const llm = (async (req: any) => {
    const ids = [...req.prompt.matchAll(/<paper id="([^"]+)"/g)].map((m: any) => m[1]);
    if (req.system.includes("what this week shows")) return req.schema.parse({ takeaway: "", paperIds: [] });
    if (req.system.includes("strict fact-checker")) return req.schema.parse({ results: ids.map((id: string) => ({ id, summary_supported: true, why_supported: true, angle_ok: true, issue: "" })) });
    if (req.system.includes("write short")) return req.schema.parse({ cards: ids.map((id: string) => ({ id, whyItMatters: "w", summary: "s", verdict: "read", clientAngle: "", caveats: "", evidenceQuote: "" })) });
    return req.schema.parse({ scores: ids.map((id: string) => ({ id, relevance: id === "2609.9999" ? 5 : 1, evidence_quality: 4, introduces_benchmark: false, surprising_result: 4, reframing: 2, hype_risk: 1, has_benchmark: true, claim_scope: "narrow", rationale: "r" })) });
  }) as any;
  const ctx: Ctx = {
    kv: new MemoryKv(() => clock.t), llm, now: () => clock.t,
    sources: {
      arxivDay: async () => ({ papers: [] }), // the keyword query finds nothing at all
      arxivDayBroad: async (_d, _w, i) => ({ papers: i === 3 ? [hidden, ...filler(i)] : filler(i) }),
      hf: async () => ({ signals: new Map(), papers: [], ok: true }),
    },
    // similarity: high for the hidden paper, low for the rest
    embed: async (texts) => texts.map((s) => (s.includes("Grounding") || s.includes("Retrieval-augmented") ? [1, 0.1] : [0.1, 1])),
    publish: async (b) => void published.push(b),
    emailConfig: () => ({ ready: false, reason: "test" }),
    sendEmail: async () => ({ id: "x" }),
  };
  for (let i = 0; i < 200; i++) {
    const r = await tick(ctx, { week: WEEK, autoCreate: true, getDomains: async () => [dom], budgetMs: 1e9 });
    if (r.finished) break;
    clock.t += 5 * 60_000;
  }
  const b = published.at(-1)!;
  const shown = [...b.topThree, ...b.sections.flatMap((s) => s.cards)].map((c) => c.arxivId);
  assert.ok(shown.includes("2609.9999"), "a relevant paper with none of the keywords reached the brief");
  setDb(undefined);
});
