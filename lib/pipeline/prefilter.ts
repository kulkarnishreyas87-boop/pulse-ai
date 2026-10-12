import type { Domain, Paper } from "../schema";

export interface ScoredPaper extends Paper {
  prefilter: {
    lexical: number;
    attention: number;
    category: number;
    /** Percentile (0..1) of this paper's similarity to the domain description, among this week's papers. */
    semantic?: number;
    total: number;
    hits: string[];
  };
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
    // prefer the arXiv record (has categories), but keep any HF signal and similarity
    const base = prev.source === "arxiv" ? prev : p.source === "arxiv" ? p : prev;
    byId.set(p.id, { ...base, hf: prev.hf ?? p.hf, sim: prev.sim ?? p.sim });
  }
  return [...byId.values()];
}

/** A paper with no domain keywords qualifies on meaning alone only if it is this similar (top 3%). */
export const SEMANTIC_ONLY_PERCENTILE = 0.97;

/**
 * Cheap, explainable shortlisting, no generative model. A paper qualifies if it uses the domain's
 * keywords OR its meaning is among the closest to the domain's description (Gemini embeddings, computed
 * earlier). Its score combines keyword relevance, semantic closeness, a capped attention boost from
 * Hugging Face and a small category bonus; every component is returned so the brief can say why a paper
 * was shortlisted. Without similarity data it falls back to keywords alone.
 *
 * Recall nets: some slots are reserved for the most community-attended matching papers, and some for
 * the most semantically similar papers that use none of the keywords, so neither kind is crowded out
 * by papers that simply repeat a buzzword.
 */
export function prefilter(papers: Paper[], domain: Domain, topN = 25): ScoredPaper[] {
  const kw = domain.keywords.map((k) => ({ k, re: phraseRegex(k) }));
  const ex = domain.excludeKeywords.map((k) => ({ k, re: phraseRegex(k) }));

  // semantic percentile of each paper among this week's papers that have a similarity
  const sims = papers.filter((p) => typeof p.sim === "number").map((p) => p.sim!).sort((a, b) => a - b);
  const percentile = (s: number) => {
    let lo = 0, hi = sims.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sims[mid] <= s) lo = mid + 1;
      else hi = mid;
    }
    return sims.length > 1 ? (lo - 1) / (sims.length - 1) : 1;
  };

  const scored: ScoredPaper[] = [];
  for (const p of papers) {
    const title = norm(p.title);
    const abs = norm(p.abstract);
    let lexical = 0;
    let excluded = false;
    const hits: string[] = [];
    for (const { k, re } of kw) {
      const inTitle = countMatches(title, re) > 0;
      const inAbs = Math.min(countMatches(abs, re), 2);
      if (inTitle || inAbs) hits.push(k);
      lexical += (inTitle ? 3 : 0) + inAbs;
    }
    for (const { re } of ex) {
      if (countMatches(title, re) + countMatches(abs, re) > 0) {
        lexical -= 3;
        excluded = true;
      }
    }
    const semantic = typeof p.sim === "number" ? percentile(p.sim) : undefined;
    const lexicalOk = lexical > 0;
    const semanticOk = semantic !== undefined && semantic >= SEMANTIC_ONLY_PERCENTILE && !excluded;
    if (!lexicalOk && !semanticOk) continue;

    const up = p.hf?.upvotes ?? 0;
    const attention = Math.min(1, Math.log1p(up) / Math.log1p(100)) * 2 + (p.hf?.githubRepo ? 0.3 : 0);
    const category = domain.arxivCats.includes(p.primaryCategory) ? 0.5 : 0;
    const semBonus = semantic === undefined ? 0 : 6 * Math.min(1, Math.max(0, (semantic - 0.8) / 0.2));
    const total = 0.6 * Math.min(Math.max(lexical, 0), 8) + semBonus + attention + category;
    scored.push({ ...p, prefilter: { lexical, attention, category, semantic, total, hits } });
  }

  scored.sort((a, b) => b.prefilter.total - a.prefilter.total || b.published.localeCompare(a.published));

  const attentionReserve = Math.min(Math.floor(topN / 5), 5);
  const semanticReserve = sims.length ? Math.min(Math.floor(topN / 8), 3) : 0;
  const head = scored.slice(0, Math.max(0, topN - attentionReserve - semanticReserve));
  const chosen = new Set(head.map((p) => p.id));
  const take = (list: ScoredPaper[], n: number) => {
    const out: ScoredPaper[] = [];
    for (const p of list) {
      if (out.length >= n) break;
      if (!chosen.has(p.id)) {
        out.push(p);
        chosen.add(p.id);
      }
    }
    return out;
  };
  const byAttention = take([...scored].filter((p) => p.prefilter.attention > 0).sort((a, b) => b.prefilter.attention - a.prefilter.attention), attentionReserve);
  const bySemanticOnly = take(
    [...scored].filter((p) => p.prefilter.lexical <= 0 && p.prefilter.semantic !== undefined).sort((a, b) => (b.prefilter.semantic ?? 0) - (a.prefilter.semantic ?? 0)),
    semanticReserve,
  );
  const out = [...head, ...byAttention, ...bySemanticOnly];
  // fill any unused reserved slots with the next-best by total
  for (const p of scored) {
    if (out.length >= topN) break;
    if (!chosen.has(p.id)) {
      out.push(p);
      chosen.add(p.id);
    }
  }
  return out.sort((a, b) => b.prefilter.total - a.prefilter.total);
}
