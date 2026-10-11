import type { Brief, BriefCard, BriefSection } from "../schema";
import type { WeekWindow } from "../week";
import type { RankedPaper } from "./rank";

/** ~200 words per minute. 1,800 words (9 min) leaves headroom under the "under ten minutes" promise, enforced in code. */
export const WORD_BUDGET = 1800;
const WPM = 200;
const MAX_TOP_PER_DOMAIN = 2;

export interface DomainInput {
  section: BriefSection;
  ranked: RankedPaper[]; // everything scored for this domain, with totals and relevance
  stale: boolean; // arXiv failed for this domain and we fell back to HF only
  papersSeen: number;
  papersScored: number;
}

const wc = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);

export function cardWords(c: BriefCard): number {
  return [c.title, c.whyItMatters, c.summary, c.clientAngle, c.caveats, c.confidence, c.evidenceQuote, c.authors]
    .map(wc)
    .reduce((a, b) => a + b, 0);
}

export function briefWords(b: Pick<Brief, "topThree" | "sections">): number {
  const top = b.topThree.reduce((n, c) => n + cardWords(c) + wc(c.domain), 0);
  const secs = b.sections.reduce(
    (n, s) => n + wc(s.domainName) + wc(s.note ?? "") + wc(s.takeaway ?? "") + s.cards.reduce((m, c) => m + cardWords(c), 0),
    0,
  );
  return top + secs;
}

/** A paper can match several domains. Keep it once, in the domain where the judge found it most relevant. */
function dedupeAcrossDomains(inputs: DomainInput[]): number {
  const best = new Map<string, { idx: number; relevance: number; total: number }>();
  inputs.forEach((inp, idx) => {
    for (const c of inp.section.cards) {
      const r = inp.ranked.find((x) => x.paper.id === c.arxivId);
      const rel = r?.score.relevance ?? 0;
      const total = r?.total ?? 0;
      const cur = best.get(c.arxivId);
      if (!cur || rel > cur.relevance || (rel === cur.relevance && total > cur.total)) {
        best.set(c.arxivId, { idx, relevance: rel, total });
      }
    }
  });
  let removed = 0;
  inputs.forEach((inp, idx) => {
    const before = inp.section.cards.length;
    inp.section.cards = inp.section.cards.filter((c) => best.get(c.arxivId)?.idx === idx);
    removed += before - inp.section.cards.length;
  });
  return removed;
}

function pickTopThree(inputs: DomainInput[]): BriefCard[] {
  const cands = inputs.flatMap((inp) =>
    inp.section.status !== "ok"
      ? [] // degraded cards were never ranked for significance, so they cannot be "top"
      : inp.section.cards.map((c) => ({
          card: { ...c, domain: inp.section.domainName },
          total: inp.ranked.find((r) => r.paper.id === c.arxivId)?.total ?? 0,
          domainId: inp.section.domainId,
        })),
  );
  cands.sort((a, b) => b.total - a.total);
  const perDomain = new Map<string, number>();
  const out: BriefCard[] = [];
  for (const c of cands) {
    if (out.length === 3) break;
    if ((perDomain.get(c.domainId) ?? 0) >= MAX_TOP_PER_DOMAIN) continue;
    perDomain.set(c.domainId, (perDomain.get(c.domainId) ?? 0) + 1);
    out.push(c.card);
  }
  return out;
}

/**
 * Trims the least valuable material first until the brief fits the budget:
 * evidence quotes -> cards beyond 3 per domain -> beyond 2 -> client angles -> beyond 1 -> top-three quotes.
 * A domain header and the top three are never dropped. Returns how many cards were removed.
 */
function enforceBudget(brief: Pick<Brief, "topThree" | "sections">, totals: Map<string, number>, budget: number): number {
  let dropped = 0;
  const fits = () => briefWords(brief) <= budget;

  const dropBeyond = (keep: number) => {
    while (!fits()) {
      // find the lowest-ranked card among sections that still exceed `keep`
      let worst: { s: BriefSection; i: number; total: number } | null = null;
      for (const s of brief.sections) {
        if (s.cards.length <= keep) continue;
        s.cards.forEach((c, i) => {
          const t = totals.get(c.arxivId) ?? 0;
          if (!worst || t < worst.total) worst = { s, i, total: t };
        });
      }
      if (!worst) return;
      const w = worst as { s: BriefSection; i: number; total: number };
      w.s.cards.splice(w.i, 1);
      dropped++;
    }
  };

  const strip = (field: "evidenceQuote" | "clientAngle", cards: BriefCard[]) => {
    for (const c of cards) {
      if (fits()) return;
      c[field] = "";
    }
  };
  const nonTop = () => brief.sections.flatMap((s) => s.cards);

  strip("evidenceQuote", nonTop());
  dropBeyond(3);
  dropBeyond(2);
  strip("clientAngle", nonTop());
  dropBeyond(1);
  strip("evidenceQuote", brief.topThree);
  return dropped;
}

/**
 * Assembles the weekly brief from per-domain sections. Deterministic: no LLM. Handles duplicates,
 * the cross-domain top three, the word budget, and honest flags for partial, stale or degraded data.
 */
export function composeBrief(
  inputs: DomainInput[],
  win: WeekWindow,
  opts: { missingDomains?: string[]; now?: Date; budget?: number; coverageStart?: string } = {},
): Brief {
  // work on copies so callers keep their original sections
  const work: DomainInput[] = inputs.map((i) => ({ ...i, section: { ...i.section, cards: i.section.cards.map((c) => ({ ...c })), featured: [] } }));

  const duplicatesRemoved = dedupeAcrossDomains(work);
  const topThree = pickTopThree(work);
  const topIds = new Set(topThree.map((c) => c.arxivId));

  const totals = new Map<string, number>();
  for (const inp of work) for (const r of inp.ranked) totals.set(r.paper.id, Math.max(totals.get(r.paper.id) ?? 0, r.total));

  for (const inp of work) {
    inp.section.featured = inp.section.cards.filter((c) => topIds.has(c.arxivId)).map((c) => c.arxivId);
    inp.section.cards = inp.section.cards.filter((c) => !topIds.has(c.arxivId));
  }

  const draft = { topThree, sections: work.map((i) => i.section) };
  const droppedForBudget = enforceBudget(draft, totals, opts.budget ?? WORD_BUDGET);
  const wordCount = briefWords(draft);

  const missing = opts.missingDomains ?? [];
  const degraded = work.filter((i) => i.section.status === "degraded").map((i) => i.section.domainName);
  const now = opts.now ?? new Date();

  return {
    week: win.week,
    windowStart: win.start.toISOString(),
    windowEnd: win.end.toISOString(),
    generatedAt: now.toISOString(),
    isSample: false,
    isPartial: missing.length > 0,
    isStale: work.some((i) => i.stale),
    topThree: draft.topThree,
    sections: draft.sections,
    meta: {
      wordCount,
      readingMinutes: Math.max(1, Math.ceil(wordCount / WPM)),
      papersSeen: work.reduce((n, i) => n + i.papersSeen, 0),
      papersScored: work.reduce((n, i) => n + i.papersScored, 0),
      droppedForBudget,
      duplicatesRemoved,
      domainsDegraded: degraded,
      domainsMissing: missing,
      coverageStart: opts.coverageStart,
    },
  };
}
