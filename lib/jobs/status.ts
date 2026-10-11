import { getRun, keys, listJobs, summarise, type Job } from "./queue";
import type { Kv } from "./kv";
import { lastCompletedWeek } from "../week";

/** Keeps error text useful but never leaks a credential if a provider echoes one back. */
export const redact = (s: string) =>
  s.replace(/AQ\.[A-Za-z0-9_-]{10,}/g, "[key]").replace(/(key|token|secret)=[^\s&"]+/gi, "$1=[redacted]").slice(0, 160);

export async function runStatus(kv: Kv, week: string = lastCompletedWeek().week) {
  const run = await getRun(kv, week);
  if (!run) return { week, exists: false as const };
  const jobs = await listJobs(kv, run);
  const compose = jobs.find((j) => j.kind === "compose");
  const metrics = (await kv.mget<{ calls: number; tokens: number; retries: number; malformed: number; ms: number }>(jobs.map((j) => keys.metric(week, j.id)))).filter((m) => m !== null);
  const ai = metrics.reduce((a, m) => ({ calls: a.calls + m!.calls, tokens: a.tokens + m!.tokens, retries: a.retries + m!.retries, malformed: a.malformed + m!.malformed, ms: a.ms + m!.ms }), { calls: 0, tokens: 0, retries: 0, malformed: 0, ms: 0 });
  const finished = jobs.filter((j) => j.finishedAt).map((j) => j.finishedAt!);
  const wallClockMin = finished.length ? Math.round((Math.max(...finished) - run.createdAt) / 60000) : null;
  const problems = jobs
    .filter((j: Job) => j.error)
    .map((j) => ({ id: j.id, status: j.status, attempts: j.attempts, error: redact(j.error!) }));
  return {
    week,
    exists: true as const,
    createdAt: new Date(run.createdAt).toISOString(),
    cutoffAt: new Date(run.cutoffAt).toISOString(),
    domains: run.domains.map((d) => d.name),
    counts: summarise(jobs),
    published: compose?.status === "done",
    composeNote: compose?.note ?? null,
    ai: { ...ai, avgMsPerCall: ai.calls ? Math.round(ai.ms / ai.calls) : 0 },
    wallClockMin,
    problems,
  };
}
