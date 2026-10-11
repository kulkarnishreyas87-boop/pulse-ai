import type { BriefSection, Domain } from "../schema";
import type { JsonLlm } from "../ai/gemini";
import type { IngestResult } from "./ingest";
import type { ScoredPaper } from "./prefilter";
import { judgePapers, type ScoreCache } from "./judge";
import { rankPapers, type RankedPaper } from "./rank";
import { fallbackCards, writeAndVerify, type WriteStats } from "./write";
import { synthesizeSection } from "./synthesize";

export interface SectionStats {
  shortlisted: number;
  scored: number;
  unscored: number;
  cacheHits: number;
  passed: number;
  write?: WriteStats;
  degradedReason?: string;
}

export interface SectionResult {
  section: BriefSection;
  ranked: RankedPaper[]; // everything scored, with reasons, for the status page and eval
  stats: SectionStats;
}

const baseStats = (shortlisted: number): SectionStats => ({ shortlisted, scored: 0, unscored: 0, cacheHits: 0, passed: 0 });

/* Section builders shared by the CLI (buildSection) and the job handlers, so both degrade identically. */

export function quietSection(domain: Domain, note: string): BriefSection {
  return { domainId: domain.id, domainName: domain.name, featured: [], status: "quiet", note, cards: [] };
}

/** Unranked stand-ins for when scoring is impossible: keyword and attention order only, clearly labelled. */
function unscoredStandIns(shortlist: ScoredPaper[], n: number): RankedPaper[] {
  return shortlist.slice(0, n).map((paper) => ({
    paper,
    score: { id: paper.id, relevance: 3, evidence_quality: 3, introduces_benchmark: false, surprising_result: 1, reframing: 1, hype_risk: 3, has_benchmark: false, claim_scope: "narrow" as const, rationale: "unscored" },
    quality: 0,
    attention5: 0,
    total: 0,
    passes: true,
    why: "unscored (AI unavailable): ordered by keyword and attention only",
  }));
}

export function degradedScoringResult(domain: Domain, shortlist: ScoredPaper[], reason: string): SectionResult {
  const top = unscoredStandIns(shortlist, domain.maxPapers);
  return {
    section: {
      domainId: domain.id,
      domainName: domain.name,
      featured: [],
      status: "degraded",
      note: "AI scoring was unavailable. Showing the best keyword matches with the abstract's opening lines, not ranked for significance.",
      cards: fallbackCards(top),
    },
    ranked: top,
    stats: { ...baseStats(shortlist.length), unscored: shortlist.length, degradedReason: reason.slice(0, 200) },
  };
}

export function degradedWritingSection(domain: Domain, top: RankedPaper[]): BriefSection {
  return {
    domainId: domain.id,
    domainName: domain.name,
    featured: [],
    status: "degraded",
    note: "Summaries were unavailable. Showing the top-ranked papers with the abstract's opening lines.",
    cards: fallbackCards(top),
  };
}

export const noDataSection = (domain: Domain): BriefSection => ({
  domainId: domain.id,
  domainName: domain.name,
  featured: [],
  status: "degraded",
  note: "No data could be fetched for this domain this week. It will be retried next run.",
  cards: [],
});

/**
 * Score, rank, write and verify one domain in a single process (CLI and tests). Never throws on an AI
 * failure: it degrades instead, so a Gemini outage produces a brief with abstract excerpts rather than none.
 */
export async function buildSection(
  domain: Domain,
  ingest: IngestResult,
  deps: { llm: JsonLlm; cache?: ScoreCache; log?: (m: string) => void },
): Promise<SectionResult> {
  const log = deps.log ?? (() => {});
  const base = baseStats(ingest.shortlist.length);

  if (!ingest.shortlist.length) {
    return { section: quietSection(domain, "No papers matched this domain this week."), ranked: [], stats: base };
  }

  let judged;
  try {
    judged = await judgePapers(ingest.shortlist, domain, deps.llm, deps.cache, log);
  } catch (e) {
    return degradedScoringResult(domain, ingest.shortlist, String(e));
  }

  const ranked = rankPapers(
    ingest.shortlist.flatMap((paper) => {
      const score = judged.scores.get(paper.id);
      return score ? [{ paper, score }] : [];
    }),
  );
  const passed = ranked.filter((r) => r.passes);
  const stats = { ...base, scored: judged.scores.size, unscored: judged.unscored.length, cacheHits: judged.cacheHits, passed: passed.length };

  if (!passed.length) {
    return { section: quietSection(domain, "Nothing cleared the significance threshold this week."), ranked, stats };
  }

  const top = passed.slice(0, domain.maxPapers);
  try {
    const { cards, stats: write } = await writeAndVerify(top, domain, deps.llm);
    const section: BriefSection = { domainId: domain.id, domainName: domain.name, featured: [], status: "ok", cards };
    try {
      const s = await synthesizeSection(section, ranked, domain, deps.llm);
      if (s.takeaway) Object.assign(section, { takeaway: s.takeaway, takeawayIds: s.ids });
      else log(`  no takeaway: ${s.rejected}`);
    } catch (e) {
      log(`  takeaway failed: ${String(e).slice(0, 120)}`); // optional: never blocks the section
    }
    return { section, ranked, stats: { ...stats, write } };
  } catch (e) {
    return { section: degradedWritingSection(domain, top), ranked, stats: { ...stats, degradedReason: String(e).slice(0, 200) } };
  }
}
