import Link from "next/link";
import type { Brief, BriefSection } from "@/lib/schema";
import { DOMAIN_PHOTOS, creditUrl, domainTheme, hueStyle } from "@/lib/theme";
import { DomainPhoto, PhotoCredit } from "./DomainPhoto";
import { PaperCard, VERDICT } from "./Paper";
import { ReadingProgress, Reveal } from "./Motion";
import { IconAlert, IconArrow, IconCheck, IconClock, IconLayers, IconBookmark, IconPulse, IconSearch, IconSettings, IconSparkle } from "./Icons";

/* ---------- shared helpers ---------- */

function fmt(iso: string, withYear = false) {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}), timeZone: "UTC" });
}

/** The latest brief lives at "/" and "/domain/<id>"; an archived week at "/brief/<week>" and "/brief/<week>/<id>". */
export interface Routes {
  overview: string;
  domain: (id: string) => string;
}
export const routesFor = (brief: Brief, latest: boolean): Routes =>
  latest ? { overview: "/", domain: (id) => `/domain/${id}` } : { overview: `/brief/${brief.week}`, domain: (id) => `/brief/${brief.week}/${id}` };

const weekNo = (b: Brief) => Number(b.week.split("-W")[1]);

/** Every paper shown for a domain: its top stories first, then the rest. */
export function domainPapers(brief: Brief, s: BriefSection) {
  const featured = brief.topThree.filter((c) => s.featured.includes(c.arxivId));
  return { featured, cards: s.cards, total: featured.length + s.cards.length };
}

function Topbar({ home }: { home: string }) {
  return (
    <div className="topbar">
      <Link href={home} className="brand" style={{ textDecoration: "none" }}>
        <span className="brand-mark" aria-hidden="true">
          <IconPulse />
        </span>
        Pulse-AI
      </Link>
      <div className="topbar-actions">
        <Link href="/search" className="ghost-btn">
          <IconSearch /> Search
        </Link>
        <Link href="/saved" className="ghost-btn">
          <IconBookmark /> Saved
        </Link>
        <Link href="/settings" className="ghost-btn">
          <IconSettings /> Edit domains
        </Link>
      </div>
    </div>
  );
}

/** Sticky tabs: the overview plus one tab per domain page. */
function DomainTabs({ brief, routes, current }: { brief: Brief; routes: Routes; current: string }) {
  return (
    <nav className="jumpbar" aria-label="Brief sections">
      <div className="wrap jumpbar-inner">
        <Link href={routes.overview} className={`jump ${current === "overview" ? "is-current" : ""}`} aria-current={current === "overview" ? "page" : undefined}>
          <IconSparkle /> Overview
        </Link>
        {brief.sections.map((s) => (
          <Link
            key={s.domainId}
            href={routes.domain(s.domainId)}
            className={`jump ${current === s.domainId ? "is-current" : ""}`}
            aria-current={current === s.domainId ? "page" : undefined}
            style={hueStyle(domainTheme(s.domainId, s.domainName).hue)}
          >
            <span className="jump-dot" aria-hidden="true" /> {s.domainName}
          </Link>
        ))}
      </div>
    </nav>
  );
}

function Banners({ brief }: { brief: Brief }) {
  if (!brief.isSample && !brief.isStale && !brief.isPartial) return null;
  return (
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
          <IconAlert /> Partial brief: {brief.meta.domainsMissing?.join(", ") || "some domains"} were not ready in time.
        </p>
      )}
    </div>
  );
}

/* ---------- overview page ---------- */

