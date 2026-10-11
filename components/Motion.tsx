"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Fades and lifts its content into view the first time it scrolls on screen. Content is fully visible
 * without JavaScript (the hidden state only applies once the script has marked the page), and the
 * stylesheet turns the motion off entirely for readers who prefer reduced motion.
 */
export function Reveal({ children, delay = 0, className = "", as: Tag = "div", id }: { children: React.ReactNode; delay?: number; className?: string; as?: "div" | "section" | "article"; id?: string }) {
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!("IntersectionObserver" in window)) {
      el.classList.add("is-in");
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add("is-in");
            io.unobserve(e.target);
          }
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <Tag ref={ref as never} id={id} className={`reveal ${className}`} style={{ transitionDelay: `${delay}ms` }}>
      {children}
    </Tag>
  );
}

/** Thin bar at the top of the window showing how far through the brief the reader is. */
export function ReadingProgress() {
  const [p, setP] = useState(0);
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      setP(max > 0 ? Math.min(1, window.scrollY / max) : 0);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);
  return <div className="progress" style={{ transform: `scaleX(${p})` }} aria-hidden="true" />;
}

/** Highlights the domain link in the sticky bar for the section currently being read. */
export function SectionSpy({ ids }: { ids: string[] }) {
  useEffect(() => {
    const links = new Map(ids.map((id) => [id, document.querySelector<HTMLElement>(`[data-spy="${id}"]`)]));
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const link = links.get(e.target.id);
          if (link) link.classList.toggle("is-current", e.isIntersecting);
        }
      },
      { rootMargin: "-40% 0px -55% 0px" },
    );
    ids.forEach((id) => {
      const el = document.getElementById(id);
      if (el) io.observe(el);
    });
    return () => io.disconnect();
  }, [ids]);
  return null;
}
