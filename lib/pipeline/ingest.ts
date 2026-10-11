import type { Domain, Paper } from "../schema";
import type { WeekWindow } from "../week";
import { fetchArxiv } from "../sources/arxiv";
import { fetchHf } from "../sources/hf";
import { dedupe, prefilter, type ScoredPaper } from "./prefilter";

export interface IngestResult {
  domainId: string;
  week: string;
  shortlist: ScoredPaper[];
  stats: {
    arxivTotal: number; // matches arXiv reports for the query
    arxivFetched: number;
    arxivTruncated: boolean;
    arxivError: string | null;
    hfOk: boolean;
    hfOnlyMatched: number; // HF papers the arXiv query missed (e.g. other categories) that still match the keywords
    afterDedupe: number;
    shortlisted: number;
  };
  query: string;
  stale: boolean; // true when arXiv failed and results rest on HF alone
}

/**
 * Ingest + prefilter for one domain and one week. No LLM involved.
 * arXiv is the core source: if it fails but HF works we continue and flag the result as stale.
 * If both fail we throw, so the job can retry instead of silently producing an empty brief.
 */
export async function runIngest(
  domain: Domain,
  win: WeekWindow,
  opts: { topN?: number; maxCandidates?: number } = {},
): Promise<IngestResult> {
  const [arxivR, hf] = await Promise.all([
    fetchArxiv(domain, win, opts.maxCandidates).then(
      (r) => ({ ok: true as const, r }),
      (e) => ({ ok: false as const, error: String(e) }),
    ),
    fetchHf(win),
  ]);

  if (!arxivR.ok && !hf.ok) throw new Error(`Both sources failed. arXiv: ${arxivR.error}`);

  const arxivPapers: Paper[] = arxivR.ok ? arxivR.r.papers : [];
  const arxivIds = new Set(arxivPapers.map((p) => p.id));
  const withSignal = arxivPapers.map((p) => ({ ...p, hf: hf.signals.get(p.id) }));
  const hfOnly = hf.papers.filter((p) => !arxivIds.has(p.id));

  const merged = dedupe([...withSignal, ...hfOnly]);
  const shortlist = prefilter(merged, domain, opts.topN ?? 25);

  return {
    domainId: domain.id,
    week: win.week,
    shortlist,
    query: arxivR.ok ? arxivR.r.query : "",
    stale: !arxivR.ok,
    stats: {
      arxivTotal: arxivR.ok ? arxivR.r.total : 0,
      arxivFetched: arxivPapers.length,
      arxivTruncated: arxivR.ok ? arxivR.r.truncated : false,
      arxivError: arxivR.ok ? null : arxivR.error,
      hfOk: hf.ok,
      hfOnlyMatched: prefilter(hfOnly, domain, Infinity).length,
      afterDedupe: merged.length,
      shortlisted: shortlist.length,
    },
  };
}
