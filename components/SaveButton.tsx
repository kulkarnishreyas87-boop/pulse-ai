"use client";

import { useEffect, useState } from "react";
import type { BriefCard } from "@/lib/schema";
import { SAVED_EVENT, SAVED_KEY, readSaved, toSaved, toggleSaved, writeSaved, type SaveContext } from "@/lib/saved";
import { IconBookmark } from "./Icons";

/** Save / unsave one paper. Shows "Saved" across tabs and pages as soon as the list changes. */
export function SaveButton({ card, ctx }: { card: BriefCard; ctx: SaveContext }) {
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const sync = () => setSaved(readSaved().some((a) => a.arxivId === card.arxivId));
    sync();
    const onStorage = (e: StorageEvent) => e.key === SAVED_KEY && sync();
    window.addEventListener(SAVED_EVENT, sync);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(SAVED_EVENT, sync);
      window.removeEventListener("storage", onStorage);
    };
  }, [card.arxivId]);

  const toggle = () => {
    const ok = writeSaved(toggleSaved(readSaved(), toSaved(card, ctx)));
    setFailed(!ok);
    if (ok) setSaved(!saved);
  };

  return (
    <button
      type="button"
      className={`save-btn ${saved ? "is-saved" : ""}`}
      onClick={toggle}
      aria-pressed={saved}
      aria-label={saved ? `Remove “${card.title}” from saved articles` : `Save “${card.title}” to read later`}
      title={failed ? "This browser is blocking storage, so the article could not be saved" : undefined}
    >
      <IconBookmark className={saved ? "filled" : ""} />
      <span>{failed ? "Can't save here" : saved ? "Saved" : "Save"}</span>
    </button>
  );
}
