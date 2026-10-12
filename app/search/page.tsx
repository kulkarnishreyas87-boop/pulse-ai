import Link from "next/link";
import type { Metadata } from "next";
import { PageHero } from "@/components/PageHero";
import { IconArrow, IconSearch } from "@/components/Icons";
import { VERDICT } from "@/components/Paper";
import { getBrief, getLatestBrief, listWeeks } from "@/lib/store";
import { MAX_QUERY, searchBriefs } from "@/lib/search";
import { domainTheme, hueStyle } from "@/lib/theme";
import type { Brief } from "@/lib/schema";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Search · Pulse-AI" };

const WEEKS_SEARCHED = 26; // about six months of briefs

async function allBriefs(): Promise<Brief[]> {
  const weeks = (await listWeeks()).slice(0, WEEKS_SEARCHED);
  const briefs = (await Promise.all(weeks.map(getBrief))).filter((b): b is Brief => Boolean(b));
  return briefs.length ? briefs : [await getLatestBrief()];
}

/** Wraps each query word found in the text in <mark>. */
function Highlight({ text, terms }: { text: string; terms: string[] }) {
  if (!terms.length) return <>{text}</>;
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return <>{text.split(re).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part))}</>;
}

const SUGGESTIONS = ["benchmark", "agents", "retrieval", "code generation", "defect detection", "surprising result"];

export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const q = String((await searchParams).q ?? "").slice(0, MAX_QUERY).trim();
  const briefs = await allBriefs();
  const latestWeek = briefs[0]?.week;
  const { terms, hits, domains } = searchBriefs(briefs, q);
  const domainHref = (week: string, id: string) => (week === latestWeek ? `/domain/${id}` : `/brief/${week}/${id}`);

  return (
    <>
      <PageHero title="Search the briefs" sub={`Find a topic, paper, author or domain across ${briefs.length === 1 ? "this week's brief" : `the last ${briefs.length} weekly briefs`}.`} />
      <main className="wrap page search-page">
        <form className="search-form" role="search" action="/search" method="get">
          <label htmlFor="q" className="sr-only">
            Search topic, paper or domain
          </label>
          <span className="search-field">
            <IconSearch className="search-icon" />
            <input id="q" name="q" type="search" defaultValue={q} maxLength={MAX_QUERY} placeholder="e.g. benchmark, RAG, defect detection" autoComplete="off" autoFocus={!q} />
          </span>
          <button type="submit" className="btn primary">
            Search
          </button>
        </form>

        {!q && (
          <div className="search-suggest">
            <span>Try:</span>
            {SUGGESTIONS.map((s) => (
              <Link key={s} href={`/search?q=${encodeURIComponent(s)}`} className="chip">
                {s}
              </Link>
            ))}
          </div>
        )}

        {q && (
          <p className="search-count" aria-live="polite">
            {hits.length ? `${hits.length} paper${hits.length === 1 ? "" : "s"}` : "No papers"} matching <strong>“{q}”</strong>
            {domains.length ? ` and ${domains.length} domain${domains.length === 1 ? "" : "s"}` : ""}
          </p>
        )}

        {domains.length > 0 && (
          <section aria-label="Matching domains" className="search-domains">
            {domains.map((d) => (
              <Link key={d.domainId} href={domainHref(d.week, d.domainId)} className="search-domain" style={hueStyle(domainTheme(d.domainId, d.domainName).hue)}>
                <span className="jump-dot" aria-hidden="true" />
                <span>
                  <strong>{d.domainName}</strong>
                  <small>Domain page · {d.papers} paper{d.papers === 1 ? "" : "s"} this week</small>
                </span>
                <IconArrow />
              </Link>
            ))}
          </section>
        )}

        {hits.length > 0 && (
          <ol className="search-results">
            {hits.map((h) => (
              <li key={`${h.week}:${h.card.arxivId}`} className="search-hit" style={hueStyle(domainTheme(h.domainId, h.domainName).hue)}>
                <div className="search-meta">
                  {h.domainId ? (
                    <Link href={domainHref(h.week, h.domainId)} className="search-dom">
                      <span className="jump-dot" aria-hidden="true" /> {h.domainName}
                    </Link>
                  ) : (
                    <span className="search-dom">{h.domainName}</span>
                  )}
                  <span>Week {h.week.split("-W")[1]}</span>
                  {h.top && <span className="search-top">Top 3</span>}
                  <span className={`verdict verdict-${h.card.verdict}`}>{VERDICT[h.card.verdict].label}</span>
                </div>
                <h2>
                  <a href={h.card.url} target="_blank" rel="noopener noreferrer">
                    <Highlight text={h.card.title} terms={terms} />
                  </a>
                </h2>
                <p>
                  <Highlight text={h.card.whyItMatters} terms={terms} />
                </p>
                {h.card.signals.length > 0 && (
                  <ul className="search-signals">
                    {h.card.signals.map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
        )}

        {q && !hits.length && !domains.length && (
          <div className="search-empty">
            <p>Nothing in the published briefs mentions this yet.</p>
            <p>
              Want it covered from next Monday? <Link href="/settings">Add it as a domain</Link>: the AI suggests the arXiv categories and search phrases.
            </p>
          </div>
        )}
      </main>
    </>
  );
}
