import { GoogleGenAI } from "@google/genai";
import type { Domain, Paper } from "../schema";

/**
 * Gemini embeddings, used for recall: a paper about the domain that never uses the domain's keywords
 * can still be found by meaning. Only similarity to the domain's description is kept (a number per
 * paper), never the vectors themselves, so storage stays small.
 */
const MODEL = process.env.GEMINI_EMBED_MODEL ?? "gemini-embedding-001";
const DIMS = 256;
const BATCH = 100;

export type Embedder = (texts: string[]) => Promise<number[][]>;

let ai: GoogleGenAI | null = null;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const embedTexts: Embedder = async (texts) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
  ai ??= new GoogleGenAI({ apiKey });
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const chunk = texts.slice(i, i + BATCH);
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await ai.models.embedContent({ model: MODEL, contents: chunk, config: { taskType: "SEMANTIC_SIMILARITY", outputDimensionality: DIMS } });
        const vecs = (r.embeddings ?? []).map((e) => e.values ?? []);
        if (vecs.length !== chunk.length || vecs.some((v) => !v.length)) throw new Error("Embedding response did not match the request");
        out.push(...vecs);
        lastErr = undefined;
        break;
      } catch (e) {
        lastErr = e;
        await sleep(1000 * 2 ** attempt);
      }
    }
    if (lastErr) throw lastErr;
  }
  return out;
};

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** What the domain is about, in words: the text every paper is compared against. */
export const profileText = (d: Domain) =>
  [d.name, d.intentNote, d.keywords.length ? `Topics: ${d.keywords.join(", ")}` : ""].filter(Boolean).join(". ");

export const paperText = (p: Pick<Paper, "title" | "abstract">) => `${p.title}. ${p.abstract.slice(0, 900)}`;
