import { defaultKv } from "@/lib/jobs/kv";
import { runStatus } from "@/lib/jobs/status";
import { PageHero } from "@/components/PageHero";

export const dynamic = "force-dynamic";
export const metadata = { title: "Status · Pulse-AI" };

export default async function StatusPage() {
  let s: Awaited<ReturnType<typeof runStatus>> | null = null;
  let err = "";
  try {
    s = await runStatus(defaultKv());
  } catch (e) {
    err = e instanceof Error ? e.message : "unavailable";
  }
  return (
    <>
      <PageHero title="Run status" sub="Progress of this week's automatic run: fetching, scoring, writing, checking and publishing." />
      <main className="wrap page">
        {err && <div className="banner stale">Status is unavailable: {err}</div>}
        {s && !s.exists && <p className="quiet">No run has started yet for {s.week}. It begins Monday 00:00 UTC.</p>}
        {s && s.exists && (
          <>
            <p className="meta-row">
              Week {s.week} · {s.published ? "brief published" : "in progress"}
              {s.composeNote ? ` · ${s.composeNote}` : ""}
            </p>
            <div className="stat-grid">
              <div className="stat">
                <b>
                  {s.counts.done}/{s.counts.total}
                </b>
                <span>jobs done</span>
              </div>
              <div className="stat">
                <b>{s.counts.failed}</b>
                <span>failed</span>
              </div>
              <div className="stat">
                <b>{s.ai.calls}</b>
                <span>AI calls</span>
              </div>
              <div className="stat">
                <b>{s.ai.tokens.toLocaleString()}</b>
                <span>tokens</span>
              </div>
              {s.wallClockMin !== null && (
                <div className="stat">
                  <b>{s.wallClockMin} min</b>
                  <span>wall clock</span>
                </div>
              )}
            </div>
            <article className="card">
              <p className="meta-row">
                {s.counts.pending} waiting · {s.counts.running} running · {s.ai.retries} AI retries · {s.ai.malformed} malformed answers
              </p>
              <p className="meta-row">
                Domains: {s.domains.join(", ")} · cutoff {s.cutoffAt}
              </p>
            </article>
            {s.problems.length > 0 && (
              <>
                <h2 style={{ fontSize: "1.2rem", margin: "24px 0 8px" }}>Problems</h2>
                {s.problems.map((p) => (
                  <p key={p.id} className="problem">
                    <b>{p.id}</b> ({p.status}, attempt {p.attempts}): {p.error}
                  </p>
                ))}
              </>
            )}
          </>
        )}
      </main>
    </>
  );
}
