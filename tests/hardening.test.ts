import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { createJsonLlm, takeLlmStats, type RawCall } from "../lib/ai/gemini";
import { arxivTuning, fetchArxivDay } from "../lib/sources/arxiv";
import { Domain, type Paper } from "../lib/schema";
import { MemoryKv, type Kv } from "../lib/jobs/kv";
import { createRun, getRun, listJobs, keys } from "../lib/jobs/queue";
import { tick } from "../lib/jobs/runner";
import type { Ctx } from "../lib/jobs/handlers";
import { redact, runStatus } from "../lib/jobs/status";
import { parseWeekId } from "../lib/week";

const Shape = z.object({ n: z.number() });
// A made-up credential shaped like a Google key, assembled at runtime so no key-like literal is in the repo.
const FAKE_KEY = ["AQ", "FAKEFAKEFAKEFAKEFAKEFAKEFAKE0000"].join(".");
const ok = (text: string, p = 10, o = 5): RawCall => ({ text, promptTokens: p, outputTokens: o });

/* ============ #6/#7: malformed JSON, rate limits and outages from Gemini ============ */

function scripted(...steps: (RawCall | Error)[]) {
  const prompts: string[] = [];
  const waits: number[] = [];
  const llm = createJsonLlm(
    async (_s, prompt) => {
      prompts.push(prompt);
      const step = steps[Math.min(prompts.length - 1, steps.length - 1)];
      if (step instanceof Error) throw step;
      return step;
    },
    async (ms) => void waits.push(ms),
  );
  return { llm, prompts, waits };
}

test("Gemini: a valid answer costs one call and is counted", async () => {
  takeLlmStats();
  const { llm } = scripted(ok('{"n":1}', 100, 20));
  assert.deepEqual(await llm({ system: "s", prompt: "p", schema: Shape }), { n: 1 });
  assert.deepEqual(takeLlmStats(), { calls: 1, retries: 0, parseFailures: 0, promptTokens: 100, outputTokens: 20 });
});

test("Gemini: malformed JSON is retried and then succeeds", async () => {
  takeLlmStats();
  const { llm, waits } = scripted(ok("{not json"), ok('{"n":2}'));
  assert.deepEqual(await llm({ system: "s", prompt: "p", schema: Shape }), { n: 2 });
  const s = takeLlmStats();
  assert.equal(s.calls, 2);
  assert.equal(s.parseFailures, 1);
  assert.equal(s.retries, 1);
  assert.deepEqual(waits, [1500], "backs off before the retry");
});

test("Gemini: a schema-invalid answer gets one repair attempt with the validation error fed back", async () => {
  takeLlmStats();
  const { llm, prompts } = scripted(ok('{"n":"not a number"}'), ok('{"n":3}'));
  assert.deepEqual(await llm({ system: "s", prompt: "ORIGINAL", schema: Shape }), { n: 3 });
  assert.ok(prompts[1].startsWith("ORIGINAL"), "repair prompt keeps the original task");
  assert.match(prompts[1], /failed validation/);
  assert.match(prompts[1], /number/i, "and names what was wrong");
  assert.equal(takeLlmStats().parseFailures, 1);
});

test("Gemini: after three bad answers it gives up with a clear error, so the domain can degrade", async () => {
  takeLlmStats();
  const { llm } = scripted(ok("garbage"));
  await assert.rejects(llm({ system: "s", prompt: "p", schema: Shape }), /failed after retries/);
  assert.equal(takeLlmStats().calls, 3, "bounded: never loops forever");
});

test("Gemini: rate limits and 5xx back off exponentially, then recover", async () => {
  takeLlmStats();
  const { llm, waits } = scripted(new Error("429 RESOURCE_EXHAUSTED"), new Error("503 UNAVAILABLE"), ok('{"n":4}'));
  assert.deepEqual(await llm({ system: "s", prompt: "p", schema: Shape }), { n: 4 });
  assert.deepEqual(waits, [1500, 3000]);
  assert.equal(takeLlmStats().retries, 2);
});

test("Gemini: a missing API key fails immediately instead of retrying", async () => {
  takeLlmStats();
  const { llm, waits } = scripted(new Error("GEMINI_API_KEY is not set"));
  await assert.rejects(llm({ system: "s", prompt: "p", schema: Shape }), /GEMINI_API_KEY/);
  assert.equal(takeLlmStats().calls, 1);
  assert.deepEqual(waits, []);
});

/* ============ #8: arXiv rate limits, outages and garbage ============ */

