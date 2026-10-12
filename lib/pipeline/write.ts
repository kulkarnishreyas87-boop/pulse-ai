import type { BriefCard, Domain, Paper, WrittenCard } from "../schema";
import { VerifyBatch, WriteBatch } from "../schema";
import type { JsonLlm } from "../ai/gemini";
import { VERIFY_SYSTEM, WRITE_SYSTEM, verifyPrompt, writePrompt } from "../ai/prompts";
import { effectiveHype, signalTags, type RankedPaper } from "./rank";

const normQuote = (s: string) =>
  s.toLowerCase().replace(/[‘’“”"']/g, "").replace(/\s+/g, " ").trim();

/** Deterministic hallucination guard: the quoted evidence must literally appear in the abstract. */
export function quoteIsVerbatim(quote: string, abstract: string): boolean {
  const q = normQuote(quote);
  return q.length >= 20 && normQuote(abstract).includes(q);
}

const numbersIn = (t: string) =>
  (t.replace(/,/g, "").match(/\d+(?:\.\d+)?/g) ?? []).map((n) => n.replace(/\.0+$/, ""));

/**
 * Deterministic second layer behind the LLM verifier: every number in generated text must literally
 * appear in the abstract. Catches invented or "computed" figures that a fact-check pass can wave through.
 */
export function numbersSupported(text: string, abstract: string): boolean {
  const a = abstract.replace(/,/g, "");
  return numbersIn(text).every((n) => new RegExp(`(^|[^\\d.])${n.replace(".", "\\.")}(?![\\d])`).test(a));
}

/** Extractive fallback: first two sentences of the abstract. Cannot hallucinate. */
export function extractiveSummary(abstract: string): string {
  const sentences = abstract.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [abstract];
  return sentences.slice(0, 2).join("").trim().slice(0, 500);
}

export function confidenceLabel(p: RankedPaper["paper"]): string {
  const parts = ["Preprint, not peer reviewed"];
  if (p.hf && p.hf.upvotes > 0) parts.push(`${p.hf.upvotes} community upvotes`);
  if (p.hf?.githubRepo) parts.push("code released");
  return parts.join(" · ");
}

function toCard(r: RankedPaper, w: Partial<WrittenCard>): BriefCard {
  const p = r.paper;
  return {
    arxivId: p.id,
    title: p.title,
    authors: p.authors.slice(0, 3).join(", ") + (p.authors.length > 3 ? " et al." : ""),
    url: p.url,
    whyItMatters: w.whyItMatters ?? "",
    summary: w.summary || extractiveSummary(p.abstract),
    verdict: w.verdict ?? "skim",
    clientAngle: w.clientAngle ?? "",
    caveats: w.caveats ?? "",
    confidence: confidenceLabel(p),
    evidenceQuote: w.evidenceQuote ?? "",
    // unscored stand-ins (degraded domains) carry no real signals
    signals: r.score.rationale === "unscored" ? [] : signalTags(r.score),
    domain: "",
  };
}

/** Cards built without the writer, used when Gemini is unavailable. Extractive only. */
export function fallbackCards(ranked: RankedPaper[]): BriefCard[] {
  return ranked.map((r) => toCard(r, { caveats: "Not AI-summarised: showing the abstract opening.", verdict: "skim" }));
}

export interface WriteStats {
  quotesRejected: number;
  summariesRejected: number;
  whyRejected: number;
  anglesRejected: number;
  writerMissing: number;
  numbersRejected: number;
}

/** Stage 1 (one Gemini call): draft the cards. Kept separate so it can run as its own job. */
export async function writeDrafts(ranked: RankedPaper[], domain: Domain, llm: JsonLlm): Promise<WrittenCard[]> {
  if (!ranked.length) return [];
  const papers: Paper[] = ranked.map((r) => r.paper);
  const written = await llm({ system: WRITE_SYSTEM, prompt: writePrompt(domain, papers), schema: WriteBatch });
  const wanted = new Set(papers.map((p) => p.id));
  return written.cards.filter((c) => wanted.has(c.id)); // ignore invented ids
}

/** Writer then verifier in one go, for the CLI and tests. The job queue runs the two stages separately. */
export async function writeAndVerify(
  ranked: RankedPaper[],
  domain: Domain,
  llm: JsonLlm,
): Promise<{ cards: BriefCard[]; stats: WriteStats }> {
  return verifyAndBuild(ranked, await writeDrafts(ranked, domain, llm), llm);
}

/**
 * Stage 2 (one Gemini call plus deterministic checks). Anything the verifier or the quote and number
 * checks reject is removed, and a rejected summary falls back to the abstract's own opening sentences.
 * The card is never silently trusted.
 */
export async function verifyAndBuild(
  ranked: RankedPaper[],
  drafts: WrittenCard[],
  llm: JsonLlm,
): Promise<{ cards: BriefCard[]; stats: WriteStats }> {
  const stats: WriteStats = { quotesRejected: 0, summariesRejected: 0, whyRejected: 0, anglesRejected: 0, writerMissing: 0, numbersRejected: 0 };
  if (!ranked.length) return { cards: [], stats };

  const byId = new Map(drafts.map((c) => [c.id, c]));

  const items = ranked.flatMap((r) => {
    const card = byId.get(r.paper.id);
    if (!card) {
      stats.writerMissing++;
      return [];
    }
    return [{ paper: r.paper, card }];
  });

  // Verification failure must not publish unchecked text: treat everything as unsupported.
  let verdicts = new Map<string, { summary_supported: boolean; why_supported: boolean; angle_ok: boolean }>();
  try {
    if (!items.length) throw new Error("nothing to verify");
    const v = await llm({ system: VERIFY_SYSTEM, prompt: verifyPrompt(items), schema: VerifyBatch });
    verdicts = new Map(v.results.map((x) => [x.id, x]));
  } catch {
    /* leave empty: every claim below is treated as unverified */
  }

  const cards = ranked.map((r): BriefCard => {
    const w = byId.get(r.paper.id);
    if (!w) return toCard(r, { caveats: "Not AI-summarised: the writer returned nothing for this paper." });
    const v = verdicts.get(r.paper.id);
    const out: Partial<WrittenCard> = { ...w };

    if (!v?.summary_supported) {
      stats.summariesRejected++;
      out.summary = "";
    }
    if (!v?.why_supported) {
      stats.whyRejected++;
      out.whyItMatters = "";
    }
    if (!v?.angle_ok) {
      stats.anglesRejected++;
      out.clientAngle = "";
    }
    const ab = r.paper.abstract;
    if (out.summary && !numbersSupported(out.summary, ab)) {
      stats.numbersRejected++;
      out.summary = "";
    }
    if (out.whyItMatters && !numbersSupported(out.whyItMatters, ab)) {
      stats.numbersRejected++;
      out.whyItMatters = "";
    }
    if (out.clientAngle && !numbersSupported(out.clientAngle, ab)) {
      stats.numbersRejected++;
      out.clientAngle = "";
    }
    if (!quoteIsVerbatim(w.evidenceQuote, r.paper.abstract)) {
      stats.quotesRejected++;
      out.evidenceQuote = "";
      out.whyItMatters = ""; // a "why" we cannot anchor to the abstract is not published
    }
    // High hype risk should not be pushed to a client as a flag.
    if (out.verdict === "client_flag" && effectiveHype(r.score, `${r.paper.title} ${r.paper.abstract}`) >= 4) out.verdict = "skim";
    return toCard(r, out);
  });

  return { cards, stats };
}
