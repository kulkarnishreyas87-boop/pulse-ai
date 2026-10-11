import type { Domain, Paper } from "../schema";

export interface ScoredPaper extends Paper {
  prefilter: { lexical: number; attention: number; category: number; total: number; hits: string[] };
}

const norm = (s: string) => s.toLowerCase().replace(/[-_/]/g, " ").replace(/\s+/g, " ").trim();
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whole-phrase match on normalised text; allows a trailing plural "s". */
function phraseRegex(phrase: string): RegExp {
  return new RegExp(`\\b${esc(norm(phrase))}s?\\b`, "g");
}

function countMatches(text: string, re: RegExp): number {
  return (text.match(re) ?? []).length;
}

/** Collapse duplicates (v2, cross-lists, arXiv + HF copies) keeping the richest record. */
export function dedupe(papers: Paper[]): Paper[] {
  const byId = new Map<string, Paper>();
  for (const p of papers) {
    const prev = byId.get(p.id);
    if (!prev) {
      byId.set(p.id, p);
      continue;
    }
    // prefer the arXiv record (has categories), but keep any HF signal
    const base = prev.source === "arxiv" ? prev : p.source === "arxiv" ? p : prev;
    byId.set(p.id, { ...base, hf: prev.hf ?? p.hf });
  }
  return [...byId.values()];
}

/**
 * Cheap, explainable, no-LLM ranking. Lexical relevance to the domain's keywords, plus a capped
 * attention boost from Hugging Face, plus a small category bonus. Every component is returned so
 * the final brief can say why a paper was shortlisted.
 *
 * Limitation (deliberate for now): lexical only, so a paper using unfamiliar terminology can be
 * missed. Embedding similarity is the planned recall upgrade.
 */
export function prefilter(papers: Paper[], domain: Domain, topN = 25): ScoredPaper[] {
  const kw = domain.keywords.map((k) => ({ k, re: phraseRegex(k) }));
  const ex = domain.excludeKeywords.map((k) => ({ k, re: phraseRegex(k) }));
  const scored: ScoredPaper[] = [];

  for (const p of papers) {
    const title = norm(p.title);
    const abs = norm(p.abstract);
    let lexical = 0;
    const hits: string[] = [];
    for (const { k, re } of kw) {
      const inTitle = countMatches(title, re) > 0;
      const inAbs = Math.min(countMatches(abs, re), 2);
      if (inTitle || inAbs) hits.push(k);
      lexical += (inTitle ? 3 : 0) + inAbs;
    }
    for (const { re } of ex) {
      if (countMatches(title, re) + countMatches(abs, re) > 0) lexical -= 3;
    }
    if (lexical <= 0) continue;

    const up = p.hf?.upvotes ?? 0;
    const attention = Math.min(1, Math.log1p(up) / Math.log1p(100)) * 2 + (p.hf?.githubRepo ? 0.3 : 0);
    const category = domain.arxivCats.includes(p.primaryCategory) ? 0.5 : 0;
    scored.push({
      ...p,
      prefilter: { lexical, attention, category, total: lexical + attention + category, hits },
    });
  }

  scored.sort((a, b) => b.prefilter.total - a.prefilter.total || b.published.localeCompare(a.published));

  // Recall safety net: keyword density rewards papers that repeat a buzzword, not important ones.
  // So a few slots are reserved for the most community-attended papers that still match the domain.
  const reserve = Math.min(Math.floor(topN / 5), 5);
  const head = scored.slice(0, topN - reserve);
  const chosen = new Set(head.map((p) => p.id));
  const extras = scored
    .filter((p) => !chosen.has(p.id) && p.prefilter.attention > 0)
    .sort((a, b) => b.prefilter.attention - a.prefilter.attention)
    .slice(0, reserve);
  const out = [...head, ...extras];
  // fill any unused reserved slots with the next-best by total
  for (const p of scored) {
    if (out.length >= topN) break;
    if (!out.some((q) => q.id === p.id)) out.push(p);
  }
  return out.sort((a, b) => b.prefilter.total - a.prefilter.total);
}
