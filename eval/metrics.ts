export type Label = "must" | "should_not" | "neutral";

export interface GoldenItem {
  id: string;
  domain: string;
  label: Label;
  note?: string;
}

export interface EvalReport {
  domain: string;
  selected: number;
  mustTotal: number;
  mustFound: number;
  recall: number | null; // share of "must include" papers that made the brief
  shouldNotSelected: number;
  precision: number | null; // among selected papers that carry a label, share labelled "must"
  missed: string[];
  wrongly: string[];
}

/**
 * Compares the papers a domain actually put in the brief against hand labels.
 * "must" = a paper a good analyst would not want to miss. "should_not" = noise or hype.
 * Unlabelled papers are ignored, so precision is only over what has been labelled.
 */
export function evaluate(domain: string, selectedIds: string[], golden: GoldenItem[]): EvalReport {
  const g = golden.filter((x) => x.domain === domain);
  const sel = new Set(selectedIds);
  const must = g.filter((x) => x.label === "must");
  const bad = g.filter((x) => x.label === "should_not");
  const mustFound = must.filter((x) => sel.has(x.id));
  const badSel = bad.filter((x) => sel.has(x.id));
  const labelledSelected = selectedIds.filter((id) => g.some((x) => x.id === id && x.label !== "neutral"));
  return {
    domain,
    selected: selectedIds.length,
    mustTotal: must.length,
    mustFound: mustFound.length,
    recall: must.length ? mustFound.length / must.length : null,
    shouldNotSelected: badSel.length,
    precision: labelledSelected.length
      ? labelledSelected.filter((id) => g.find((x) => x.id === id)?.label === "must").length / labelledSelected.length
      : null,
    missed: must.filter((x) => !sel.has(x.id)).map((x) => x.id),
    wrongly: badSel.map((x) => x.id),
  };
}

/** Share of cards whose individual claims all survived verification. */
export function faithfulness(stats: { cards: number; summariesRejected: number; whyRejected: number; anglesRejected: number; quotesRejected: number }) {
  if (!stats.cards) return null;
  const rejected = Math.max(stats.summariesRejected, stats.whyRejected, stats.anglesRejected, stats.quotesRejected);
  return 1 - rejected / stats.cards;
}
