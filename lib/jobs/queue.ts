import type { Domain } from "../schema";
import type { WeekWindow } from "../week";
import type { Kv } from "./kv";
import { FETCH_DAYS } from "../coverage";

export type JobKind = "hf" | "fetch" | "embed" | "prefilter" | "judge" | "write" | "verify" | "synth" | "compose" | "email";
export type JobStatus = "pending" | "running" | "done" | "failed";

export interface Job {
  id: string; // e.g. fetch:rag:3, prefilter:rag, judge:rag:0, hf, compose
  week: string;
  kind: JobKind;
  domainId?: string;
  arg?: number; // day index for fetch, batch index for judge
  deps: string[]; // wait until these are terminal (done OR failed): later stages cope with missing inputs
  status: JobStatus;
  attempts: number;
  notBefore: number; // retry backoff
  forceAt?: number; // run even if deps are not finished by then (the cutoff)
  error?: string;
  note?: string;
  startedAt?: number;
  finishedAt?: number;
}

export interface Run {
  week: string;
  createdAt: number;
  cutoffAt: number; // after this, compose runs with whatever is ready and the brief is marked partial
  windowStart: string;
  windowEnd: string;
  domains: Domain[]; // snapshot: editing Settings mid-run must not change a run already in flight
  jobIds: string[]; // the fixed skeleton. Judge jobs are added later and listed under jobx:<week>:<domain>
}

export const MAX_ATTEMPTS = 3;
/**
 * Source fetches get more tries: arXiv is often slow or rate limiting (429) on Monday mornings, a fetch is cheap to
 * retry, and twelve cron steps before the cutoff leave room for it.
 */
export const maxAttempts = (kind: JobKind) => (kind === "fetch" || kind === "hf" ? 10 : kind === "embed" ? 4 : MAX_ATTEMPTS);
export const LEASE_SEC = 100; // longer than a step (60s), so a killed step's job is picked up again soon after
export const DATA_TTL = 60 * 60 * 24 * 21;
export const CUTOFF_HOURS = 3; // hours after the week ends (Monday 03:00 UTC, about 08:30 IST)

const ORDER: JobKind[] = ["hf", "fetch", "embed", "prefilter", "judge", "write", "verify", "synth", "compose", "email"];

export const keys = {
  run: (w: string) => `run:${w}`,
  runLock: (w: string) => `runlock:${w}`,
  job: (w: string, id: string) => `job:${w}:${id}`,
  lease: (w: string, id: string) => `lease:${w}:${id}`,
  extra: (w: string, d: string) => `jobx:${w}:${d}`,
  data: (w: string, ...p: string[]) => `data:${w}:${p.join(":")}`,
  metric: (w: string, id: string) => `metric:${w}:${id}`,
};

const mk = (week: string, kind: JobKind, deps: string[], o: Partial<Job> = {}): Job => ({
  id: [kind, o.domainId, o.arg].filter((x) => x !== undefined).join(":"),
  week, kind, deps, status: "pending", attempts: 0, notBefore: 0, ...o,
});

/** The fixed part of the job graph for one week. Judge batches are spawned by prefilter once the shortlist size is known. */
export function buildSkeleton(week: string, domains: Domain[], cutoffAt: number): Job[] {
  const jobs: Job[] = [mk(week, "hf", [])];
  const finals: string[] = [];
  for (const d of domains) {
    const fetches = Array.from({ length: FETCH_DAYS }, (_, i) => mk(week, "fetch", [], { domainId: d.id, arg: i }));
    // each day's papers are embedded in their own small job, so no single job risks the time limit
    const embeds = fetches.map((f) => mk(week, "embed", [f.id], { domainId: d.id, arg: f.arg }));
    const pre = mk(week, "prefilter", [...fetches.map((f) => f.id), ...embeds.map((e) => e.id), "hf"], { domainId: d.id });
    const write = mk(week, "write", [pre.id], { domainId: d.id });
    const verify = mk(week, "verify", [write.id], { domainId: d.id });
    const synth = mk(week, "synth", [verify.id], { domainId: d.id });
    jobs.push(...fetches, ...embeds, pre, write, verify, synth);
    finals.push(synth.id);
  }
  const compose = mk(week, "compose", finals, { forceAt: cutoffAt });
  jobs.push(compose, mk(week, "email", [compose.id]));
  return jobs;
}

/** Creates the week's run exactly once, however many ticks or crons race to do it. Returns null if it already exists. */
export async function createRun(kv: Kv, win: WeekWindow, domains: Domain[], now: number): Promise<Run | null> {
  if (!(await kv.setNx(keys.runLock(win.week), now, DATA_TTL))) return null;
  const cutoffAt = win.end.getTime() + 1000 + CUTOFF_HOURS * 3_600_000;
  const jobs = buildSkeleton(win.week, domains, cutoffAt);
  for (const j of jobs) await kv.set(keys.job(win.week, j.id), j, DATA_TTL);
  const run: Run = {
    week: win.week, createdAt: now, cutoffAt,
    windowStart: win.start.toISOString(), windowEnd: win.end.toISOString(),
    domains, jobIds: jobs.map((j) => j.id),
  };
  await kv.set(keys.run(win.week), run, DATA_TTL); // written last: readers never see a half-built run
  return run;
}

