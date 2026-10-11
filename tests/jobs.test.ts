import { test } from "node:test";
import assert from "node:assert/strict";
import { Domain, type Brief, type Paper } from "../lib/schema";
import type { JsonLlm } from "../lib/ai/gemini";
import { MemoryKv } from "../lib/jobs/kv";
import { LEASE_SEC, maxAttempts, claimNext, createRun, getRun, keys, listJobs, markDone, markFailed, type Job } from "../lib/jobs/queue";
import { tick } from "../lib/jobs/runner";
import type { Ctx } from "../lib/jobs/handlers";
import { parseWeekId } from "../lib/week";
import { FETCH_DAYS } from "../lib/coverage";

const WEEK = "2026-W40";
const win = parseWeekId(WEEK);
const T0 = win.end.getTime() + 60_000; // a minute into Monday
const domains = ["rag", "agents"].map((id) => Domain.parse({ id, name: id.toUpperCase(), keywords: ["rag", "agent"], arxivCats: ["cs.AI"] }));

const paper = (id: string, title: string): Paper => ({
  id, title, abstract: `${title}. We evaluate on three benchmarks and report 12 percent gains.`, authors: ["A"],
  published: "2026-09-30T00:00:00Z", primaryCategory: "cs.AI", categories: ["cs.AI"], url: `https://arxiv.org/abs/${id}`, source: "arxiv",
});

/** Fake Gemini that returns schema-valid answers and can be told to fail. */
function fakeLlm(opts: { failAll?: boolean } = {}) {
  const calls: string[] = [];
  const fn: JsonLlm = (async (req: any) => {
    const ids = [...req.prompt.matchAll(/<paper id="([^"]+)"/g)].map((m: any) => m[1]);
    const kind = req.system.includes("strict fact-checker") ? "verify" : req.system.includes("write short") ? "write" : req.system.includes("what this week shows") ? "synth" : "score";
    calls.push(kind);
    if (opts.failAll) throw new Error("503 model overloaded");
    const abstractOf = (id: string) => `${id}. We evaluate on three benchmarks and report 12 percent gains.`;
    const out =
      kind === "synth" ? { takeaway: "This week's papers both report gains across three benchmarks.", paperIds: ids.slice(0, 2) }
      : kind === "score" ? { scores: ids.map((id: string) => ({ id, relevance: 5, evidence_quality: 4, introduces_benchmark: false, surprising_result: 4, reframing: 2, hype_risk: 1, has_benchmark: true, claim_scope: "narrow", rationale: "ok" })) }
      : kind === "write" ? { cards: ids.map((id: string) => ({ id, whyItMatters: "Reports 12 percent gains.", summary: "Evaluated on three benchmarks.", verdict: "read", clientAngle: "Relevant if you evaluate.", caveats: "Preprint.", evidenceQuote: "We evaluate on three benchmarks and report 12 percent gains" })) }
      : { results: ids.map((id: string) => ({ id, summary_supported: true, why_supported: true, angle_ok: true, issue: "" })) };
    void abstractOf;
    return req.schema.parse(out);
  }) as JsonLlm;
  return Object.assign(fn, { calls });
}

function mkCtx(over: Partial<Ctx> & { clock?: { t: number } } = {}) {
  const clock = over.clock ?? { t: T0 };
  const published: Brief[] = [];
  const arxivCalls: string[] = [];
  const ctx: Ctx = {
    kv: new MemoryKv(() => clock.t),
    llm: fakeLlm(),
    now: () => clock.t,
    sources: {
      arxivDay: async (d, _w, i) => {
        arxivCalls.push(`${d.id}:${i}`);
        // every day returns 2 papers, titled by domain, so papers are unique per day
        return { papers: [paper(`2609.${d.id === "rag" ? 1 : 2}${i}01`, `${d.name} rag agent study ${i}a`), paper(`2609.${d.id === "rag" ? 1 : 2}${i}02`, `${d.name} rag agent study ${i}b`)] };
      },
      hf: async () => ({ signals: new Map(), papers: [], ok: true }),
    },
    publish: async (b) => void published.push(b),
    emailConfig: () => ({ ready: false, reason: "not configured in this test" }),
    sendEmail: async () => ({ id: "x" }),
    ...over,
  };
  return { ctx, clock, published, arxivCalls };
}

const drain = async (ctx: Ctx, clock: { t: number }, max = 200) => {
  for (let i = 0; i < max; i++) {
    const r = await tick(ctx, { week: WEEK, autoCreate: true, getDomains: async () => domains, budgetMs: 1e9 });
    if (r.finished) return r;
    clock.t += 5 * 60_000; // time passes between ticks, so retry backoff and leases can expire
  }
  throw new Error("did not finish");
};

test("a full week runs through the graph and publishes one brief", async () => {
  const { ctx, clock, published } = mkCtx();
  const r = await drain(ctx, clock);
  assert.equal(r.counts!.failed, 0);
  assert.equal(published.length, 1);
  assert.equal(published[0].week, WEEK);
  assert.equal(published[0].isPartial, false);
  assert.ok(published[0].sections.length === 2);
  assert.ok(published[0].topThree.length > 0);
  assert.ok(published[0].meta.papersSeen! > 0);
});

