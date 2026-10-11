import type { Brief, BriefCard } from "../schema";

export const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Paper titles and URLs come from third parties. Only plain https arXiv links are ever put in an email. */
export function safeUrl(u: string): string | null {
  return /^https:\/\/arxiv\.org\/abs\/[A-Za-z0-9./_-]+$/.test(u) ? u : null;
}

const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

const LABEL = { read: "READ", skim: "SKIM", client_flag: "CLIENT FLAG" } as const;
const COLOR = { read: "#1f8a4d", skim: "#5d667a", client_flag: "#c0392b" } as const;

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/** The one-sentence reason to care. If the verifier removed it, fall back to the first sentence of the summary. */
function headline(c: BriefCard): string {
  if (c.whyItMatters) return c.whyItMatters;
  const first = c.summary.match(/^[^.!?]+[.!?]/)?.[0];
  return first ?? c.summary;
}

export function subjectFor(brief: Brief): string {
  const wk = Number(brief.week.split("-W")[1]);
  const top = brief.topThree[0]?.title;
  const base = `Research Pulse · Week ${wk}${top ? `: ${clip(oneLine(top), 70)}` : ""}`;
  return brief.isPartial ? `[Partial] ${base}` : base;
}

export interface Rendered {
  subject: string;
  html: string;
  text: string;
}

