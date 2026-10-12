import type { BriefCard } from "@/lib/schema";
import { hueStyle, type ArtKind } from "@/lib/theme";
import { DomainArt } from "./DomainArt";
import { SaveButton } from "./SaveButton";
import type { SaveContext } from "@/lib/saved";
import { IconArrow, IconBook, IconCompass, IconEye, IconFlag, IconSparkle, IconTarget, IconZap } from "./Icons";

export const VERDICT = {
  read: { label: "Read in full", Icon: IconBook },
  skim: { label: "Skim it", Icon: IconEye },
  client_flag: { label: "Raise with clients", Icon: IconFlag },
} as const;

const SIGNAL_ICON: Record<string, (p: { className?: string }) => React.ReactElement> = {
  "New benchmark": IconTarget,
  "Surprising result": IconZap,
  "Reframes the problem": IconCompass,
};

export function Verdict({ v }: { v: BriefCard["verdict"] }) {
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

/** One paper. `feature` is the larger treatment with artwork, used for top stories. */
export function PaperCard({ c, hue, kind, rank, feature = false, topBadge = false, save }: { c: BriefCard; hue: number; kind: ArtKind; rank?: number; feature?: boolean; topBadge?: boolean; save?: SaveContext }) {
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
          {topBadge && (
            <span className="top-badge">
              <IconSparkle /> Top story this week
            </span>
          )}
          <Verdict v={c.verdict} />
          <Signals signals={c.signals} />
          {save && <SaveButton card={c} ctx={save} />}
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
