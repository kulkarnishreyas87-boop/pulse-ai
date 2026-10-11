import Link from "next/link";
import type { Brief, BriefCard, BriefSection } from "@/lib/schema";
import { domainTheme, hueStyle, type ArtKind } from "@/lib/theme";
import { DomainArt } from "./DomainArt";
import { ReadingProgress, Reveal, SectionSpy } from "./Motion";
import {
  IconAlert, IconArrow, IconBook, IconCheck, IconClock, IconCompass, IconEye, IconFlag, IconLayers, IconPulse, IconSettings, IconSparkle, IconTarget, IconZap,
} from "./Icons";

const VERDICT = {
  read: { label: "Read in full", Icon: IconBook },
  skim: { label: "Skim it", Icon: IconEye },
  client_flag: { label: "Raise with clients", Icon: IconFlag },
} as const;

const SIGNAL_ICON: Record<string, (p: { className?: string }) => React.ReactElement> = {
  "New benchmark": IconTarget,
  "Surprising result": IconZap,
  "Reframes the problem": IconCompass,
};

function fmt(iso: string, withYear = false) {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}), timeZone: "UTC" });
}

function Verdict({ v }: { v: BriefCard["verdict"] }) {
  const { label, Icon } = VERDICT[v];
  return (
    <span className={`verdict verdict-${v}`}>
      <Icon /> {label}
    </span>
  );
}

function Signals({ signals }: { signals: string[] }) {
  if (!signals.length) return null;
  return (
    <ul className="signals" aria-label="Why this paper matters">
      {signals.map((s) => {
        const Icon = SIGNAL_ICON[s] ?? IconSparkle;
        return (
          <li key={s} className="signal">
            <Icon /> {s}
          </li>
        );
      })}
    </ul>
  );
}

function Details({ c }: { c: BriefCard }) {
  if (!c.clientAngle && !c.caveats && !c.evidenceQuote) return null;
  return (
    <details className="details">
      <summary>Client angle, caveats &amp; evidence</summary>
      <div className="details-body">
        {c.clientAngle && (
          <p>
            <span className="label">Client angle</span> {c.clientAngle}
          </p>
        )}
        {c.caveats && (
          <p>
            <span className="label">Caveats</span> {c.caveats}
          </p>
        )}
        {c.evidenceQuote && <blockquote className="quote">&ldquo;{c.evidenceQuote}&rdquo;</blockquote>}
      </div>
    </details>
  );
}

/** One paper. `feature` is the larger treatment used in "This week at a glance". */
function PaperCard({ c, hue, kind, rank, feature = false }: { c: BriefCard; hue: number; kind: ArtKind; rank?: number; feature?: boolean }) {
  return (
    <article className={`paper ${feature ? "paper-feature" : ""} paper-${c.verdict}`} style={hueStyle(hue)} id={rank ? `top-${rank}` : undefined}>
      {feature && (
        <div className="paper-art">
          <DomainArt kind={kind} hue={hue} seed={c.arxivId} />
          {rank && <span className="rank">{String(rank).padStart(2, "0")}</span>}
          {c.domain && <span className="domain-chip on-art">{c.domain}</span>}
        </div>
      )}
      <div className="paper-body">
        <div className="paper-top">
          <Verdict v={c.verdict} />
          <Signals signals={c.signals} />
        </div>
        <h3 className="paper-title">
          <a href={c.url} target="_blank" rel="noreferrer">
            {c.title}
            <IconArrow className="ext" />
          </a>
        </h3>
        {c.whyItMatters && <p className="lead">{c.whyItMatters}</p>}
        <p className="summary">{c.summary}</p>
        <Details c={c} />
        <p className="meta">
          {c.authors}
          <span className="dot" aria-hidden="true">·</span>
          {c.confidence}
        </p>
      </div>
    </article>
  );
}

