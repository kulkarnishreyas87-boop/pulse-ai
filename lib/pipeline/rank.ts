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
  benchmarkSignal: 4, // a new benchmark backed by solid evidence (evidence 4+) counts like a clearly notable finding
  weakBenchmarkSignal: 3, // ...one with thin evidence is only moderately notable (stops benchmark papers being over-rewarded)
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
  const bench = s.introduces_benchmark ? (s.evidence_quality >= 4 ? RANK.benchmarkSignal : RANK.weakBenchmarkSignal) : 1;
  return Math.max(s.surprising_result, s.reframing, bench);
}

/*
 * Hype check in code, alongside the model's own hype_risk. On real abstracts the model almost always
 * answered 1, so promotional wording in the abstract is counted directly. Strong phrases count double.
 */
const STRONG_HYPE = /\b(unprecedented|revolutionar(y|ize|izes)|groundbreaking|game[- ]chang(er|ing)|paradigm shift|breakthrough|human[- ]level|superhuman|agi\b|first[- ]ever|unparalleled|solves? (the|this|all)|outperforms? all|beats? all|state[- ]of[- ]the[- ]art (on|across) (all|every))/gi;
const MILD_HYPE = /\b(state[- ]of[- ]the[- ]art|dramatically|remarkabl[ey]|substantially outperform|significantly outperform|novel paradigm|transformative)\b/gi;

export function lexicalHype(text: string): number {
  const points = 2 * (text.match(STRONG_HYPE)?.length ?? 0) + (text.match(MILD_HYPE)?.length ?? 0);
  return points === 0 ? 1 : points === 1 ? 2 : points <= 3 ? 3 : points <= 5 ? 4 : 5;
}

/** The hype used for ranking: the stronger of the model's judgement and the wording check. */
export function effectiveHype(s: PaperScore, text = ""): number {
  return Math.max(s.hype_risk, text ? lexicalHype(text) : 1);
}

/** Labels shown on the card, so the reader sees WHY a paper is here in the problem statement's own terms. */
export function signalTags(s: PaperScore): string[] {
  const tags: string[] = [];
  if (s.introduces_benchmark) tags.push("New benchmark");
  if (s.surprising_result >= RANK.tagAt) tags.push("Surprising result");
  if (s.reframing >= RANK.tagAt) tags.push("Reframes the problem");
  return tags;
}

export function qualityScore(s: PaperScore, text = ""): number {
  const w = RANK.weights;
  return w.signal * signalScore(s) + w.evidence * s.evidence_quality + w.relevance * s.relevance - RANK.hypePenaltyPerPoint * (effectiveHype(s, text) - 1);
}

export function rankPapers(items: { paper: ScoredPaper; score: PaperScore }[]): RankedPaper[] {
  return items
    .map(({ paper, score }) => {
      const text = `${paper.title} ${paper.abstract}`;
      const quality = qualityScore(score, text);
      const hype = effectiveHype(score, text);
      const attention5 = Math.min(5, (paper.prefilter.attention / RANK.attentionMax) * 5);
      const total = quality + RANK.attentionBonusPerPoint * attention5;
      const passes = score.relevance >= RANK.minRelevance && quality >= RANK.minQuality;
      const tags = signalTags(score);
      const why = passes
        ? `quality ${quality.toFixed(2)} + attention ${(RANK.attentionBonusPerPoint * attention5).toFixed(2)} (signal ${signalScore(score)}${tags.length ? ` [${tags.join(", ")}]` : ""}, evidence ${score.evidence_quality}, relevance ${score.relevance}, hype ${hype})`
        : score.relevance < RANK.minRelevance
          ? `dropped: relevance ${score.relevance} < ${RANK.minRelevance}`
          : `dropped: quality ${quality.toFixed(2)} < ${RANK.minQuality} (signal ${signalScore(score)}, evidence ${score.evidence_quality}, relevance ${score.relevance})`;
      return { paper, score, quality, attention5, total, passes, why };
    })
    .sort((a, b) => b.total - a.total);
}