export function renderEmail(brief: Brief, appUrl: string, opts: { updated?: boolean } = {}): Rendered {
  const webUrl = `${appUrl.replace(/\/$/, "")}/brief/${encodeURIComponent(brief.week)}`;
  const range = `${fmtDate(brief.windowStart)} to ${fmtDate(brief.windowEnd)}`;
  const minutes = brief.meta.readingMinutes;
  const notes: string[] = [];
  if (opts.updated) notes.push("Updated: the domains that were missing in the earlier email are now included.");
  if (brief.isPartial) notes.push(`Partial brief: ${brief.meta.domainsMissing?.join(", ") || "some domains"} were not ready in time. An update will follow if they finish.`);
  if (brief.isStale) notes.push("arXiv was unavailable for part of this run, so some results rest on Hugging Face alone.");
  if (brief.meta.domainsDegraded?.length) notes.push(`AI summaries were unavailable for: ${brief.meta.domainsDegraded.join(", ")}.`);

  const cardHtml = (c: BriefCard, big: boolean) => {
    const link = safeUrl(c.url);
    const title = link ? `<a href="${esc(link)}" style="color:#2f62c9;text-decoration:none">${esc(c.title)}</a>` : esc(c.title);
    return `<div style="margin:0 0 ${big ? 18 : 12}px">
  <div style="font-size:11px;font-weight:700;letter-spacing:.04em;color:${COLOR[c.verdict]}">${LABEL[c.verdict]}${c.domain ? ` <span style="color:#8a93a6">· ${esc(c.domain.toUpperCase())}</span>` : ""}</div>
  <div style="font-size:${big ? 16 : 15}px;font-weight:600;margin:2px 0 4px">${title}</div>
  ${c.signals.length ? `<div style="font-size:11px;color:#2f62c9;font-weight:600;margin:0 0 3px">${c.signals.map(esc).join(" · ")}</div>` : ""}
  <div style="font-size:14px;color:#1b2130">${esc(headline(c))}</div>${big && c.clientAngle ? `\n  <div style="font-size:13px;color:#5d667a;margin-top:4px"><b>Client angle:</b> ${esc(c.clientAngle)}</div>` : ""}
</div>`;
  };

  const sections = brief.sections
    .map((s) => {
      const inner =
        s.status === "quiet"
          ? `<div style="font-size:14px;color:#5d667a;font-style:italic">Nothing significant this week.</div>`
          : s.cards.length || s.featured.length
            ? [
                ...(s.featured.length ? [`<div style="font-size:13px;color:#5d667a;margin:0 0 8px">Top story above: ${esc(brief.topThree.filter((t) => s.featured.includes(t.arxivId)).map((t) => clip(t.title, 60)).join("; "))}</div>`] : []),
                ...s.cards.map((c) => cardHtml(c, false)),
              ].join("\n")
            : `<div style="font-size:14px;color:#5d667a;font-style:italic">${esc(s.note ?? "Nothing further this week.")}</div>`;
      const take = s.takeaway ? `<div style="font-size:14px;margin:0 0 12px;padding:8px 10px;border-left:3px solid #2f62c9;background:#f6f7f9"><b>This week:</b> ${esc(s.takeaway)}</div>\n` : "";
      return `<h2 style="font-size:15px;margin:26px 0 10px;padding-bottom:6px;border-bottom:1px solid #dde1ea">${esc(s.domainName)}</h2>\n${take}${inner}`;
    })
    .join("\n");

  const html = `<!doctype html>
<html><body style="margin:0;background:#f6f7f9;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:#1b2130">
<div style="max-width:620px;margin:0 auto;padding:24px 16px">
<div style="background:#ffffff;border:1px solid #dde1ea;border-radius:10px;padding:24px">
<h1 style="font-size:22px;margin:0">Research Pulse</h1>
<div style="font-size:13px;color:#5d667a;margin:4px 0 16px">Week of ${esc(range)}${minutes ? ` · full brief is about ${minutes} min` : ""}</div>
${notes.map((n) => `<div style="font-size:13px;border:1px solid #d49a12;border-radius:6px;padding:8px 10px;margin:0 0 10px">${esc(n)}</div>`).join("\n")}
${brief.topThree.length ? `<h2 style="font-size:15px;margin:18px 0 10px;padding-bottom:6px;border-bottom:1px solid #dde1ea">This week at a glance</h2>\n${brief.topThree.map((c) => cardHtml(c, true)).join("\n")}` : ""}
${sections}
<div style="margin:28px 0 8px"><a href="${esc(webUrl)}" style="display:inline-block;background:#2f62c9;color:#ffffff;text-decoration:none;font-size:14px;padding:10px 16px;border-radius:8px">Read the full brief</a></div>
<div style="font-size:12px;color:#8a93a6;margin-top:18px">Papers are arXiv preprints, not peer reviewed. Summaries are AI-generated from the abstracts and checked against them. Open the paper before quoting it to a client.</div>
</div></div></body></html>`;

  const textCard = (c: BriefCard) => {
    const link = safeUrl(c.url);
    return `[${LABEL[c.verdict]}] ${oneLine(c.title)}${c.signals.length ? ` (${c.signals.join(", ")})` : ""}\n  ${oneLine(headline(c))}${link ? `\n  ${link}` : ""}`;
  };
  const text = [
    `Research Pulse: week of ${range}${minutes ? ` (full brief is about ${minutes} min)` : ""}`,
    ...notes.map((n) => `NOTE: ${n}`),
    brief.topThree.length ? `\nTHIS WEEK AT A GLANCE\n${brief.topThree.map((c) => `${textCard(c)}${c.clientAngle ? `\n  Client angle: ${oneLine(c.clientAngle)}` : ""}`).join("\n\n")}` : "",
    ...brief.sections.map((s) => `\n${s.domainName.toUpperCase()}\n${s.takeaway ? `This week: ${oneLine(s.takeaway)}\n\n` : ""}${s.status === "quiet" ? "Nothing significant this week." : s.cards.length ? s.cards.map(textCard).join("\n\n") : s.featured.length ? "See the top story above." : (s.note ?? "Nothing further this week.")}`),
    `\nRead the full brief: ${webUrl}`,
    "\nPapers are arXiv preprints, not peer reviewed. Summaries are AI-generated from the abstracts and checked against them.",
  ]
    .filter(Boolean)
    .join("\n");

  return { subject: subjectFor(brief), html, text };
}
