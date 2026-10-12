import { NextResponse } from "next/server";
import { LIMITS, overLimit } from "@/lib/ratelimit";
import { hasDb } from "@/lib/db/client";
import { DomainList, MAX_DOMAINS, getDomainHistory, getDomains, saveDomains } from "@/lib/domains";

export const dynamic = "force-dynamic";

/** The domain list, plus whether it can be edited and whether there is an earlier version to undo to. */
export async function GET() {
  const [{ domains, source }, history] = await Promise.all([getDomains(), getDomainHistory()]);
  const writable = hasDb() || process.env.NODE_ENV !== "production";
  return NextResponse.json({ domains, source, max: MAX_DOMAINS, writable, hasPrevious: history.length > 0, historyDepth: history.length });
}

/**
 * Saves the domain list. There is no passcode (the owner's choice); instead saves are validated,
 * rate-limited per caller across all server instances, and the last 10 versions are kept for undo.
 */
export async function PUT(req: Request) {
  if (await overLimit(LIMITS.save, req.headers)) {
    return NextResponse.json({ error: "Too many saves in a short time. Wait a minute and try again." }, { status: 429 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }
  const parsed = DomainList.safeParse((body as { domains?: unknown })?.domains);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    return NextResponse.json({ error: issues[0]?.message ?? "Invalid domains.", issues }, { status: 422 });
  }
  try {
    const source = await saveDomains(parsed.data);
    return NextResponse.json({ ok: true, source, count: parsed.data.length });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not save." }, { status: 503 });
  }
}
