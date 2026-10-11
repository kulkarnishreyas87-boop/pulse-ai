import { NextResponse } from "next/server";
import { defaultKv } from "@/lib/jobs/kv";
import { runStatus } from "@/lib/jobs/status";

export const dynamic = "force-dynamic";

/** Public, read-only progress of the week's run. Error text is redacted. */
export async function GET(req: Request) {
  try {
    const week = new URL(req.url).searchParams.get("week") ?? undefined;
    return NextResponse.json(await runStatus(defaultKv(), week));
  } catch (e) {
    return NextResponse.json({ error: "Status is unavailable: " + (e instanceof Error ? e.message.slice(0, 120) : "unknown") }, { status: 503 });
  }
}