test("the run is created exactly once even when many ticks race to create it", async () => {
  const { ctx } = mkCtx();
  const results = await Promise.all(Array.from({ length: 6 }, () => tick(ctx, { week: WEEK, autoCreate: true, getDomains: async () => domains, budgetMs: 0 })));
  assert.equal(results.filter((r) => r.created).length, 1);
  const run = await getRun(ctx.kv, WEEK);
  assert.ok(run);
  assert.equal(new Set(run!.jobIds).size, run!.jobIds.length, "no duplicate jobs");
});

test("two workers cannot claim the same job", async () => {
  const { ctx } = mkCtx();
  await createRun(ctx.kv, win, domains, T0);
  const run = (await getRun(ctx.kv, WEEK))!;
  const claims = await Promise.all(Array.from({ length: 8 }, (_, i) => claimNext(ctx.kv, run, `w${i}`, T0)));
  const got = claims.filter(Boolean) as Job[];
  const ids = got.map((j) => j.id);
  assert.equal(new Set(ids).size, ids.length, "every claimed job is distinct");
  assert.ok(got.length > 0);
});

test("a step killed mid-job is recovered after its lease expires, and not before", async () => {
  const clock = { t: T0 };
  const { ctx } = mkCtx({ clock });
  await createRun(ctx.kv, win, domains, T0);
  const run = (await getRun(ctx.kv, WEEK))!;
  const first = (await claimNext(ctx.kv, run, "crashed-worker", clock.t))!; // claimed, then the function was killed
  assert.equal(first.status, "running");
  const during = await claimNext(ctx.kv, run, "other", clock.t + 1000);
  assert.notEqual(during?.id, first.id, "still leased: nobody else may take it");
  clock.t += (LEASE_SEC + 1) * 1000;
  const again = await listJobs(ctx.kv, run).then((js) => js.find((j) => j.id === first.id)!);
  assert.equal(again.status, "running");
  // after expiry the very same job is claimable again, with the attempt counted
  const later = await claimNext(ctx.kv, run, "rescuer", clock.t);
  assert.ok(later);
  const jobs = await listJobs(ctx.kv, run);
  assert.equal(jobs.find((j) => j.id === first.id)!.attempts, 2);
});

test("a failing job backs off, retries, and finally gives up after its attempt limit", async () => {
  const clock = { t: T0 };
  const { ctx } = mkCtx({ clock });
  await createRun(ctx.kv, win, domains, T0);
  const run = (await getRun(ctx.kv, WEEK))!;
  let job = (await claimNext(ctx.kv, run, "w", clock.t))!;
  await markFailed(ctx.kv, job, new Error("boom"), clock.t);
  const j1 = (await listJobs(ctx.kv, run)).find((j) => j.id === job.id)!;
  assert.equal(j1.status, "pending");
  assert.ok(j1.notBefore > clock.t, "backoff applied");
  for (let a = 1; a < maxAttempts(j1.kind); a++) {
    clock.t += 10 * 60_000;
    job = (await claimNext(ctx.kv, run, "w", clock.t))!;
    // claimNext may pick a different pending job; force the one under test
    await ctx.kv.set(keys.job(WEEK, j1.id), { ...(await ctx.kv.get<Job>(keys.job(WEEK, j1.id)))!, status: "running", attempts: a + 1 });
    await markFailed(ctx.kv, { ...(await ctx.kv.get<Job>(keys.job(WEEK, j1.id)))! }, new Error("boom"), clock.t);
  }
  const final = (await listJobs(ctx.kv, run)).find((j) => j.id === j1.id)!;
  assert.equal(final.status, "failed");
  assert.match(final.error!, /boom/);
});

test("arXiv down for a domain: the week still publishes, flagged stale, from Hugging Face alone", async () => {
  const { ctx, clock, published } = mkCtx();
  ctx.sources.arxivDay = async () => {
    throw new Error("arXiv 503");
  };
  ctx.sources.hf = async () => ({ signals: new Map(), papers: [paper("2609.9001", "RAG agent from the daily papers"), paper("2609.9002", "Another rag agent paper")], ok: true });
  const r = await drain(ctx, clock);
  assert.ok(r.counts!.failed >= 14, "every fetch job exhausted its retries");
  assert.equal(published.length, 1);
  assert.equal(published[0].isStale, true);
  assert.ok(published[0].sections.some((s) => s.cards.length || s.featured.length));
});

test("everything down: nothing to publish is an honest failure, never an empty brief", async () => {
  const { ctx, clock, published } = mkCtx();
  ctx.sources.arxivDay = async () => {
    throw new Error("down");
  };
  ctx.sources.hf = async () => ({ signals: new Map(), papers: [], ok: false });
  const r = await drain(ctx, clock);
  assert.equal(published.length, 0);
  const compose = (await listJobs(ctx.kv, (await getRun(ctx.kv, WEEK))!)).find((j) => j.kind === "compose")!;
  assert.equal(compose.status, "failed");
  assert.equal(r.finished, true);
});

