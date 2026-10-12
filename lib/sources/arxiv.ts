import { XMLParser } from "fast-xml-parser";
import type { Domain, Paper } from "../schema";
import { arxivStamp, type WeekWindow } from "../week";

const ENDPOINT = "https://export.arxiv.org/api/query";
const UA = "pulse-ai/0.1 (weekly research brief; student project)";
/** arXiv asks for at most one request every 3 seconds. Mutable only so tests can run without real waiting. */
export const arxivTuning = { minGapMs: 3100, backoffMs: 2000, requestTimeoutMs: 40_000, retryWindowMs: 30_000 };
const PAGE = 200;

let lastRequestAt = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  isArray: (name) => ["entry", "author", "category", "link"].includes(name),
});

const clean = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();

/** Builds: (cat:A OR cat:B) AND (all:"kw1" OR all:"kw2") AND submittedDate:[start TO end] */
export function buildQuery(domain: Domain, win: WeekWindow): string {
  const parts: string[] = [];
  if (domain.arxivCats.length) parts.push("(" + domain.arxivCats.map((c) => `cat:${c}`).join(" OR ") + ")");
  if (domain.keywords.length) {
    parts.push("(" + domain.keywords.map((k) => `all:"${k.replace(/"/g, "")}"`).join(" OR ") + ")");
  }
  parts.push(`submittedDate:[${arxivStamp(win.start)} TO ${arxivStamp(win.end)}]`);
  return parts.join(" AND ");
}

/** Pure: turns an arXiv Atom response into normalised papers. */
export function parseAtom(xml: string): { papers: Paper[]; total: number } {
  const feed = parser.parse(xml)?.feed;
  if (!feed) throw new Error("arXiv response had no <feed>");
  const total = Number(feed["opensearch:totalResults"] ?? 0);
  const entries: any[] = feed.entry ?? [];
  const papers: Paper[] = [];
  for (const e of entries) {
    const rawId = clean(e.id);
    const m = /\/abs\/(.+?)(v\d+)?$/.exec(rawId);
    if (!m) continue;
    const cats: string[] = (e.category ?? []).map((c: any) => c["@_term"]).filter(Boolean);
    papers.push({
      id: m[1],
      title: clean(e.title),
      abstract: clean(e.summary),
      authors: (e.author ?? []).map((a: any) => clean(a.name)).filter(Boolean),
      published: clean(e.published),
      primaryCategory: e["arxiv:primary_category"]?.["@_term"] ?? cats[0] ?? "",
      categories: cats,
      url: `https://arxiv.org/abs/${m[1]}`,
      source: "arxiv",
    });
  }
  return { papers, total };
}

async function fetchPage(query: string, start: number): Promise<string> {
  const url = `${ENDPOINT}?search_query=${encodeURIComponent(query)}&start=${start}&max_results=${PAGE}&sortBy=submittedDate&sortOrder=descending`;
  let lastErr: unknown;
  const started = Date.now();
  for (let attempt = 0; attempt < 4; attempt++) {
    const wait = lastRequestAt + arxivTuning.minGapMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(arxivTuning.requestTimeoutMs) });
      if (res.ok) return await res.text();
      lastErr = new Error(`arXiv HTTP ${res.status}`);
      if (res.status !== 429 && res.status < 500) break; // not retryable
      if (res.status === 429) {
        // Rate limited: quick retries only extend the block. Honour Retry-After, else wait at least 5x the normal backoff,
        // and hold every later request in this process back by the same amount.
        const retryAfter = Number(res.headers.get("retry-after")) * 1000 || 0;
        const pause = Math.max(retryAfter, arxivTuning.backoffMs * 5 * 2 ** attempt);
        lastRequestAt = Date.now() + pause - arxivTuning.minGapMs;
        if (Date.now() + pause - started > arxivTuning.retryWindowMs) break; // leave it to the job queue's retry
        continue;
      }
    } catch (e) {
      lastErr = e;
    }
    // A slow arXiv can eat the whole step: leave further retries to the job queue (it retries the job later).
    if (Date.now() - started > arxivTuning.retryWindowMs) break;
    await sleep(arxivTuning.backoffMs * 2 ** attempt);
  }
  throw new Error(`arXiv request failed: ${String(lastErr)}`);
}

export interface ArxivResult {
  papers: Paper[];
  total: number; // how many arXiv says match
  truncated: boolean; // true if we stopped at maxCandidates
  query: string;
}

/** Pages through one query until `cap` papers or the end. `first` lets the caller reuse page 0. */
async function collect(query: string, cap: number, first?: { papers: Paper[]; total: number }) {
  const papers: Paper[] = [];
  let total = 0;
  for (let start = 0; start < cap; start += PAGE) {
    const { papers: page, total: t } =
      start === 0 && first ? first : parseAtom(await fetchPage(query, start));
    total = t;
    papers.push(...page);
    if (papers.length >= total || page.length < PAGE) break;
  }
  return { papers, total, truncated: papers.length < total };
}

/** One calendar day (UTC) of a week. The job queue fetches a week as seven of these, one job each. */
export async function fetchArxivDay(domain: Domain, win: WeekWindow, dayIndex: number, cap = 400) {
  const start = new Date(win.start.getTime() + dayIndex * 86_400_000);
  const end = new Date(Math.min(start.getTime() + 86_400_000 - 1000, win.end.getTime()));
  const query = buildQuery(domain, { week: win.week, start, end });
  const r = await collect(query, cap);
  return { ...r, query };
}

/**
 * Fetches a week of matches. Results are newest-first, so a plain cap would silently drop the
 * start of the week on busy domains. If the total exceeds the cap we therefore re-query one day
 * at a time, which keeps every day represented.
 */
export async function fetchArxiv(domain: Domain, win: WeekWindow, maxCandidates = 600): Promise<ArxivResult> {
  const query = buildQuery(domain, win);
  const first = parseAtom(await fetchPage(query, 0));
  if (first.total <= maxCandidates) {
    const r = await collect(query, maxCandidates, first);
    return { ...r, query };
  }

  const byId = new Map<string, Paper>();
  let truncated = false;
  for (let i = 0; i < 7; i++) {
    const start = new Date(win.start.getTime() + i * 86_400_000);
    const end = new Date(Math.min(start.getTime() + 86_400_000 - 1000, win.end.getTime()));
    const dayQuery = buildQuery(domain, { week: win.week, start, end });
    const r = await collect(dayQuery, 400);
    truncated ||= r.truncated;
    for (const p of r.papers) byId.set(p.id, p);
  }
  return { papers: [...byId.values()], total: first.total, truncated, query: `${query}  [split into 7 daily queries]` };
}
