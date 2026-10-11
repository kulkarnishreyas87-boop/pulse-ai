import { NextResponse } from "next/server";
import { cronFromEnv } from "@/lib/admin";
import { getDomains } from "@/lib/domains";
import { defaultCtx } from "@/lib/jobs/handlers";
import { tick } from "@/lib/jobs/runner";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Vercel Cron target (Monday 00:00 UTC). Only creates the week's run; the ticker does the work. Idempotent. */
async function handle(req: Request) {
  const auth = cronFromEnv(req.headers);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  try {
    const week = new URL(req.url).searchParams.get("week") ?? undefined;
    const r = await tick(defaultCtx(), { week, autoCreate: true, getDomains: async () => (await getDomains()).domains, budgetMs: 0 });
    return NextResponse.json({ week: r.week, created: r.created, status: r.status });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message.slice(0, 200) : "run failed" }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
