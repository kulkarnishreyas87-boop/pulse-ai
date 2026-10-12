import type { Metadata } from "next";
import { PageHero } from "@/components/PageHero";
import { SavedList } from "@/components/SavedList";

export const metadata: Metadata = { title: "Saved · Research Pulse" };

export default function SavedPage() {
  return (
    <>
      <PageHero title="Saved articles" sub="Papers you saved from the brief to come back to, newest first." />
      <main className="wrap page search-page">
        <SavedList />
      </main>
    </>
  );
}