test("Gemini fully down: the brief still ships, every domain degraded to abstract excerpts", async () => {
  const { ctx, clock, published } = mkCtx({ llm: fakeLlm({ failAll: true }) });
  await drain(ctx, clock);
  assert.equal(published.length, 1);
  assert.ok(published[0].sections.every((s) => s.status === "degraded"));
  assert.ok(published[0].sections.every((s) => s.cards.length > 0 && s.cards.every((c) => c.summary.length > 0)));
  assert.equal(published[0].topThree.length, 0, "unranked cards are never promoted to top stories");
});

test("a job is not re-run after it finishes, so a double tick cannot publish twice", async () => {
  const { ctx, clock, published } = mkCtx();
  await drain(ctx, clock);
  const again = await tick(ctx, { week: WEEK, autoCreate: true, getDomains: async () => domains, budgetMs: 1e9 });
  assert.equal(again.ran.length, 0);
  assert.equal(published.length, 1);
});

test("settings edited mid-run do not change a run already in flight", async () => {
  const { ctx } = mkCtx();
  await tick(ctx, { week: WEEK, autoCreate: true, getDomains: async () => domains, budgetMs: 0 });
  const run = (await getRun(ctx.kv, WEEK))!;
  assert.deepEqual(run.domains.map((d) => d.id), ["rag", "agents"], "snapshot taken at creation");
  const r2 = await tick(ctx, { week: WEEK, autoCreate: true, getDomains: async () => [Domain.parse({ id: "new", name: "New", keywords: ["x y"] })], budgetMs: 0 });
  assert.equal(r2.created, false);
  assert.deepEqual((await getRun(ctx.kv, WEEK))!.domains.map((d) => d.id), ["rag", "agents"]);
});

test("cutoff: compose runs with what is ready, marks the brief partial, and recomposes once the rest arrives", async () => {
  const clock = { t: T0 };
  const { ctx, published } = mkCtx({ clock });
  // the "agents" domain is slow: its fetches fail until we let them through
  let agentsUp = false;
  const good = ctx.sources.arxivDay;
  ctx.sources.arxivDay = async (d, w, i) => {
    if (d.id === "agents" && !agentsUp) throw new Error("slow upstream");
    return good(d, w, i);
  };
  const opts = { week: WEEK, autoCreate: true, getDomains: async () => domains, budgetMs: 1e9 } as const;
  await tick(ctx, opts);
  const run = (await getRun(ctx.kv, WEEK))!;
  assert.equal(published.length, 0, "before the cutoff, compose waits for the slow domain");

  clock.t = run.cutoffAt + 1000; // the cutoff passes while agents is still unfinished
  // make the agents jobs look unfinished: reset their failed fetches to pending-with-future-backoff
  for (const j of await listJobs(ctx.kv, run)) {
    if (j.domainId === "agents" && j.kind === "fetch") await ctx.kv.set(keys.job(WEEK, j.id), { ...j, status: "pending", attempts: 0, notBefore: clock.t + 3_600_000 });
  }
  await tick(ctx, opts);
  assert.equal(published.length >= 1, true, "published at the cutoff");
  const partial = published.at(-1)!;
  assert.equal(partial.isPartial, true);
  assert.ok(partial.meta.domainsMissing!.includes("AGENTS"));

  agentsUp = true;
  clock.t += 2 * 3_600_000;
  await drain(ctx, clock);
  const final = published.at(-1)!;
  assert.equal(final.isPartial, false, "recomposed with the late domain included");
  assert.equal(final.sections.length, 2);
});

test("the job graph fits the platform: no single job needs more than one Gemini call", async () => {
  const llm = fakeLlm();
  const clock = { t: T0 };
  const { ctx } = mkCtx({ llm, clock });
  await createRun(ctx.kv, win, domains, T0);
  const run = (await getRun(ctx.kv, WEEK))!;
  const { HANDLERS } = await import("../lib/jobs/handlers");
  const maxCalls: Record<string, number> = {};
  const count: Record<string, number> = {};
  for (let guard = 0; guard < 300; guard++) {
    const job = await claimNext(ctx.kv, run, "t", clock.t);
    if (!job) {
      if ((await listJobs(ctx.kv, run)).every((j) => j.status === "done" || j.status === "failed")) break;
      clock.t += 5 * 60_000;
      continue;
    }
    const before = llm.calls.length;
    try {
      await HANDLERS[job.kind](job, run, ctx);
      await markDone(ctx.kv, job, clock.t);
    } catch (e) {
      await markFailed(ctx.kv, job, e, clock.t);
    }
    maxCalls[job.kind] = Math.max(maxCalls[job.kind] ?? 0, llm.calls.length - before);
    count[job.kind] = (count[job.kind] ?? 0) + 1;
  }
  assert.ok(Object.values(maxCalls).every((n) => n <= 1), `max Gemini calls per job: ${JSON.stringify(maxCalls)}`);
  assert.equal(count.fetch, 2 * FETCH_DAYS, "one fetch job per day (week + lookback), per domain");
  assert.equal(count.synth, 2, "one takeaway job per domain");
  assert.ok(count.judge >= 2, "scoring is split into batches");
});
