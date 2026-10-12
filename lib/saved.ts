import type { BriefCard } from "./schema";

/**
 * Saved articles. There are no user accounts, so the list lives in the reader's own browser (localStorage):
 * private to them, and on that device only. Every read and write tolerates storage being blocked or full.
 */
export const SAVED_KEY = "rp:saved:v1";
export const SAVED_EVENT = "rp:saved-change";
export const MAX_SAVED = 200;

export interface SavedArticle {
  arxivId: string;
  title: string;
  url: string;
  whyItMatters: string;
  authors: string;
  verdict: BriefCard["verdict"];
  signals: string[];
  week: string;
  domainId: string;
  domainName: string;
  savedAt: string;
}

export interface SaveContext {
  week: string;
  domainId: string;
  domainName: string;
}

export function toSaved(c: BriefCard, ctx: SaveContext, now = new Date()): SavedArticle {
  return {
    arxivId: c.arxivId,
    title: c.title,
    url: c.url,
    whyItMatters: c.whyItMatters,
    authors: c.authors,
    verdict: c.verdict,
    signals: c.signals,
    week: ctx.week,
    domainId: ctx.domainId,
    domainName: ctx.domainName,
    savedAt: now.toISOString(),
  };
}

/** Pure: parses whatever is stored, dropping anything malformed instead of failing. */
export function parseSaved(raw: string | null): SavedArticle[] {
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list.filter((a) => a && typeof a.arxivId === "string" && typeof a.title === "string" && typeof a.url === "string" && /^https:\/\//.test(a.url));
  } catch {
    return [];
  }
}

/** Pure: adds (newest first, no duplicates, bounded) or removes an article. */
export function toggleSaved(list: SavedArticle[], article: SavedArticle): SavedArticle[] {
  if (list.some((a) => a.arxivId === article.arxivId)) return list.filter((a) => a.arxivId !== article.arxivId);
  return [article, ...list].slice(0, MAX_SAVED);
}

export function readSaved(): SavedArticle[] {
  try {
    return parseSaved(window.localStorage.getItem(SAVED_KEY));
  } catch {
    return [];
  }
}

/** Returns false if the browser refused to store it (private mode, storage blocked or full). */
export function writeSaved(list: SavedArticle[]): boolean {
  try {
    window.localStorage.setItem(SAVED_KEY, JSON.stringify(list));
    window.dispatchEvent(new Event(SAVED_EVENT));
    return true;
  } catch {
    return false;
  }
}
