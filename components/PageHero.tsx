import Link from "next/link";
import { IconPulse } from "./Icons";

/** The shared header for secondary pages, matching the brief's hero. */
export function PageHero({ title, sub }: { title: string; sub?: string }) {
  return (
    <header className="page-hero">
      <div className="hero-bg" aria-hidden="true">
        <span className="blob b1" />
        <span className="blob b2" />
      </div>
      <div className="wrap" style={{ maxWidth: 860 }}>
        <div className="topbar">
          <Link href="/" className="brand" style={{ textDecoration: "none" }}>
            <span className="brand-mark" aria-hidden="true">
              <IconPulse />
            </span>
            Pulse-AI
          </Link>
          <Link href="/" className="ghost-btn">
            ← Back to the brief
          </Link>
        </div>
        <h1>{title}</h1>
        {sub && <p>{sub}</p>}
      </div>
    </header>
  );
}
