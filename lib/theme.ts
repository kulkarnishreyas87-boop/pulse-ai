/**
 * Visual identity per research domain: one hue, used for every chip, accent and piece of artwork that
 * belongs to the domain, so a reader learns "violet = agents" without being told. Domains Kavita adds
 * later get a stable hue derived from their id, and an art style guessed from their name.
 */
export type ArtKind = "network" | "docs" | "code" | "lens" | "waves";

const KNOWN: Record<string, { hue: number; kind: ArtKind }> = {
  agents: { hue: 262, kind: "network" },
  rag: { hue: 199, kind: "docs" },
  code: { hue: 155, kind: "code" },
  "cv-industrial": { hue: 28, kind: "lens" },
};

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function guessKind(name: string): ArtKind {
  const n = name.toLowerCase();
  if (/agent|multi-agent|planning|tool/.test(n)) return "network";
  if (/retriev|rag|search|knowledge|document/.test(n)) return "docs";
  if (/code|software|program|compiler/.test(n)) return "code";
  if (/vision|image|video|visual|inspection|camera/.test(n)) return "lens";
  return "waves";
}

export interface DomainTheme {
  hue: number;
  kind: ArtKind;
}

export function domainTheme(id: string, name = ""): DomainTheme {
  return KNOWN[id] ?? { hue: hashString(id) % 360, kind: guessKind(name || id) };
}

/** CSS custom property carrying the hue, consumed by the stylesheet as hsl(var(--h) …). */
export const hueStyle = (hue: number) => ({ ["--h" as string]: String(hue) }) as React.CSSProperties;
