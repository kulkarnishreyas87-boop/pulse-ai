import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { SCHEMA, setDb, getDb, lazyDb, type Db } from "../lib/db/client";
import { PgKv } from "../lib/db/pgkv";
import { Domain, type Paper } from "../lib/schema";
import type { JsonLlm } from "../lib/ai/gemini";
import { getDomains, saveDomains, defaultDomains, getPreviousDomains, undoDomains } from "../lib/domains";
import { getBrief, getLatestBrief, listWeeks, publishBrief, seedBrief } from "../lib/store";
import { tick } from "../lib/jobs/runner";
import { defaultCtx, type Ctx } from "../lib/jobs/handlers";
import { defaultKv } from "../lib/jobs/kv";
import { claimNext, createRun, getRun, listJobs } from "../lib/jobs/queue";
import { loadBrief } from "../lib/db/repo";
import { emailConfig } from "../lib/email/send";
import { parseWeekId } from "../lib/week";

/**
 * These run the application's real storage code on a real Postgres engine (PGlite, in-process).
 * They prove the SQL and the whole weekly pipeline work on Postgres. They do NOT prove connectivity to a
 * Neon server: that needs a DATABASE_URL (see `npm run db -- status`).
 */
let pg: PGlite;
let raw: Db;
before(async () => {
  pg = new PGlite();
  raw = { query: async (t, p) => (await pg.query(t, p as any[])).rows as any[] };
  setDb(raw);
  await getDb(); // creates the schema through the app's own path
});
after(() => setDb(undefined));

const reset = async () => {
  for (const t of ["kv", "briefs", "domains"]) await raw.query(`TRUNCATE ${t}`);
};