function DomainSection({ s, brief, index }: { s: BriefSection; brief: Brief; index: number }) {
  const { hue, kind } = domainTheme(s.domainId, s.domainName);
  const featured = brief.topThree.filter((c) => s.featured.includes(c.arxivId));
  const count = s.cards.length + featured.length;
  return (
    <section className="domain" id={s.domainId} style={hueStyle(hue)} aria-labelledby={`h-${s.domainId}`}>
      <Reveal className="domain-head">
        <div className="domain-badge">
          <DomainArt kind={kind} hue={hue} seed={s.domainId} />
        </div>
        <div>
          <p className="eyebrow">Domain {String(index + 1).padStart(2, "0")}</p>
          <h2 id={`h-${s.domainId}`}>{s.domainName}</h2>
          <p className="domain-count">
            {s.status === "quiet" ? "Quiet week" : s.status === "degraded" ? "Limited data this week" : `${count} paper${count === 1 ? "" : "s"} worth your time`}
          </p>
        </div>
      </Reveal>

      {s.takeaway && (
        <Reveal className="takeaway" delay={80}>
          <span className="takeaway-label">
            <IconSparkle /> This week
          </span>
          <p>{s.takeaway}</p>
        </Reveal>
      )}

      {s.status === "quiet" && (
        <Reveal className="empty">
          <IconCheck /> {s.note ?? "Nothing cleared the significance bar this week. That is a result, not a gap."}
        </Reveal>
      )}
      {s.status === "degraded" && (
        <Reveal className="notice">
          <IconAlert /> {s.note ?? "Summaries were unavailable for this domain; showing the best matches with their abstracts."}
        </Reveal>
      )}

      {featured.length > 0 && (
        <p className="featured-note">
          Featured above:{" "}
          {featured.map((c, i) => (
            <span key={c.arxivId}>
              {i > 0 && " · "}
              <a href={`#top-${brief.topThree.findIndex((t) => t.arxivId === c.arxivId) + 1}`}>{c.title}</a>
            </span>
          ))}
        </p>
      )}

      {s.cards.length > 0 && (
        <div className="paper-grid">
          {s.cards.map((c, i) => (
            <Reveal key={c.arxivId} delay={70 * i}>
              <PaperCard c={c} hue={hue} kind={kind} />
            </Reveal>
          ))}
        </div>
      )}
    </section>
  );
}