const XML = readFileSync(join(import.meta.dirname, "fixtures", "arxiv-sample.xml"), "utf8");
const dom = Domain.parse({ id: "rag", name: "RAG", keywords: ["retrieval augmented"], arxivCats: ["cs.CL"] });
const win = parseWeekId("2026-W40");

async function withFetch<T>(responses: (Response | Error)[], run: () => Promise<T>): Promise<{ result: T | Error; calls: number }> {
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    const r = responses[Math.min(calls++, responses.length - 1)];
    if (r instanceof Error) throw r;
    return r.clone();
  }) as typeof fetch;
  const saved = { ...arxivTuning };
  arxivTuning.minGapMs = 0;
  arxivTuning.backoffMs = 1;
  try {
    return { result: await run(), calls };
  } catch (e) {
    return { result: e as Error, calls };
  } finally {
    globalThis.fetch = real;
    Object.assign(arxivTuning, saved);
  }
}
const xmlRes = () => new Response(XML, { status: 200 });

test("arXiv: 429 then 503 then success returns the papers after retrying", async () => {
  const { result, calls } = await withFetch([new Response("slow down", { status: 429 }), new Response("", { status: 503 }), xmlRes()], () => fetchArxivDay(dom, win, 0));
  assert.equal(calls, 3);
  assert.equal((result as any).papers.length, 3);
});

test("arXiv: a 429 waits for Retry-After before trying again (quick retries only extend the block)", async () => {
  const t0 = Date.now();
  const { result, calls } = await withFetch([new Response("slow down", { status: 429, headers: { "Retry-After": "1" } }), xmlRes()], () => fetchArxivDay(dom, win, 0));
  assert.equal(calls, 2);
  assert.equal((result as any).papers.length, 3);
  assert.ok(Date.now() - t0 >= 900, "retried before Retry-After elapsed");
});

test("arXiv: network errors and timeouts are retried", async () => {
  const { result, calls } = await withFetch([new TypeError("fetch failed"), Object.assign(new Error("timed out"), { name: "TimeoutError" }), xmlRes()], () => fetchArxivDay(dom, win, 0));
  assert.equal(calls, 3);
  assert.equal((result as any).papers.length, 3);
});

test("arXiv: persistent outage gives up after a bounded number of tries with a clear error", async () => {
  const { result, calls } = await withFetch([new Response("down", { status: 503 })], () => fetchArxivDay(dom, win, 0));
  assert.equal(calls, 4, "bounded");
  assert.match((result as Error).message, /arXiv request failed/);
});

test("arXiv: a client error (bad query) is not retried", async () => {
  const { result, calls } = await withFetch([new Response("bad request", { status: 400 })], () => fetchArxivDay(dom, win, 0));
  assert.equal(calls, 1, "retrying a 400 would only hammer the API");
  assert.match((result as Error).message, /400/);
});

test("arXiv: an HTML error page served with status 200 is rejected, never treated as 'no papers'", async () => {
  const { result } = await withFetch([new Response("<html><body>Rate exceeded</body></html>", { status: 200 })], () => fetchArxivDay(dom, win, 0));
  assert.ok(result instanceof Error, "must fail so the job retries, not silently record an empty day");
});

/* ============ #9: a hung dependency must not wedge the pipeline ============ */

const WEEK = "2026-W40";
const week = parseWeekId(WEEK);
const doms = [Domain.parse({ id: "rag", name: "RAG", keywords: ["rag", "agent"], arxivCats: ["cs.AI"] })];
const paper = (id: string): Paper => ({ id, title: `rag agent ${id}`, abstract: `rag agent ${id}. We report 12 percent.`, authors: ["A"], published: "2026-09-30T00:00:00Z", primaryCategory: "cs.AI", categories: ["cs.AI"], url: `https://arxiv.org/abs/${id}`, source: "arxiv" });
function ctxFor(kv: Kv, clock: { t: number }, over: Partial<Ctx> = {}): Ctx {
  return {
    kv, now: () => clock.t, llm: (async () => { throw new Error("unused"); }) as any,
    sources: { arxivDay: async (_d, _w, i) => ({ papers: [paper(`2609.${i}001`), paper(`2609.${i}002`)] }), hf: async () => ({ signals: new Map(), papers: [], ok: true }) },
    publish: async () => {}, emailConfig: () => ({ ready: false, reason: "test" }), sendEmail: async () => ({ id: "x" }),
    ...over,
  };
}
const T0 = week.end.getTime() + 60_000;

