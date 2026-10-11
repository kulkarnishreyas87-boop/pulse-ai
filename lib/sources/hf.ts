import type { HfSignal, Paper } from "../schema";
import { dayList, type WeekWindow } from "../week";

export interface HfResult {
  signals: Map<string, HfSignal>; // keyed by arXiv id
  papers: Paper[]; // the HF-listed papers, so papers outside the arXiv query can still be considered
  ok: boolean; // false if every request failed (ranking then proceeds without the attention signal)
}

/**
 * Hugging Face Daily Papers: community upvotes + linked GitHub repo, used as an attention signal.
 * Optional by design: any failure degrades to "no signal", never to an error.
 * Papers are often listed 1 to 2 days after submission, so we look a little past the window end.
 */
export async function fetchHf(win: WeekWindow): Promise<HfResult> {
  // listed 1 to 2 days after submission, so look a little past the window end
  const span = Math.ceil((win.end.getTime() - win.start.getTime()) / 86_400_000) + 2;
  const days = dayList(win.start, span).filter((d) => new Date(d) <= new Date());
  const results = await Promise.allSettled(
    days.map(async (d) => {
      const res = await fetch(`https://huggingface.co/api/daily_papers?date=${d}&limit=100`, {
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`HF HTTP ${res.status}`);
      return (await res.json()) as any[];
    }),
  );

  const signals = new Map<string, HfSignal>();
  const papers: Paper[] = [];
  let okCount = 0;
  for (const r of results) {
    if (r.status !== "fulfilled" || !Array.isArray(r.value)) continue;
    okCount++;
    for (const item of r.value) {
      const p = item?.paper;
      if (!p?.id) continue;
      const published = String(p.publishedAt ?? "");
      if (published && (new Date(published) < win.start || new Date(published) > win.end)) continue;
      const sig: HfSignal = {
        upvotes: Number(p.upvotes ?? 0),
        comments: Number(item.numComments ?? 0),
        githubRepo: p.githubRepo ?? null,
        githubStars: Number(p.githubStars ?? 0),
      };
      const prev = signals.get(p.id);
      if (!prev || sig.upvotes > prev.upvotes) signals.set(p.id, sig);
      papers.push({
        id: p.id,
        title: String(p.title ?? item.title ?? "").replace(/\s+/g, " ").trim(),
        abstract: String(p.summary ?? item.summary ?? "").replace(/\s+/g, " ").trim(),
        authors: (p.authors ?? []).map((a: any) => a?.name).filter(Boolean),
        published,
        primaryCategory: "",
        categories: [],
        url: `https://arxiv.org/abs/${p.id}`,
        source: "hf",
        hf: sig,
      });
    }
  }
  return { signals, papers, ok: okCount > 0 };
}
