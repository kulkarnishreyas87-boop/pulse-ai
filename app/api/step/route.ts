import { NextResponse } from "next/server";
import { cronFromEnv } from "@/lib/admin";
import { getDomains } from "@/lib/domains";
import { defaultCtx } from "@/lib/jobs/handlers";
import { tick } from "@/lib/jobs/runner";

export const dynamic = "force-dynamic";
// Declared so the platform allows a full step. The runner stops STARTING jobs after ~25s, since the slowest
// single job is one Gemini call, so a step always ends well inside this limit.
export const maxDuration = 60;

/**
 * One serverless step: create the week's run if it does not exist yet, then claim and run jobs until the
 * time budget is spent. Called by Vercel Cron and, repeatedly, by the GitHub Actions ticker.
 */
async function handle(req: Request) {
  const auth = cronFromEnv(req.headers);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  try {
    const week = new URL(req.url).searchParams.get("week") ?? undefined;
    const result = await tick(defaultCtx(), { week, autoCreate: true, getDomains: async () => (await getDomains()).domains });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message.slice(0, 200) : "step failed" }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
