import type { PaperScore } from "../schema";
import type { ScoredPaper } from "./prefilter";

/**
 * The final ranking is plain arithmetic, never an LLM opinion, so it is explainable and tunable.
 *
 * Significance follows the problem statement's own definition: a paper matters if it brings a new
 * benchmark, a surprising evaluation result, OR a reframing of the problem. Any one is enough, so the
 * strongest of the three counts (not their average). That signal is then combined with how well the
 * claims are evidenced and how relevant the paper is to the domain, minus a hype penalty.
 *
 * Two deliberate separations:
 *  - WHETHER a paper is significant depends on quality only. Community attention is not allowed to
 *    decide this: Hugging Face covers some domains far better than others.
 *  - ORDER among papers that pass adds a capped attention bonus.
 *
 * minQuality is provisional: calibrate it against the golden set (eval/) before trusting a quiet week.
 */
export const RANK = {
  weights: { signal: 0.4, evidence: 0.35, relevance: 0.25 },
  benchmarkSignal: 4, // introducing a reusable benchmark counts like a clearly notable finding
  hypePenaltyPerPoint: 0.25, // hype_risk 1 costs nothing; each point above costs this much
  attentionBonusPerPoint: 0.25, // attention is rescaled to 0..5, so the bonus is at most 1.25
  minQuality: 3.3,
  minRelevance: 3, // off-topic papers never surface, however well they score otherwise
  attentionMax: 2.3, // largest attention value the prefilter can produce (2 + 0.3 repo bonus)
  tagAt: 4, // a signal at or above this earns a visible tag on the card
};

export interface RankedPaper {
  paper: ScoredPaper;
  score: PaperScore;
  quality: number; // decides whether it passes
  attention5: number; // attention rescaled to 0..5
  total: number; // quality + attention bonus, used only for ordering
  passes: boolean;
  why: string; // human-readable reason, surfaced in logs and the status page
}

/** The strongest of the three named signals, on a 1..5 scale. */
export function signalScore(s: PaperScore): number {
  return Math.max(s.surprising_result, s.reframing, s.introduces_benchmark ? RANK.benchmarkSignal : 1);
}

/** Labels shown on the card, so the reader sees WHY a paper is here in the problem statement's own terms. */
export function signalTags(s: PaperScore): string[] {
  const tags: string[] = [];
  if (s.introduces_benchmark) tags.push("New benchmark");
  if (s.surprising_result >= RANK.tagAt) tags.push("Surprising result");
  if (s.reframing >= RANK.tagAt) tags.push("Reframes the problem");
  return tags;
}

export function qualityScore(s: PaperScore): number {
  const w = RANK.weights;
  return w.signal * signalScore(s) + w.evidence * s.evidence_quality + w.relevance * s.relevance - RANK.hypePenaltyPerPoint * (s.hype_risk - 1);
}

export function rankPapers(items: { paper: ScoredPaper; score: PaperScore }[]): RankedPaper[] {
  return items
    .map(({ paper, score }) => {
      const quality = qualityScore(score);
      const attention5 = Math.min(5, (paper.prefilter.attention / RANK.attentionMax) * 5);
      const total = quality + RANK.attentionBonusPerPoint * attention5;
      const passes = score.relevance >= RANK.minRelevance && quality >= RANK.minQuality;
      const tags = signalTags(score);
      const why = passes
        ? `quality ${quality.toFixed(2)} + attention ${(RANK.attentionBonusPerPoint * attention5).toFixed(2)} (signal ${signalScore(score)}${tags.length ? ` [${tags.join(", ")}]` : ""}, evidence ${score.evidence_quality}, relevance ${score.relevance}, hype ${score.hype_risk})`
        : score.relevance < RANK.minRelevance
          ? `dropped: relevance ${score.relevance} < ${RANK.minRelevance}`
          : `dropped: quality ${quality.toFixed(2)} < ${RANK.minQuality} (signal ${signalScore(score)}, evidence ${score.evidence_quality}, relevance ${score.relevance})`;
      return { paper, score, quality, attention5, total, passes, why };
    })
    .sort((a, b) => b.total - a.total);
}
