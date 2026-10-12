import type { Brief, BriefCard } from "./schema";

/**
 * Search across published briefs for a topic, paper or domain. Pure and deterministic (no AI call): every word
 * of the query must appear somewhere on the card, and where it appears decides the order (title first).
 */
export const MAX_QUERY = 100;
const MAX_TERMS = 8;

export interface SearchHit {
  week: string;
  domainId: string;
  domainName: string;
  card: BriefCard;
  top: boolean; // one of that week's top three
  score: number;
}

export interface DomainHit {
  domainId: string;
  domainName: string;
  week: string;
  papers: number;
}

export function queryTerms(q: string): string[] {
  const words = q.toLowerCase().slice(0, MAX_QUERY).match(/[\p{L}\p{N}][\p{L}\p{N}+#.-]*/gu) ?? [];
  return [...new Set(words.map((w) => w.replace(/[.-]+$/, "")).filter((w) => w.length >= 2))].slice(0, MAX_TERMS);
}

// Where a word is found, and how much that counts.
const FIELDS: [keyof BriefCard | "domainName", number][] = [
  ["title", 5],
  ["signals", 3],
  ["domainName", 3],
  ["whyItMatters", 2],
  ["summary", 2],
  ["clientAngle", 1],
  ["authors", 1],
  ["caveats", 1],
  ["arxivId", 5],
];

function scoreCard(card: BriefCard, domainName: string, terms: string[], phrase: string): number {
  const text: Record<string, string> = {
    ...Object.fromEntries(FIELDS.map(([f]) => [f, f === "domainName" ? domainName : String((card as any)[f] ?? "")])),
    signals: card.signals.join(" "),
  };
  for (const k in text) text[k] = text[k].toLowerCase();
  let score = 0;
  for (const t of terms) {
    let best = 0;
    for (const [f, w] of FIELDS) if (text[f].includes(t)) best = Math.max(best, w);
    if (!best) return 0; // every word must match somewhere
    score += best;
  }
  if (terms.length > 1 && text.title.includes(phrase)) score += 5; // the whole phrase in the title
  return score;
}

/** Briefs newest first. Returns paper hits (best first, newest week on ties) and domains whose name matches. */
export function searchBriefs(briefs: Brief[], q: string, limit = 40): { terms: string[]; hits: SearchHit[]; domains: DomainHit[] } {
  const terms = queryTerms(q);
  if (!terms.length) return { terms, hits: [], domains: [] };
  const phrase = terms.join(" ");
  const hits: SearchHit[] = [];
  const domains = new Map<string, DomainHit>();
  const seen = new Set<string>();
  for (const b of briefs) {
    const sectionOf = (id: string) => b.sections.find((s) => s.featured.includes(id) || s.cards.some((c) => c.arxivId === id));
    for (const s of b.sections) {
      const name = s.domainName.toLowerCase();
      if (!domains.has(s.domainId) && terms.every((t) => name.includes(t) || s.domainId.includes(t)))
        domains.set(s.domainId, { domainId: s.domainId, domainName: s.domainName, week: b.week, papers: s.cards.length + s.featured.length });
    }
    const cards = [...b.topThree.map((c) => ({ c, top: true })), ...b.sections.flatMap((s) => s.cards.map((c) => ({ c, top: false })))];
    for (const { c, top } of cards) {
      const key = `${b.week}:${c.arxivId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const s = sectionOf(c.arxivId);
      const domainName = s?.domainName ?? c.domain;
      const score = scoreCard(c, domainName, terms, phrase);
      if (score) hits.push({ week: b.week, domainId: s?.domainId ?? "", domainName, card: c, top, score });
    }
  }
  hits.sort((a, b) => b.score - a.score || b.week.localeCompare(a.week));
  return { terms, hits: hits.slice(0, limit), domains: [...domains.values()] };
}
