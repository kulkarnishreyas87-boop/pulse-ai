import Link from "next/link";
import { defaultKv } from "@/lib/jobs/kv";
import { runStatus } from "@/lib/jobs/status";

export const dynamic = "force-dynamic";
export const metadata = { title: "Status · Research Pulse" };

export default async function StatusPage() {
  let s: Awaited<ReturnType<typeof runStatus>> | null = null;
  let err = "";
  try {
    s = await runStatus(defaultKv());
  } catch (e) {
    err = e instanceof Error ? e.message : "unavailable";
  }
  return (
    <main>
      <header>
        <p className="window"><Link href="/" className="back">← Back to the brief</Link></p>
        <h1>Run status</h1>
      </header>
      {err && <div className="banner stale">Status is unavailable: {err}</div>}
      {s && !s.exists && <p className="quiet">No run has started yet for {s.week}. It begins Monday 00:00 UTC.</p>}
      {s && s.exists && (
        <>
          <p className="window">Week {s.week} · {s.published ? "brief published" : "in progress"}{s.composeNote ? ` · ${s.composeNote}` : ""}</p>
          <article className="card">
            <p>
              {s.counts.done} of {s.counts.total} jobs done · {s.counts.pending} waiting · {s.counts.running} running ·{" "}
              {s.counts.failed} failed
            </p>
            <p className="meta">AI: {s.ai.calls} calls · {s.ai.tokens.toLocaleString()} tokens · {s.ai.retries} retried · {s.ai.malformed} malformed answers{s.wallClockMin !== null ? ` · ${s.wallClockMin} min wall clock` : ""}</p>
            <p className="meta">Domains: {s.domains.join(", ")} · cutoff {s.cutoffAt}</p>
          </article>
          {s.problems.length > 0 && (
            <>
              <h2>Problems</h2>
              {s.problems.map((p) => (
                <p key={p.id} className="meta"><b>{p.id}</b> ({p.status}, attempt {p.attempts}): {p.error}</p>
              ))}
            </>
          )}
        </>
      )}
    </main>
  );
}