test("a hung Gemini call times out the job and queues a retry instead of wedging the run", async () => {
  const clock = { t: T0 };
  const ctx = ctxFor(new MemoryKv(() => clock.t), clock, { llm: (() => new Promise(() => {})) as any }); // never resolves
  const r = await tick(ctx, { week: WEEK, autoCreate: true, getDomains: async () => doms, budgetMs: 1e9, jobTimeoutMs: 40 });
  const judge = r.ran.find((x) => x.id.startsWith("judge"));
  assert.ok(judge && !judge.ok, "the hung judge job was abandoned");
  assert.match(judge!.error!, /timed out/);
  const jobs = await listJobs(ctx.kv, (await getRun(ctx.kv, WEEK))!);
  const j = jobs.find((x) => x.id === judge!.id)!;
  assert.equal(j.status, "pending", "queued for retry with backoff");
  assert.ok(j.notBefore > clock.t);
  assert.equal(r.finished, false);
});

/* ============ storage hiccups ============ */

/** Wraps a Kv so the first `failures` writes matching `when` throw, simulating a connection dropping. */
function flakyKv(inner: MemoryKv, when: (k: string, v: any) => boolean, failures: number) {
  let left = failures;
  const kv: Kv = {
    get: (k) => inner.get(k), mget: (k) => inner.mget(k), setNx: (k, v, t) => inner.setNx(k, v, t), del: (k) => inner.del(k), incr: (k, t) => inner.incr(k, t),
    set: async (k, v, ttl) => {
      if (left > 0 && when(k, v)) {
        left--;
        throw new Error("connection reset by peer");
      }
      return inner.set(k, v, ttl);
    },
  };
  return { kv, remaining: () => left };
}
const isHfDone = (k: string, v: any) => k === keys.job(WEEK, "hf") && v.status === "done";

async function drainTolerant(ctx: Ctx, clock: { t: number }) {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await tick(ctx, { week: WEEK, autoCreate: true, getDomains: async () => doms, budgetMs: 1e9 })).finished) return true;
    } catch {
      /* a failed tick is exactly what the scheduler's next call recovers from */
    }
    clock.t += 5 * 60_000;
  }
  return false;
}

test("a one-off storage error when recording completion does not crash the tick: the job is simply retried", async () => {
  const clock = { t: T0 };
  const inner = new MemoryKv(() => clock.t);
  const { kv, remaining } = flakyKv(inner, isHfDone, 1);
  const ctx = ctxFor(kv, clock);
  const first = await tick(ctx, { week: WEEK, autoCreate: true, getDomains: async () => doms, budgetMs: 1e9 });
  assert.equal(remaining(), 0, "the fault was injected");
  const hf = first.ran.find((r) => r.id === "hf")!;
  assert.equal(hf.ok, false, "reported as failed, not lost");
  assert.ok(await drainTolerant(ctx, clock));
  const job = (await listJobs(inner, (await getRun(inner, WEEK))!)).find((j) => j.id === "hf")!;
  assert.equal(job.status, "done");
  assert.equal(job.attempts, 2);
});

test("a storage OUTAGE (the failure write fails too) rejects the tick, and the job is recovered when its lease expires", async () => {
  const clock = { t: T0 };
  const inner = new MemoryKv(() => clock.t);
  // Once hf is running, fail BOTH the 'done' write and the 'pending (retry)' write: nothing can be recorded.
  // (Armed only after the job starts, so run creation, which also writes 'pending', is not hit.)
  let running = false;
  const { kv, remaining } = flakyKv(
    inner,
    (k, v) => {
      if (k !== keys.job(WEEK, "hf")) return false;
      if (v.status === "running") running = true;
      return running && (v.status === "done" || v.status === "pending");
    },
    2,
  );
  const ctx = ctxFor(kv, clock);
  await assert.rejects(tick(ctx, { week: WEEK, autoCreate: true, getDomains: async () => doms, budgetMs: 1e9 }), /connection reset/);
  assert.equal(remaining(), 0);
  const stuck = (await listJobs(inner, (await getRun(inner, WEEK))!)).find((j) => j.id === "hf")!;
  assert.equal(stuck.status, "running", "left mid-flight, protected by its lease");
  assert.ok(await drainTolerant(ctx, clock), "the run still completes on later ticks");
  const done = (await listJobs(inner, (await getRun(inner, WEEK))!)).find((j) => j.id === "hf")!;
  assert.equal(done.status, "done");
  assert.equal(done.attempts, 2, "re-claimed after the lease expired");
});

