import type { Domain } from "../schema";
import { lastCompletedWeek, parseWeekId, type WeekWindow } from "../week";
import { takeLlmStats } from "../ai/gemini";
import { HANDLERS, type Ctx } from "./handlers";
import {
  claimNext, createRun, getRun, keys, listJobs, markDone, markFailed, summarise, DATA_TTL, type Job, type Run,
} from "./queue";

export interface TickResult {
  week: string;
  created: boolean;
  ran: { id: string; ok: boolean; ms: number; note?: string; error?: string }[];
  counts: ReturnType<typeof summarise> | null;
  /** True once nothing is left to run; the caller (GitHub Actions) stops ticking. */
  finished: boolean;
  status: "no-run" | "running" | "finished";
}

export interface TickOptions {
  week?: string; // default: the last completed week
  autoCreate?: boolean; // create the run if it does not exist (the cron and the ticker both do, so one missing cron cannot lose a week)
  getDomains?: () => Promise<Domain[]>;
  /**
   * How long we may keep starting new jobs. A step must finish inside the platform limit (60s declared on
   * the route), so we stop starting jobs well before that: the slowest job is one Gemini call (~25s).
   */
  budgetMs?: number;
  /** A single job that runs longer than this is abandoned and retried, instead of holding its lease until it expires. */
  jobTimeoutMs?: number;
}

/** Runs the late-arriving case: the brief was published at the cutoff with gaps, and the gaps have since filled in. */
async function maybeRecompose(ctx: Ctx, run: Run, jobs: Job[]): Promise<boolean> {
  const compose = jobs.find((j) => j.kind === "compose");
  if (!compose || compose.status !== "done" || !compose.note?.startsWith("partial")) return false;
  if (!jobs.filter((j) => j.kind !== "compose" && j.kind !== "email").every((j) => j.status === "done" || j.status === "failed")) return false;
  if (!(await ctx.kv.setNx(`recomposed:${run.week}`, 1, DATA_TTL))) return false; // at most once, so it can never loop
  await ctx.kv.set(keys.job(run.week, compose.id), { ...compose, status: "pending", attempts: 0, note: "recompose after late sections", forceAt: undefined, notBefore: 0 }, DATA_TTL);
  const email = jobs.find((j) => j.kind === "email");
  if (email) await ctx.kv.set(keys.job(run.week, email.id), { ...email, status: "pending", attempts: 0, note: "resend after recompose", notBefore: 0 }, DATA_TTL);
  return true;
}

/** Rejects if the work does not finish in time. The abandoned work cannot be cancelled, but its result is ignored. */
function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** One serverless invocation's worth of work: claim and run jobs until the time budget is spent. */
export async function tick(ctx: Ctx, opts: TickOptions = {}): Promise<TickResult> {
  const win: WeekWindow = opts.week ? parseWeekId(opts.week) : lastCompletedWeek(new Date(ctx.now()));
  let created = false;
  let run = await getRun(ctx.kv, win.week);

  if (!run && opts.autoCreate) {
    const domains = (await (opts.getDomains?.() ?? Promise.resolve([]))).filter((d) => d.active);
    if (!domains.length) throw new Error("No active domains to run");
    created = (await createRun(ctx.kv, win, domains, ctx.now())) !== null;
    run = await getRun(ctx.kv, win.week); // another caller may have created it first; either way we now have it
  }
  if (!run) return { week: win.week, created, ran: [], counts: null, finished: false, status: "no-run" };

  // Housekeeping on roughly one tick in ten: drop rows that expired long ago so storage stays small.
  if (Math.random() < 0.1) await (ctx.kv as { sweep?: () => Promise<number> }).sweep?.().catch(() => 0);

  const budget = opts.budgetMs ?? 25_000;
  const started = ctx.now();
  const owner = Math.random().toString(36).slice(2, 10);
  const ran: TickResult["ran"] = [];

  while (ctx.now() - started < budget) {
    const job = await claimNext(ctx.kv, run, owner, ctx.now());
    if (!job) break;
    const t0 = ctx.now();
    takeLlmStats(); // start a fresh count so this job's cost is its own
    try {
      const note = await withTimeout(HANDLERS[job.kind](job, run, ctx), opts.jobTimeoutMs ?? 52_000, job.id);
      const s = takeLlmStats();
      const cost = s.calls ? ` [${s.calls} AI call(s), ${s.promptTokens + s.outputTokens} tokens${s.retries ? `, ${s.retries} retried` : ""}${s.parseFailures ? `, ${s.parseFailures} malformed` : ""}]` : "";
      await markDone(ctx.kv, job, ctx.now(), (note ?? "done") + cost);
      if (s.calls) await ctx.kv.set(keys.metric(run.week, job.id), { calls: s.calls, tokens: s.promptTokens + s.outputTokens, retries: s.retries, malformed: s.parseFailures, ms: ctx.now() - t0 }, DATA_TTL).catch(() => {});
      ran.push({ id: job.id, ok: true, ms: ctx.now() - t0, note: (note ?? undefined) });
    } catch (e) {
      takeLlmStats();
      await markFailed(ctx.kv, job, e, ctx.now());
      ran.push({ id: job.id, ok: false, ms: ctx.now() - t0, error: (e instanceof Error ? e.message : String(e)).slice(0, 160) });
    }
  }

  let jobs = await listJobs(ctx.kv, run);
  if (await maybeRecompose(ctx, run, jobs)) jobs = await listJobs(ctx.kv, run);
  const counts = summarise(jobs);
  return { week: win.week, created, ran, counts, finished: counts.finished, status: counts.finished ? "finished" : "running" };
}