export function BriefView({ brief, weeks = [] }: { brief: Brief; weeks?: string[] }) {
  const m = brief.meta;
  const picked = brief.topThree.length + brief.sections.reduce((n, s) => n + s.cards.length, 0);
  const wk = Number(brief.week.split("-W")[1]);
  const top = brief.topThree.map((c) => {
    const sec = brief.sections.find((s) => s.featured.includes(c.arxivId)) ?? brief.sections.find((s) => s.domainName === c.domain);
    return { c, theme: domainTheme(sec?.domainId ?? c.domain, c.domain) };
  });

  return (
    <>
      <ReadingProgress />
      <SectionSpy ids={brief.sections.map((s) => s.domainId)} />

      <header className="hero">
        <div className="hero-bg" aria-hidden="true">
          <span className="blob b1" />
          <span className="blob b2" />
          <span className="blob b3" />
          <span className="grain" />
        </div>
        <div className="wrap hero-inner">
          <div className="topbar">
            <span className="brand">
              <span className="brand-mark" aria-hidden="true">
                <IconPulse />
              </span>
              Research Pulse
            </span>
            <Link href="/settings" className="ghost-btn">
              <IconSettings /> Edit domains
            </Link>
          </div>
          <p className="eyebrow light">
            <span className="live-dot" aria-hidden="true" /> Weekly research brief · Week {Number.isFinite(wk) ? wk : brief.week}
          </p>
          <h1>
            What mattered in <span className="grad-text">AI research</span> this week
          </h1>
          <p className="hero-sub">
            {fmt(brief.windowStart)} to {fmt(brief.windowEnd, true)}. The papers worth your attention, why they matter, and what to tell clients.
          </p>
          <ul className="stats">
            {m.papersSeen ? (
              <li>
                <IconLayers /> <strong>{m.papersSeen.toLocaleString()}</strong> scanned
              </li>
            ) : null}
            {m.papersScored ? (
              <li>
                <IconSparkle /> <strong>{m.papersScored}</strong> scored by AI
              </li>
            ) : null}
            <li>
              <IconCheck /> <strong>{picked}</strong> picked for you
            </li>
            {m.readingMinutes ? (
              <li>
                <IconClock /> <strong>{m.readingMinutes} min</strong> read
              </li>
            ) : null}
          </ul>
          {m.coverageStart && (
            <p className="hero-note">Includes papers arXiv published late (submitted from {fmt(m.coverageStart)}), so nothing slips between weeks.</p>
          )}
        </div>
      </header>

      <nav className="jumpbar" aria-label="Sections of this brief">
        <div className="wrap jumpbar-inner">
          {top.length > 0 && (
            <a href="#glance" className="jump" data-spy="glance">
              <IconSparkle /> At a glance
            </a>
          )}
          {brief.sections.map((s) => (
            <a key={s.domainId} href={`#${s.domainId}`} className="jump" data-spy={s.domainId} style={hueStyle(domainTheme(s.domainId, s.domainName).hue)}>
              <span className="jump-dot" aria-hidden="true" /> {s.domainName}
            </a>
          ))}
        </div>
      </nav>

      <main className="wrap">
        {(brief.isSample || brief.isStale || brief.isPartial) && (
          <div className="banners">
            {brief.isSample && (
              <p className="banner banner-info">
                <IconAlert /> Sample data. The first live brief replaces this after the next Monday run.
              </p>
            )}
            {brief.isStale && (
              <p className="banner banner-warn">
                <IconAlert /> arXiv was unavailable for part of this run, so some results rest on Hugging Face alone.
              </p>
            )}
            {brief.isPartial && (
              <p className="banner banner-warn">
                <IconAlert /> Partial brief: {m.domainsMissing?.join(", ") || "some domains"} were not ready in time.
              </p>
            )}
          </div>
        )}

        {top.length > 0 && (
          <section id="glance" className="glance" aria-labelledby="h-glance">
            <Reveal className="section-head">
              <p className="eyebrow">Start here</p>
              <h2 id="h-glance">This week at a glance</h2>
              <p className="section-sub">The three papers most worth your time, across every domain.</p>
            </Reveal>
            <div className="glance-grid">
              {top.map(({ c, theme }, i) => (
                <Reveal key={c.arxivId} delay={100 * i} className={i === 0 ? "glance-lead" : ""}>
                  <PaperCard c={c} hue={theme.hue} kind={theme.kind} rank={i + 1} feature />
                </Reveal>
              ))}
            </div>
          </section>
        )}

        {brief.sections.map((s, i) => (
          <DomainSection key={s.domainId} s={s} brief={brief} index={i} />
        ))}

        <Reveal as="section" className="how">
          <h2>How this brief is made</h2>
          <ol className="how-steps">
            <li>
              <span className="step-n">1</span>
              <div>
                <strong>Scan</strong>
                <p>Every new arXiv paper in each domain, plus community signals from Hugging Face.</p>
              </div>
            </li>
            <li>
              <span className="step-n">2</span>
              <div>
                <strong>Judge</strong>
                <p>Gemini scores each abstract for relevance, evidence and hype, and for the signals that matter: a new benchmark, a surprising result, or a reframing.</p>
              </div>
            </li>
            <li>
              <span className="step-n">3</span>
              <div>
                <strong>Check</strong>
                <p>Every summary is fact-checked against its abstract. Quotes and numbers must appear there verbatim, or they are removed.</p>
              </div>
            </li>
          </ol>
          <p className="fineprint">Papers are preprints and not peer reviewed. Open the paper before quoting it to a client.</p>
        </Reveal>

        {weeks.length > 0 && (
          <footer className="archive">
            <h2>Earlier briefs</h2>
            <div className="archive-list">
              {weeks.map((w) => (
                <Link key={w} href={`/brief/${w}`} className="archive-pill">
                  Week {Number(w.split("-W")[1])}, {w.split("-W")[0]}
                </Link>
              ))}
            </div>
          </footer>
        )}
      </main>
    </>
  );
}