test("getDb creates the tables through the app's own path, and lazyDb works on first use", async () => {
  const tables = (await raw.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`)).map((r) => r.table_name);
  for (const t of ["kv", "briefs", "domains"]) assert.ok(tables.includes(t), `missing table ${t}`);
  assert.ok(SCHEMA.length >= 5);
  const lazy = lazyDb()!;
  assert.equal((await lazy.query("SELECT 1 AS n"))[0].n, 1);
});

test("domains: defaults when empty, then saved to Postgres and read back in order, with removal", async () => {
  await reset();
  assert.equal((await getDomains()).source, "default");
  const mk = (id: string, name: string) => Domain.parse({ id, name, keywords: ["abc def"], arxivCats: ["cs.AI"] });
  assert.equal(await saveDomains([mk("b", "Beta"), mk("a", "Alpha")]), "neon");
  const got = await getDomains();
  assert.equal(got.source, "neon");
  assert.deepEqual(got.domains.map((d) => d.id), ["b", "a"]);
  await saveDomains([mk("a", "Alpha 2")]);
  assert.deepEqual((await getDomains()).domains.map((d) => d.name), ["Alpha 2"]);
  assert.ok(defaultDomains.length >= 1);
});

test("undo: every save keeps the previous list, and undo swaps them back (twice re-applies)", async () => {
  await reset();
  const mk = (id: string, name: string) => Domain.parse({ id, name, keywords: ["abc def"], arxivCats: ["cs.AI"] });
  await assert.rejects(undoDomains(), /no earlier version/, "nothing to undo before the first save");
  await saveDomains([mk("a", "Alpha")]);
  const firstPrev = await getPreviousDomains();
  assert.deepEqual(firstPrev!.map((d) => d.id), defaultDomains.map((d) => d.id), "the first save keeps the starter list");
  await saveDomains([mk("a", "Alpha"), mk("b", "Beta")]);
  assert.deepEqual((await getPreviousDomains())!.map((d) => d.id), ["a"]);
  const restored = await undoDomains();
  assert.deepEqual(restored.map((d) => d.id), ["a"]);
  assert.deepEqual((await getDomains()).domains.map((d) => d.id), ["a"], "the live list is the restored one");
  await undoDomains();
  assert.deepEqual((await getDomains()).domains.map((d) => d.id), ["a", "b"], "undo again re-applies the change");
});

test("a vandal deleting every domain is one click from recovery", async () => {
  await reset();
  const mk = (id: string, name: string) => Domain.parse({ id, name, keywords: ["abc def"], arxivCats: ["cs.AI"] });
  await saveDomains([mk("rag", "RAG"), mk("code", "Code")]);
  await saveDomains([Domain.parse({ id: "junk", name: "Junk", keywords: ["spam spam"], arxivCats: [] })]);
  await undoDomains();
  assert.deepEqual((await getDomains()).domains.map((d) => d.id), ["rag", "code"]);
});

test("saveDomains rejects invalid lists before touching the database", async () => {
  await reset();
  await assert.rejects(saveDomains([Domain.parse({ id: "x", name: "Xx", keywords: ["a b c"], arxivCats: ["cs.NOPE"] })]), /Unknown arXiv category/);
  assert.equal((await raw.query("SELECT count(*)::int AS n FROM domains"))[0].n, 0);
});

test("briefs: publish, latest, archive and per-week lookup through the app's store functions", async () => {
  await reset();
  assert.equal((await getLatestBrief()).isSample, true, "empty database shows the labelled sample brief");
  assert.equal(await getBrief("2026-W40"), null);
  const b = (week: string, start: string) => ({ ...seedBrief, week, windowStart: start, isSample: false });
  await publishBrief(b("2026-W39", "2026-09-21T00:00:00.000Z"));
  await publishBrief(b("2026-W40", "2026-09-28T00:00:00.000Z"));
  await publishBrief(b("2026-W40", "2026-09-28T00:00:00.000Z")); // idempotent
  assert.equal((await getLatestBrief()).week, "2026-W40");
  assert.equal((await getBrief("2026-W39"))!.week, "2026-W39");
  assert.deepEqual(await listWeeks(), ["2026-W40", "2026-W39"]);
  assert.equal((await raw.query("SELECT count(*)::int AS n FROM briefs"))[0].n, 2);
});

test("if the database errors, the page falls back to the sample brief instead of crashing", async () => {
  setDb({ query: async () => { throw new Error("connection reset"); } });
  assert.equal((await getLatestBrief()).isSample, true);
  assert.equal(await getBrief("2026-W40"), null);
  assert.deepEqual(await listWeeks(), []);
  assert.equal((await getDomains()).source, "default", "a storage blip must not stop the weekly run");
  setDb(raw);
});

/* ---- the whole weekly pipeline on the Postgres queue ---- */
const WEEK = "2026-W40";
const win = parseWeekId(WEEK);
const domains = ["rag", "agents"].map((id) => Domain.parse({ id, name: id.toUpperCase(), keywords: ["rag", "agent"], arxivCats: ["cs.AI"] }));
const paper = (id: string, title: string): Paper => ({
  id, title, abstract: `${title}. We evaluate on three benchmarks and report 12 percent gains.`, authors: ["A"], published: "2026-09-30T00:00:00Z",
  primaryCategory: "cs.AI", categories: ["cs.AI"], url: `https://arxiv.org/abs/${id}`, source: "arxiv",
});
const fakeLlm = ((async (req: any) => {
  const ids = [...req.prompt.matchAll(/<paper id="([^"]+)"/g)].map((m: any) => m[1]);
  const kind = req.system.includes("strict fact-checker") ? "verify" : req.system.includes("write short") ? "write" : req.system.includes("what this week shows") ? "synth" : "score";
  const out =
    kind === "synth" ? { takeaway: "This week's papers both report gains across three benchmarks.", paperIds: ids.slice(0, 2) }
    : kind === "score" ? { scores: ids.map((id: string) => ({ id, relevance: 5, evidence_quality: 4, introduces_benchmark: false, surprising_result: 4, reframing: 2, hype_risk: 1, has_benchmark: true, claim_scope: "narrow", rationale: "ok" })) }
    : kind === "write" ? { cards: ids.map((id: string) => ({ id, whyItMatters: "Reports 12 percent gains.", summary: "Evaluated on three benchmarks.", verdict: "read", clientAngle: "Relevant if you evaluate.", caveats: "Preprint.", evidenceQuote: "We evaluate on three benchmarks and report 12 percent gains" })) }
    : { results: ids.map((id: string) => ({ id, summary_supported: true, why_supported: true, angle_ok: true, issue: "" })) };
  return req.schema.parse(out);
}) as unknown) as JsonLlm;

const sent: any[] = [];
const pgCtx = (clock: { t: number }): Ctx => ({
  ...defaultCtx(), // real wiring: PgKv from defaultKv(), real publish into the briefs table
  llm: fakeLlm,
  now: () => clock.t,
  sources: {
    arxivDay: async (d, _w, i) => ({ papers: [paper(`2609.${d.id === "rag" ? 1 : 2}${i}01`, `${d.name} rag agent study ${i}a`), paper(`2609.${d.id === "rag" ? 1 : 2}${i}02`, `${d.name} rag agent study ${i}b`)] }),
    hf: async () => ({ signals: new Map(), papers: [], ok: true }),
  },
  emailConfig: () => emailConfig({ RESEND_API_KEY: "k", EMAIL_TO: "me@example.com", APP_URL: "https://pulse.example.com" }),
  sendEmail: async (_c, m) => (sent.push(m), { id: `em_${sent.length}` }),
});

test("defaultKv() is the Postgres queue when a database is configured", () => {
  assert.ok(defaultKv() instanceof PgKv);
});

test("a full week runs on Postgres and publishes into the briefs table, then emails exactly once", async () => {
  await reset();
  sent.length = 0;
  const clock = { t: win.end.getTime() + 60_000 };
  const ctx = pgCtx(clock);
  let last;
  for (let i = 0; i < 200; i++) {
    last = await tick(ctx, { week: WEEK, autoCreate: true, getDomains: async () => domains, budgetMs: 1e9 });
    if (last.finished) break;
    clock.t += 5 * 60_000;
  }
  assert.ok(last!.finished, "the queue drains to completion");
  assert.equal(last!.counts!.failed, 0);

  const stored: any = await loadBrief(raw, WEEK);
  assert.ok(stored, "brief is in the briefs table");
  assert.equal(stored.isPartial, false);
  assert.equal(stored.sections.length, 2);
  assert.equal((await getLatestBrief()).week, WEEK, "the page's own read path returns it");
  assert.equal(sent.length, 1, "one email");
  assert.deepEqual(sent[0].to, ["me@example.com"]);

  // a second tick after completion does nothing, so nothing is re-published or re-sent
  const again = await tick(ctx, { week: WEEK, autoCreate: true, getDomains: async () => domains, budgetMs: 1e9 });
  assert.equal(again.ran.length, 0);
  assert.equal(sent.length, 1);

  // all state lives in Postgres rows
  const n = (await raw.query("SELECT count(*)::int AS n FROM kv"))[0].n;
  assert.ok(n > 50, `queue state is stored as kv rows (${n})`);
});

test("on Postgres, concurrent workers claim distinct jobs and the run is created once", async () => {
  await reset();
  const clock = { t: win.end.getTime() + 60_000 };
  const ctx = pgCtx(clock);
  const results = await Promise.all(Array.from({ length: 6 }, () => tick(ctx, { week: WEEK, autoCreate: true, getDomains: async () => domains, budgetMs: 0 })));
  assert.equal(results.filter((r) => r.created).length, 1, "created exactly once");
  const run = (await getRun(ctx.kv, WEEK))!;
  const claims = (await Promise.all(Array.from({ length: 10 }, (_, i) => claimNext(ctx.kv, run, `w${i}`, clock.t)))).filter(Boolean);
  const ids = claims.map((j) => j!.id);
  assert.equal(new Set(ids).size, ids.length, "no job claimed twice");
  assert.ok(ids.length > 0);
  const jobs = await listJobs(ctx.kv, run);
  assert.equal(jobs.filter((j) => j.status === "running").length, ids.length);
  void createRun;
});
