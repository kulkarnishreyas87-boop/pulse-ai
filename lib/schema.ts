import { z } from "zod";

export const HfSignal = z.object({
  upvotes: z.number().default(0),
  comments: z.number().default(0),
  githubRepo: z.string().nullable().default(null),
  githubStars: z.number().default(0),
});
export type HfSignal = z.infer<typeof HfSignal>;

/** A candidate paper, normalised from arXiv (and optionally enriched from Hugging Face). */
export const Paper = z.object({
  id: z.string(), // arXiv id without version, e.g. 2510.15974
  title: z.string(),
  abstract: z.string(),
  authors: z.array(z.string()),
  published: z.string(),
  primaryCategory: z.string(),
  categories: z.array(z.string()),
  url: z.string(),
  source: z.enum(["arxiv", "hf"]),
  hf: HfSignal.optional(),
});
export type Paper = z.infer<typeof Paper>;

/** Rubric output for one paper. All 1 to 5. Combined with attention in code (lib/pipeline/rank.ts). */
export const PaperScore = z.object({
  id: z.string(),
  relevance: z.coerce.number().int().min(1).max(5),
  evidence_quality: z.coerce.number().int().min(1).max(5),
  introduces_benchmark: z.boolean(), // a NEW benchmark, dataset or evaluation protocol
  surprising_result: z.coerce.number().int().min(1).max(5),
  reframing: z.coerce.number().int().min(1).max(5),
  hype_risk: z.coerce.number().int().min(1).max(5),
  has_benchmark: z.boolean(),
  claim_scope: z.enum(["narrow", "broad"]),
  rationale: z.string(),
});
export type PaperScore = z.infer<typeof PaperScore>;
export const ScoreBatch = z.object({ scores: z.array(PaperScore) });

export const Verdict = z.enum(["read", "skim", "client_flag"]);
export type Verdict = z.infer<typeof Verdict>;

export const Domain = z.object({
  id: z.string().min(1),
  name: z.string().min(2).max(80),
  arxivCats: z.array(z.string()).max(8).default([]),
  keywords: z.array(z.string()).max(12).default([]),
  excludeKeywords: z.array(z.string()).max(12).default([]),
  intentNote: z.string().max(400).default(""),
  maxPapers: z.number().int().min(1).max(6).default(4),
  active: z.boolean().default(true),
});
export type Domain = z.infer<typeof Domain>;

export const BriefCard = z.object({
  arxivId: z.string(),
  title: z.string(),
  authors: z.string(),
  url: z.string(),
  whyItMatters: z.string(),
  summary: z.string(),
  verdict: Verdict,
  clientAngle: z.string(),
  caveats: z.string(),
  confidence: z.string(), // e.g. "Preprint, not peer reviewed"
  evidenceQuote: z.string().default(""), // verbatim from the abstract, checked in code
  signals: z.array(z.string()).default([]), // "New benchmark", "Surprising result", "Reframes the problem" (from the scores, in code)
  domain: z.string().default(""), // set on top-three cards so the reader sees where each came from
});
export type BriefCard = z.infer<typeof BriefCard>;

/** Writer output (before verification). */
export const WrittenCard = z.object({
  id: z.string(),
  whyItMatters: z.string(),
  summary: z.string(),
  verdict: Verdict,
  clientAngle: z.string(),
  caveats: z.string(),
  evidenceQuote: z.string(),
});
export type WrittenCard = z.infer<typeof WrittenCard>;
export const WriteBatch = z.object({ cards: z.array(WrittenCard) });

export const VerifyBatch = z.object({
  results: z.array(
    z.object({
      id: z.string(),
      summary_supported: z.boolean(),
      why_supported: z.boolean(),
      angle_ok: z.boolean(),
      issue: z.string().default(""),
    }),
  ),
});

export const BriefSection = z.object({
  domainId: z.string(),
  domainName: z.string(),
  status: z.enum(["ok", "quiet", "degraded"]),
  note: z.string().optional(),
  featured: z.array(z.string()).default([]), // arXiv ids shown in the top three, not repeated here
  takeaway: z.string().optional(), // "what this week shows" for the domain, checked in code (lib/pipeline/synthesize.ts)
  takeawayIds: z.array(z.string()).optional(), // the papers the takeaway is based on
  cards: z.array(BriefCard),
});
export type BriefSection = z.infer<typeof BriefSection>;

export const Brief = z.object({
  week: z.string(), // ISO week id, e.g. 2026-W41
  windowStart: z.string(), // ISO, UTC
  windowEnd: z.string(),
  generatedAt: z.string(),
  isSample: z.boolean().default(false),
  isPartial: z.boolean().default(false),
  isStale: z.boolean().default(false),
  topThree: z.array(BriefCard).max(3),
  sections: z.array(BriefSection),
  meta: z
    .object({
      wordCount: z.number().optional(),
      papersSeen: z.number().optional(),
      papersScored: z.number().optional(),
      readingMinutes: z.number().optional(),
      droppedForBudget: z.number().optional(),
      duplicatesRemoved: z.number().optional(),
      domainsDegraded: z.array(z.string()).optional(),
      domainsMissing: z.array(z.string()).optional(),
      coverageStart: z.string().optional(), // earliest submission date fetched (the lookback), see lib/coverage.ts
    })
    .default({}),
});
export type Brief = z.infer<typeof Brief>;
