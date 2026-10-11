import Link from "next/link";
import type { Brief, BriefCard } from "@/lib/schema";

const VERDICT_LABEL = { read: "Read", skim: "Skim", client_flag: "Client flag" } as const;

function fmt(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

function Card({ c, showDomain = false }: { c: BriefCard; showDomain?: boolean }) {
  return (
    <article className="card">
      <div className="card-head">
        <span className={`pill ${c.verdict}`}>{VERDICT_LABEL[c.verdict]}</span>
        <a href={c.url} target="_blank" rel="noreferrer">
          {c.title}
        </a>
      </div>
      {showDomain && c.domain && <p className="domain-tag">{c.domain}</p>}
      {c.signals.length > 0 && (
        <p className="signals">
          {c.signals.map((s) => (
            <span key={s} className="signal">{s}</span>
          ))}
        </p>
      )}
      {c.whyItMatters && <p className="why">{c.whyItMatters}</p>}
      <p>{c.summary}</p>
      {c.evidenceQuote && <blockquote className="quote">“{c.evidenceQuote}”</blockquote>}
      {c.clientAngle && (
        <p className="angle">
          <b>Client angle:</b> {c.clientAngle}
        </p>
      )}
      <p className="meta">
        {c.authors} · {c.confidence}
        {c.caveats ? ` · ${c.caveats}` : ""}
      </p>
    </article>
  );
}

export function BriefView({ brief, weeks = [] }: { brief: Brief; weeks?: string[] }) {
  const m = brief.meta;
  const titleOf = (id: string) => brief.topThree.find((c) => c.arxivId === id)?.title ?? id;
  return (
    <main>
      <header>
        <h1>Research Pulse</h1>
        <p className="nav"><Link href="/settings">Edit monitored domains</Link></p>
        <p className="window">
          Week of {fmt(brief.windowStart)} to {fmt(brief.windowEnd)} (UTC)
          {m.readingMinutes ? ` · about ${m.readingMinutes} min read` : ""}
        </p>
        {m.coverageStart && (
          <p className="window">
            Covers papers arXiv made public since the last brief (submitted {fmt(m.coverageStart)} to {fmt(brief.windowEnd)}).
          </p>
        )}
        {m.papersSeen ? (
          <p className="window">
            Scanned {m.papersSeen.toLocaleString()} papers, scored {m.papersScored?.toLocaleString() ?? 0}, kept the ones below.
          </p>
        ) : null}
        {brief.isSample && (
          <div className="banner sample">Sample data. The first live brief replaces this after the next Monday run.</div>
        )}
        {brief.isStale && (
          <div className="banner stale">arXiv was unavailable for part of this run. Some results rest on Hugging Face alone.</div>
        )}
        {brief.isPartial && (
          <div className="banner partial">
            Partial brief: {m.domainsMissing?.join(", ") || "some domains"} not ready in time.
          </div>
        )}
      </header>

      {brief.topThree.length > 0 && (
        <section>
          <h2>This week at a glance</h2>
          {brief.topThree.map((c) => (
            <Card key={`top-${c.arxivId}`} c={c} showDomain />
          ))}
        </section>
      )}

      {brief.sections.map((s) => (
        <section key={s.domainId}>
          <h2>{s.domainName}</h2>
          {s.takeaway && (
            <p className="takeaway">
              <b>This week:</b> {s.takeaway}
            </p>
          )}
          {s.status === "quiet" && <p className="quiet">{s.note ?? "Nothing significant this week."}</p>}
          {s.status === "degraded" && (
            <p className="quiet">{s.note ?? "Summaries were unavailable for this domain. Showing top papers only."}</p>
          )}
          {s.featured.length > 0 && (
            <p className="featured">Featured above: {s.featured.map(titleOf).join("; ")}</p>
          )}
          {s.cards.map((c) => (
            <Card key={`${s.domainId}-${c.arxivId}`} c={c} />
          ))}
          {s.status === "ok" && s.cards.length === 0 && s.featured.length === 0 && (
            <p className="quiet">Nothing further this week.</p>
          )}
        </section>
      ))}

      {weeks.length > 0 && (
        <footer>
          <h2>Earlier briefs</h2>
          <p className="archive">
            {weeks.map((w) => (
              <Link key={w} href={`/brief/${w}`}>
                {w}
              </Link>
            ))}
          </p>
        </footer>
      )}
    </main>
  );
}
