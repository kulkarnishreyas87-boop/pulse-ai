import { NextResponse } from "next/server";
import { LIMITS, overLimit } from "@/lib/ratelimit";
import { undoDomains } from "@/lib/domains";

export const dynamic = "force-dynamic";

/** Restores the domain list from before the last save. Press again to step further back (up to 10 versions). */
export async function POST(req: Request) {
  if (await overLimit(LIMITS.undo, req.headers)) {
    return NextResponse.json({ error: "Too many requests. Wait a minute and try again." }, { status: 429 });
  }
  try {
    const { domains, remaining } = await undoDomains();
    return NextResponse.json({ ok: true, domains, remaining });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not undo." }, { status: 409 });
  }
}
