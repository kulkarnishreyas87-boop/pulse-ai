import type { Domain, Paper, PaperScore } from "../schema";
import { ScoreBatch } from "../schema";
import type { JsonLlm } from "../ai/gemini";
import { RUBRIC_VERSION, SCORE_SYSTEM, scorePrompt } from "../ai/prompts";

export interface ScoreCache {
  get(key: string): Promise<PaperScore | undefined>;
  set(key: string, score: PaperScore): Promise<void>;
}

export const BATCH_SIZE = 8;

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

/** A score depends on the domain focus, so the key includes it. Editing the intent note re-scores. */
export function scoreKey(domain: Domain, paperId: string): string {
  return `score:${RUBRIC_VERSION}:${domain.id}:${hash(domain.intentNote)}:${paperId}`;
}

export interface JudgeResult {
  scores: Map<string, PaperScore>;
  cacheHits: number;
  unscored: string[]; // ids the model did not return, even after one retry
  failedBatches: number;
}

async function scoreBatch(llm: JsonLlm, domain: Domain, batch: Paper[]): Promise<PaperScore[]> {
  const out = await llm({ system: SCORE_SYSTEM, prompt: scorePrompt(domain, batch), schema: ScoreBatch });
  const wanted = new Set(batch.map((p) => p.id));
  return out.scores.filter((s) => wanted.has(s.id)); // ignore invented ids
}

/**
 * Scores papers with the rubric, 8 per call. Cached per (rubric version, domain focus, paper), so a
 * paper is never scored twice. A batch that fails is skipped and counted, not fatal: only if nothing
 * at all could be scored does the caller degrade the domain.
 */
export async function judgePapers(
  papers: Paper[],
  domain: Domain,
  llm: JsonLlm,
  cache?: ScoreCache,
  log: (m: string) => void = () => {},
): Promise<JudgeResult> {
  const scores = new Map<string, PaperScore>();
  const todo: Paper[] = [];
  let cacheHits = 0;

  for (const p of papers) {
    const hit = await cache?.get(scoreKey(domain, p.id));
    if (hit) {
      scores.set(p.id, hit);
      cacheHits++;
    } else todo.push(p);
  }

  let failedBatches = 0;
  for (let i = 0; i < todo.length; i += BATCH_SIZE) {
    const batch = todo.slice(i, i + BATCH_SIZE);
    try {
      let got = await scoreBatch(llm, domain, batch);
      const missing = batch.filter((p) => !got.some((s) => s.id === p.id));
      if (missing.length) {
        log(`  retrying ${missing.length} paper(s) the model skipped`);
        got = got.concat(await scoreBatch(llm, domain, missing));
      }
      for (const s of got) {
        scores.set(s.id, s);
        await cache?.set(scoreKey(domain, s.id), s);
      }
    } catch (e) {
      failedBatches++;
      log(`  scoring batch ${i / BATCH_SIZE + 1} failed: ${String(e).slice(0, 160)}`);
    }
  }

  const unscored = papers.filter((p) => !scores.has(p.id)).map((p) => p.id);
  if (papers.length > 0 && scores.size === 0) throw new Error("No papers could be scored");
  return { scores, cacheHits, unscored, failedBatches };
}