/* ============ #17: secrets and information leaks ============ */

test("error text from providers never leaks a credential into the public status", async () => {
  assert.equal(redact(`403 for key=${FAKE_KEY} bad`), "403 for key=[redacted] bad");
  assert.ok(!redact(`failed with ${FAKE_KEY}`).includes("AQ."));
  assert.ok(!redact("https://x/y?token=abc123&z=1").includes("abc123"));
  assert.ok(redact("x".repeat(500)).length <= 160);

  const kv = new MemoryKv();
  await createRun(kv, week, doms, T0);
  const run = (await getRun(kv, WEEK))!;
  const hfJob = (await listJobs(kv, run)).find((j) => j.id === "hf")!;
  await kv.set(keys.job(WEEK, "hf"), { ...hfJob, status: "failed", attempts: 3, error: `request failed: secret=hunter2 key=${FAKE_KEY}` });
  const status: any = await runStatus(kv, WEEK);
  const text = JSON.stringify(status);
  assert.ok(!text.includes("hunter2") && !text.includes(FAKE_KEY), "no secret in the public status");
  assert.equal(status.problems.length, 1);
});

/** Walk the project's own files (not dependencies, build output, caches or local secrets). */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (["node_modules", ".next", ".cache", ".git", "package-lock.json", "tsconfig.tsbuildinfo", ".env.local", ".env"].includes(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.(ts|tsx|mjs|js|json|md|yml|yaml|html|css|example)$/.test(name) || name.startsWith(".env")) out.push(p);
  }
  return out;
}

test("no credential is hardcoded anywhere in the repository", () => {
  const patterns: [string, RegExp][] = [
    ["Google/Gemini key", /\bAQ\.[A-Za-z0-9_-]{25,}/],
    ["Google API key", /\bAIza[0-9A-Za-z_-]{30,}/],
    ["Resend key", /\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9_]{10,}/],
    ["Postgres URL with a password", /postgres(?:ql)?:\/\/[^\s:'"@/]+:[^\s'"@/]{3,}@/],
    ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    ["generic secret assignment", /(?:api[_-]?key|secret|token|password)\s*[:=]\s*["'][A-Za-z0-9_\-]{24,}["']/i],
  ];
  const root = process.cwd();
  const hits: string[] = [];
  for (const f of sourceFiles(root)) {
    const text = readFileSync(f, "utf8");
    for (const [name, re] of patterns) if (re.test(text)) hits.push(`${f.replace(root, "")}: ${name}`);
  }
  assert.deepEqual(hits, [], "a credential-looking string was found in tracked files");
});

test("secrets and caches are gitignored, and .env.example holds no values for secrets", () => {
  // A Vercel CLI upload has no .gitignore (Vercel drops it), so that half only applies in a git checkout.
  const ignore = existsSync(join(process.cwd(), ".gitignore")) ? readFileSync(join(process.cwd(), ".gitignore"), "utf8") : null;
  if (ignore !== null) for (const must of [".env.local", ".env", "node_modules", ".cache", ".next", ".vercel"]) assert.ok(ignore.split(/\r?\n/).includes(must), `${must} must be ignored`);
  const example = readFileSync(join(process.cwd(), ".env.example"), "utf8");
  for (const line of example.split(/\r?\n/)) {
    const m = /^(GEMINI_API_KEY|DATABASE_URL|RESEND_API_KEY|CRON_SECRET|EMAIL_TO)=(.*)$/.exec(line);
    if (m) assert.equal(m[2], "", `${m[1]} must be blank in .env.example`);
  }
});

test("every response gets baseline security headers, and API responses are never cached", async () => {
  // @ts-ignore: plain JS config file without type declarations
  const cfg = (await import("../next.config.mjs")).default as any;
  const rules = await cfg.headers();
  const all = Object.fromEntries(rules.find((r: any) => r.source === "/:path*").headers.map((h: any) => [h.key, h.value]));
  assert.equal(all["X-Content-Type-Options"], "nosniff");
  assert.equal(all["X-Frame-Options"], "DENY");
  assert.ok(all["Strict-Transport-Security"]);
  assert.ok(all["Referrer-Policy"]);
  assert.match(all["Permissions-Policy"], /camera=\(\)/);
  const api = rules.find((r: any) => r.source === "/api/:path*").headers[0];
  assert.deepEqual(api, { key: "Cache-Control", value: "no-store" });
  assert.equal(cfg.poweredByHeader, false);
});
