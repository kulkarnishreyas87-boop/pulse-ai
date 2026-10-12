import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { DomainView } from "@/components/BriefView";
import { getLatestBrief } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const brief = await getLatestBrief();
  const s = brief.sections.find((x) => x.domainId === id);
  return { title: s ? `${s.domainName} · Pulse-AI` : "Pulse-AI" };
}

/** A domain's page in the latest brief. */
export default async function DomainPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const brief = await getLatestBrief();
  if (!brief.sections.some((s) => s.domainId === id)) notFound();
  return <DomainView brief={brief} domainId={id} latest />;
}
