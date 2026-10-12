"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { SAVED_EVENT, SAVED_KEY, readSaved, writeSaved, type SavedArticle } from "@/lib/saved";
import { domainTheme, hueStyle } from "@/lib/theme";
import { VERDICT } from "./Paper";
import { IconArrow, IconBookmark } from "./Icons";

function fmt(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** The reader's saved articles, newest first. Reads the browser's storage, so it renders after hydration. */
export function SavedList() {
  const [items, setItems] = useState<SavedArticle[] | null>(null);

  useEffect(() => {
    const sync = () => setItems(readSaved());
    sync();
    const onStorage = (e: StorageEvent) => e.key === SAVED_KEY && sync();
    window.addEventListener(SAVED_EVENT, sync);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(SAVED_EVENT, sync);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  if (items === null) return <p className="quiet">Loading your saved articles…</p>;

  if (!items.length)
    return (
      <div className="search-empty">
        <p>
          <IconBookmark /> Nothing saved yet.
        </p>
        <p>
          Press <b>Save</b> on any paper in the brief to keep it here for later. Saved articles stay in this browser on this device.
        </p>
        <p>
          <Link href="/">Back to this week&apos;s brief</Link>
        </p>
      </div>
    );

  const remove = (id: string) => writeSaved(items.filter((a) => a.arxivId !== id));

  return (
    <>
      <p className="search-count">
        {items.length} saved article{items.length === 1 ? "" : "s"} <span className="saved-note">· kept in this browser on this device</span>
      </p>
      <ol className="search-results">
        {items.map((a) => (
          <li key={a.arxivId} className="search-hit" style={hueStyle(domainTheme(a.domainId, a.domainName).hue)}>
            <div className="search-meta">
              {a.domainId ? (
                <Link href={`/brief/${a.week}/${a.domainId}`} className="search-dom">
                  <span className="jump-dot" aria-hidden="true" /> {a.domainName}
                </Link>
              ) : (
                <span className="search-dom">{a.domainName}</span>
              )}
              <span>Week {a.week.split("-W")[1]}</span>
              {VERDICT[a.verdict] && <span className={`verdict verdict-${a.verdict}`}>{VERDICT[a.verdict].label}</span>}
              <span>Saved {fmt(a.savedAt)}</span>
            </div>
            <h2>
              <a href={a.url} target="_blank" rel="noopener noreferrer">
                {a.title} <IconArrow className="ext" />
              </a>
            </h2>
            {a.whyItMatters && <p>{a.whyItMatters}</p>}
            <div className="saved-actions">
              <span className="saved-authors">{a.authors}</span>
              <button type="button" className="save-btn is-saved" onClick={() => remove(a.arxivId)} aria-label={`Remove “${a.title}” from saved articles`}>
                <IconBookmark className="filled" />
                <span>Remove</span>
              </button>
            </div>
          </li>
        ))}
      </ol>
    </>
  );
}
