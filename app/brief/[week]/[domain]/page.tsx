import { notFound } from "next/navigation";
import { DomainView } from "@/components/BriefView";
import { getBrief } from "@/lib/store";

export const dynamic = "force-dynamic";

/** A domain's page in an archived week. */
export default async function ArchivedDomainPage({ params }: { params: Promise<{ week: string; domain: string }> }) {
  const { week, domain } = await params;
  if (!/^\d{4}-W\d{2}$/.test(week)) notFound();
  const brief = await getBrief(week);
  if (!brief || !brief.sections.some((s) => s.domainId === domain)) notFound();
  return <DomainView brief={brief} domainId={domain} latest={false} />;
}