function DomainTile({ s, brief, routes, index }: { s: BriefSection; brief: Brief; routes: Routes; index: number }) {
  const theme = domainTheme(s.domainId, s.domainName);
  const { featured, cards, total } = domainPapers(brief, s);
  const all = [...featured, ...cards];
  const tally = (Object.keys(VERDICT) as (keyof typeof VERDICT)[]).map((v) => ({ v, n: all.filter((c) => c.verdict === v).length })).filter((x) => x.n);
  return (
    <Reveal delay={80 * index}>
      <Link href={routes.domain(s.domainId)} className="tile" style={hueStyle(theme.hue)} aria-label={`${s.domainName}: open this domain's papers`}>
        <div className="tile-media">
          <DomainPhoto domainId={s.domainId} theme={theme} width={800} />
          <div className="tile-shade" aria-hidden="true" />
          <div className="tile-head">
            <span className="tile-eyebrow">Domain {String(index + 1).padStart(2, "0")}</span>
            <h3>{s.domainName}</h3>
          </div>
        </div>
        <div className="tile-body">
          <p className="tile-count">
            {s.status === "quiet" ? "Quiet week: nothing cleared the bar" : s.status === "degraded" ? "Limited data this week" : `${total} paper${total === 1 ? "" : "s"} worth your time`}
          </p>
          {s.takeaway && <p className="tile-take">{s.takeaway}</p>}
          {tally.length > 0 && (
            <ul className="tally">
              {tally.map(({ v, n }) => (
                <li key={v} className={`verdict verdict-${v}`}>
                  {n} × {VERDICT[v].label}
                </li>
              ))}
            </ul>
          )}
          <span className="tile-cta">
            Open {s.domainName} <IconArrow />
          </span>
        </div>
      </Link>
    </Reveal>
  );
}

