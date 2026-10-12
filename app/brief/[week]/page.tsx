import { notFound } from "next/navigation";
import { BriefOverview } from "@/components/BriefView";
import { getBrief, listWeeks } from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function WeekPage({ params }: { params: Promise<{ week: string }> }) {
  const { week } = await params;
  if (!/^\d{4}-W\d{2}$/.test(week)) notFound();
  const [brief, weeks] = await Promise.all([getBrief(week), listWeeks()]);
  if (!brief) notFound();
  return <BriefOverview brief={brief} weeks={weeks.filter((w) => w !== week)} latest={false} />;
}
