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

/**
 * One photograph per built-in domain, from Unsplash under the free Unsplash License (checked on each
 * photo page: "Free Photo", not an Unsplash+ premium image). Photographers are credited wherever the
 * photo appears. Domains added later in Settings fall back to their generated artwork.
 */
export interface DomainPhoto {
  src: string;
  alt: string;
  photographer: string;
  page: string;
}

export const DOMAIN_PHOTOS: Record<string, DomainPhoto> = {
  agents: {
    src: "https://images.unsplash.com/photo-1485827404703-89b55fcc595e",
    alt: "A white humanoid robot against a warm brown wall",
    photographer: "Alex Knight",
    page: "https://unsplash.com/photos/white-robot-near-brown-wall-2EJCSULRwC8",
  },
  rag: {
    src: "https://images.unsplash.com/photo-1524995997946-a1c2e315a42f",
    alt: "Rows of books on tall wooden library shelves",
    photographer: "Susan Q Yin",
    page: "https://unsplash.com/photos/books-on-brown-wooden-shelf-2JIvboGLeho",
  },
  code: {
    src: "https://images.unsplash.com/photo-1542831371-29b0f74f9713",
    alt: "Colourful lines of code on a dark editor screen",
    photographer: "Florian Olivo",
    page: "https://unsplash.com/photos/lines-of-html-codes-4hbJ-eymZ1o",
  },
  "cv-industrial": {
    src: "https://images.unsplash.com/photo-1647427060118-4911c9821b82",
    alt: "A factory floor filled with orange industrial machines",
    photographer: "Simon Kadula",
    page: "https://unsplash.com/photos/a-factory-filled-with-lots-of-orange-machines-8gr6bObQLOI",
  },
};

/** Sized, compressed image URL from Unsplash's image CDN. */
export const photoUrl = (p: DomainPhoto, width: number) => `${p.src}?auto=format&fit=crop&w=${width}&q=70`;

/** Unsplash asks for referral links on credits. */
export const creditUrl = (url: string) => `${url}?utm_source=pulse_ai&utm_medium=referral`;

/** CSS custom property carrying the hue, consumed by the stylesheet as hsl(var(--h) …). */
export const hueStyle = (hue: number) => ({ ["--h" as string]: String(hue) }) as React.CSSProperties;