export function BriefOverview({ brief, weeks = [], latest = true }: { brief: Brief; weeks?: string[]; latest?: boolean }) {
  const m = brief.meta;
  const routes = routesFor(brief, latest);
  const picked = brief.topThree.length + brief.sections.reduce((n, s) => n + s.cards.length, 0);
  const wk = weekNo(brief);
  const top = brief.topThree.map((c) => {
    const sec = brief.sections.find((s) => s.featured.includes(c.arxivId)) ?? brief.sections.find((s) => s.domainName === c.domain);
    return { c, sec, theme: domainTheme(sec?.domainId ?? c.domain, c.domain) };
  });

  return (
    <>
      <ReadingProgress />
      <header className="hero">
        <div className="hero-bg" aria-hidden="true">
          <span className="blob b1" />
          <span className="blob b2" />
          <span className="blob b3" />
          <span className="grain" />
        </div>
        <div className="wrap hero-inner">
          <Topbar home="/" />
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
          {m.coverageStart && <p className="hero-note">Includes papers arXiv published late (submitted from {fmt(m.coverageStart)}), so nothing slips between weeks.</p>}
        </div>
      </header>

      <DomainTabs brief={brief} routes={routes} current="overview" />

      <main className="wrap">
        <Banners brief={brief} />

        {top.length > 0 && (
          <section className="glance" aria-labelledby="h-glance">
            <Reveal className="section-head">
              <p className="eyebrow">Start here</p>
              <h2 id="h-glance">This week at a glance</h2>
              <p className="section-sub">The three papers most worth your time, across every domain.</p>
            </Reveal>
            <div className="glance-grid">
              {top.map(({ c, sec, theme }, i) => (
                <Reveal key={c.arxivId} delay={100 * i} className={i === 0 ? "glance-lead" : ""}>
                  <PaperCard c={c} hue={theme.hue} kind={theme.kind} rank={i + 1} feature save={{ week: brief.week, domainId: sec?.domainId ?? "", domainName: sec?.domainName ?? c.domain }} />
                </Reveal>
              ))}
            </div>
          </section>
        )}

        <section className="domains-overview" aria-labelledby="h-domains">
          <Reveal className="section-head">
            <p className="eyebrow">Explore</p>
            <h2 id="h-domains">Your domains this week</h2>
            <p className="section-sub">Each domain has its own page with every paper, the week&apos;s takeaway and what to tell clients.</p>
          </Reveal>
          <div className="tile-grid">
            {brief.sections.map((s, i) => (
              <DomainTile key={s.domainId} s={s} brief={brief} routes={routes} index={i} />
            ))}
          </div>
          <OverviewCredits brief={brief} />
        </section>

        <HowItsMade />

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

/** Credits every photographer whose photo appears in the tiles above. */
function OverviewCredits({ brief }: { brief: Brief }) {
  const shown = brief.sections.map((s) => DOMAIN_PHOTOS[s.domainId]).filter(Boolean);
  if (!shown.length) return null;
  return (
    <p className="photo-credit tiles-credit">
      Photos on{" "}
      <a href={creditUrl("https://unsplash.com")} target="_blank" rel="noreferrer">
        Unsplash
      </a>{" "}
      by{" "}
      {shown.map((p, i) => (
        <span key={p.page}>
          {i > 0 && (i === shown.length - 1 ? " and " : ", ")}
          <a href={creditUrl(p.page)} target="_blank" rel="noreferrer">
            {p.photographer}
          </a>
        </span>
      ))}
      .
    </p>
  );
}

function HowItsMade() {
  return (
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
  );
}

/* ---------- domain page ---------- */

export function DomainView({ brief, domainId, latest = true }: { brief: Brief; domainId: string; latest?: boolean }) {
  const routes = routesFor(brief, latest);
  const index = brief.sections.findIndex((s) => s.domainId === domainId);
  const s = brief.sections[index];
  const theme = domainTheme(s.domainId, s.domainName);
  const { featured, cards, total } = domainPapers(brief, s);
  const prev = brief.sections[index - 1];
  const next = brief.sections[index + 1];
  const saveCtx = { week: brief.week, domainId: s.domainId, domainName: s.domainName };

  return (
    <>
      <ReadingProgress />
      <header className="dhero" style={hueStyle(theme.hue)}>
        <div className="dhero-media" aria-hidden="true">
          <DomainPhoto domainId={s.domainId} theme={theme} width={1800} eager />
        </div>
        <div className="dhero-shade" aria-hidden="true" />
        <div className="wrap dhero-inner">
          <Topbar home="/" />
          <Link href={routes.overview} className="crumb">
            ← Week {weekNo(brief)} overview
          </Link>
          <p className="eyebrow light">
            Domain {String(index + 1).padStart(2, "0")} of {brief.sections.length} · {fmt(brief.windowStart)} to {fmt(brief.windowEnd, true)}
          </p>
          <h1>{s.domainName}</h1>
          <p className="hero-sub">
            {s.status === "quiet"
              ? "A quiet week: nothing cleared the significance bar."
              : s.status === "degraded"
                ? "Limited data this week."
                : `${total} paper${total === 1 ? "" : "s"} worth your time this week.`}
          </p>
          <PhotoCredit domainId={s.domainId} className="on-dark" />
        </div>
      </header>

      <DomainTabs brief={brief} routes={routes} current={s.domainId} />

      <main className="wrap domain-page" style={hueStyle(theme.hue)}>
        <Banners brief={brief} />

        {s.takeaway && (
          <Reveal className="takeaway">
            <span className="takeaway-label">
              <IconSparkle /> This week in {s.domainName}
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

        {total > 0 && (
          <div className="paper-grid">
            {featured.map((c, i) => (
              <Reveal key={c.arxivId} delay={70 * i}>
                <PaperCard c={c} hue={theme.hue} kind={theme.kind} topBadge save={saveCtx} />
              </Reveal>
            ))}
            {cards.map((c, i) => (
              <Reveal key={c.arxivId} delay={70 * (i + featured.length)}>
                <PaperCard c={c} hue={theme.hue} kind={theme.kind} save={saveCtx} />
              </Reveal>
            ))}
          </div>
        )}

        <nav className="pager" aria-label="Other domains">
          {prev ? (
            <Link href={routes.domain(prev.domainId)} className="pager-link" style={hueStyle(domainTheme(prev.domainId, prev.domainName).hue)}>
              <span className="pager-thumb">
                <DomainPhoto domainId={prev.domainId} theme={domainTheme(prev.domainId, prev.domainName)} width={240} />
              </span>
              <span>
                <small>← Previous domain</small>
                <strong>{prev.domainName}</strong>
              </span>
            </Link>
          ) : (
            <Link href={routes.overview} className="pager-link">
              <span>
                <small>← Back to</small>
                <strong>Week {weekNo(brief)} overview</strong>
              </span>
            </Link>
          )}
          {next ? (
            <Link href={routes.domain(next.domainId)} className="pager-link pager-next" style={hueStyle(domainTheme(next.domainId, next.domainName).hue)}>
              <span>
                <small>Next domain →</small>
                <strong>{next.domainName}</strong>
              </span>
              <span className="pager-thumb">
                <DomainPhoto domainId={next.domainId} theme={domainTheme(next.domainId, next.domainName)} width={240} />
              </span>
            </Link>
          ) : (
            <Link href={routes.overview} className="pager-link pager-next">
              <span>
                <small>Done →</small>
                <strong>Back to the overview</strong>
              </span>
            </Link>
          )}
        </nav>
      </main>
    </>
  );
}
