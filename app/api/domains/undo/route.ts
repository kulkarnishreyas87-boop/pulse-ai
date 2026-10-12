import { NextResponse } from "next/server";
import { rateLimited } from "@/lib/admin";
import { undoDomains } from "@/lib/domains";

export const dynamic = "force-dynamic";

/** Restores the domain list from before the last save (pressing it again re-applies that save). */
export async function POST() {
  if (rateLimited("domains-undo", 20, 60_000)) {
    return NextResponse.json({ error: "Too many requests. Wait a minute and try again." }, { status: 429 });
  }
  try {
    return NextResponse.json({ ok: true, domains: await undoDomains() });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not undo." }, { status: 409 });
  }
}
