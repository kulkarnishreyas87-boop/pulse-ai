import { hashString, type ArtKind } from "@/lib/theme";

/** Small deterministic random generator, so the same seed always draws the same picture (server-rendered, no flicker). */
function rng(seed: number) {
  let a = seed || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Original generative artwork for a research domain: no stock photos, no licensing questions.
 * Each domain has its own motif (a network for agents, stacked documents for retrieval, code lines,
 * a lens for computer vision) drawn in the domain's colour, varied per paper by `seed`.
 * Purely decorative, so it is hidden from screen readers.
 */
export function DomainArt({ kind, hue, seed, className = "" }: { kind: ArtKind; hue: number; seed: string; className?: string }) {
  const r = rng(hashString(seed));
  const id = `g${hashString(seed + kind).toString(36)}`;
  const c = (dh: number, s: number, l: number, a = 1) => `hsl(${(hue + dh + 360) % 360} ${s}% ${l}% / ${a})`;

  let motif: React.ReactNode = null;
  if (kind === "network") {
    const nodes = Array.from({ length: 14 }, () => ({ x: 30 + r() * 340, y: 25 + r() * 150, s: 2 + r() * 5 }));
    const links: [number, number][] = [];
    nodes.forEach((a, i) => nodes.forEach((b, j) => j > i && Math.hypot(a.x - b.x, a.y - b.y) < 95 && links.push([i, j])));
    motif = (
      <g className="art-drift">
        {links.map(([i, j], k) => (
          <line key={k} x1={nodes[i].x} y1={nodes[i].y} x2={nodes[j].x} y2={nodes[j].y} stroke={c(30, 90, 92, 0.45)} strokeWidth="1.2" />
        ))}
        {nodes.map((n, k) => (
          <circle key={k} cx={n.x} cy={n.y} r={n.s} fill={c(k % 3 === 0 ? 50 : 0, 95, 96)} className={k % 4 === 0 ? "art-pulse" : undefined} style={{ animationDelay: `${(k % 5) * 0.6}s` }} />
        ))}
      </g>
    );
  } else if (kind === "docs") {
    motif = (
      <g className="art-drift">
        {Array.from({ length: 4 }, (_, k) => {
          const x = 70 + k * 62 + r() * 10;
          const y = 40 + (k % 2) * 18 + r() * 8;
          return (
            <g key={k} transform={`rotate(${(r() - 0.5) * 10} ${x + 50} ${y + 60})`}>
              <rect x={x} y={y} width="104" height="128" rx="10" fill={c(0, 90, 98, 0.92 - k * 0.12)} />
              {Array.from({ length: 6 }, (_, l) => (
                <rect key={l} x={x + 14} y={y + 22 + l * 15} width={40 + r() * 46} height="5" rx="2.5" fill={c(10, 70, 60, 0.55)} />
              ))}
            </g>
          );
        })}
        <circle cx="330" cy="58" r="22" fill="none" stroke={c(40, 95, 95)} strokeWidth="5" className="art-pulse" />
        <line x1="346" y1="74" x2="366" y2="94" stroke={c(40, 95, 95)} strokeWidth="6" strokeLinecap="round" />
      </g>
    );
  } else if (kind === "code") {
    motif = (
      <g className="art-drift">
        <text x="34" y="128" fontSize="96" fontFamily="ui-monospace, monospace" fill={c(0, 90, 96, 0.9)}>{"{"}</text>
        <text x="330" y="128" fontSize="96" fontFamily="ui-monospace, monospace" fill={c(0, 90, 96, 0.9)}>{"}"}</text>
        {Array.from({ length: 8 }, (_, l) => {
          const indent = [0, 18, 36, 36, 18, 36, 18, 0][l];
          return (
            <g key={l}>
              <rect x={100 + indent} y={34 + l * 17} width={30 + r() * 50} height="8" rx="4" fill={c(40, 90, 88, 0.95)} />
              <rect x={100 + indent + 90} y={34 + l * 17} width={20 + r() * 60} height="8" rx="4" fill={c(-30, 80, 94, 0.7)} />
            </g>
          );
        })}
        <rect x="100" y="172" width="10" height="14" fill={c(0, 95, 97)} className="art-blink" />
      </g>
    );
  } else if (kind === "lens") {
    motif = (
      <g>
        {[70, 52, 34, 16].map((rad, k) => (
          <circle key={k} cx="200" cy="100" r={rad} fill="none" stroke={c(k * 12, 95, 94, 0.85 - k * 0.12)} strokeWidth={k === 3 ? 10 : 2.5} />
        ))}
        <line x1="200" y1="15" x2="200" y2="185" stroke={c(0, 90, 95, 0.4)} strokeWidth="1.5" />
        <line x1="95" y1="100" x2="305" y2="100" stroke={c(0, 90, 95, 0.4)} strokeWidth="1.5" />
        <rect x="0" y="0" width="400" height="6" fill={c(30, 100, 92, 0.6)} className="art-scan" />
        {Array.from({ length: 6 }, (_, k) => (
          <rect key={k} x={40 + r() * 320} y={20 + r() * 160} width="14" height="14" rx="3" fill="none" stroke={c(50, 95, 95, 0.7)} strokeWidth="2" />
        ))}
      </g>
    );
  } else {
    motif = (
      <g className="art-drift">
        {Array.from({ length: 5 }, (_, k) => {
          const amp = 14 + r() * 18;
          const y0 = 50 + k * 26;
          const d = `M0 ${y0} ` + Array.from({ length: 9 }, (_, i) => `Q ${i * 50 + 25} ${y0 + (i % 2 ? amp : -amp)} ${(i + 1) * 50} ${y0}`).join(" ");
          return <path key={k} d={d} fill="none" stroke={c(k * 15, 90, 94, 0.75 - k * 0.1)} strokeWidth="3" />;
        })}
      </g>
    );
  }

  return (
    <svg viewBox="0 0 400 200" preserveAspectRatio="xMidYMid slice" className={`domain-art ${className}`} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={c(0, 75, 52)} />
          <stop offset="0.55" stopColor={c(35, 80, 46)} />
          <stop offset="1" stopColor={c(70, 85, 40)} />
        </linearGradient>
        <radialGradient id={`${id}-glow`} cx={`${20 + r() * 60}%`} cy="20%" r="70%">
          <stop offset="0" stopColor="white" stopOpacity="0.35" />
          <stop offset="1" stopColor="white" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="400" height="200" fill={`url(#${id}-bg)`} />
      <rect width="400" height="200" fill={`url(#${id}-glow)`} />
      {motif}
    </svg>
  );
}
