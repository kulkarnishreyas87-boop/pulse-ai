import { BriefView } from "@/components/BriefView";
import { getLatestBrief, listWeeks } from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function Home() {
  const [brief, weeks] = await Promise.all([getLatestBrief(), listWeeks()]);
  return <BriefView brief={brief} weeks={weeks.filter((w) => w !== brief.week)} />;
}