export const getRun = (kv: Kv, week: string) => kv.get<Run>(keys.run(week));

export async function listJobs(kv: Kv, run: Run): Promise<Job[]> {
  const extra = await kv.mget<string[]>(run.domains.map((d) => keys.extra(run.week, d.id)));
  const ids = [...run.jobIds, ...extra.flatMap((x) => x ?? [])];
  const jobs = await kv.mget<Job>(ids.map((id) => keys.job(run.week, id)));
  return jobs.filter((j): j is Job => j !== null);
}

export const isTerminal = (j: Job) => j.status === "done" || j.status === "failed";

/** Pure: can this job be started at `now`, given the other jobs' states? (Lease liveness is checked at claim time.) */
export function isRunnable(j: Job, byId: Map<string, Job>, now: number): boolean {
  if (j.status === "done" || j.status === "failed") return false;
  if (j.notBefore > now) return false;
  const depsDone = j.deps.every((d) => {
    const dep = byId.get(d);
    return dep ? isTerminal(dep) : true; // a dep that does not exist (never spawned) cannot block
  });
  return depsDone || (j.forceAt !== undefined && now >= j.forceAt);
}

/** Dependencies first, then domain order, so one domain finishes before the next starts to hog the quota. */
export function priority(j: Job, domainOrder: Map<string, number>): number {
  return ORDER.indexOf(j.kind) * 1000 + (j.domainId ? (domainOrder.get(j.domainId) ?? 0) * 10 : 0) + (j.arg ?? 0);
}

/**
 * Atomically takes the next runnable job. The lease (SET NX with expiry) is the lock: two ticks racing
 * for the same job cannot both win. A job left "running" by a crashed or timed-out step becomes
 * claimable again when its lease expires.
 */
export async function claimNext(kv: Kv, run: Run, owner: string, now: number): Promise<Job | null> {
  const jobs = await listJobs(kv, run);
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const order = new Map(run.domains.map((d, i) => [d.id, i]));
  const candidates = jobs.filter((j) => isRunnable(j, byId, now)).sort((a, b) => priority(a, order) - priority(b, order));

  for (const c of candidates) {
    if (!(await kv.setNx(keys.lease(run.week, c.id), owner, LEASE_SEC))) continue;
    const fresh = await kv.get<Job>(keys.job(run.week, c.id)); // re-read under the lease
    if (!fresh || isTerminal(fresh)) {
      await kv.del(keys.lease(run.week, c.id));
      continue;
    }
    if (fresh.attempts >= maxAttempts(fresh.kind)) {
      await kv.set(keys.job(run.week, c.id), { ...fresh, status: "failed", error: fresh.error ?? "Gave up after repeated attempts or timeouts", finishedAt: now }, DATA_TTL);
      await kv.del(keys.lease(run.week, c.id));
      continue;
    }
    const claimed: Job = { ...fresh, status: "running", attempts: fresh.attempts + 1, startedAt: now };
    await kv.set(keys.job(run.week, c.id), claimed, DATA_TTL);
    return claimed;
  }
  return null;
}

export async function markDone(kv: Kv, job: Job, now: number, note?: string) {
  await kv.set(keys.job(job.week, job.id), { ...job, status: "done", finishedAt: now, note, error: undefined }, DATA_TTL);
  await kv.del(keys.lease(job.week, job.id));
}

/** Retry with backoff until MAX_ATTEMPTS, then give up. Downstream stages treat a failed job as missing input. */
export async function markFailed(kv: Kv, job: Job, err: unknown, now: number) {
  const msg = (err instanceof Error ? err.message : String(err)).slice(0, 300);
  const final = job.attempts >= maxAttempts(job.kind);
  const next: Job = final
    ? { ...job, status: "failed", error: msg, finishedAt: now }
    : // capped, so even ten attempts (about 50 minutes) give up well before the cutoff
      { ...job, status: "pending", error: msg, notBefore: now + Math.min(20_000 * 2 ** (job.attempts - 1), 10 * 60_000) };
  await kv.set(keys.job(job.week, job.id), next, DATA_TTL);
  await kv.del(keys.lease(job.week, job.id));
}

export function summarise(jobs: Job[]) {
  const c = { pending: 0, running: 0, done: 0, failed: 0 };
  for (const j of jobs) c[j.status]++;
  return { ...c, total: jobs.length, finished: c.pending === 0 && c.running === 0 };
}
