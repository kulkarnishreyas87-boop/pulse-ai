import { NextResponse } from "next/server";
import { adminFromEnv } from "@/lib/admin";
import { DomainList, MAX_DOMAINS, getDomains, saveDomains } from "@/lib/domains";

export const dynamic = "force-dynamic";

/** Reading the domain list is public: it is just topic names. Whether editing is possible is reported too. */
export async function GET() {
  const { domains, source } = await getDomains();
  const writable = process.env.NODE_ENV !== "production" || Boolean(process.env.ADMIN_PASSCODE);
  return NextResponse.json({ domains, source, max: MAX_DOMAINS, writable, needsPasscode: Boolean(process.env.ADMIN_PASSCODE) });
}

export async function PUT(req: Request) {
  const auth = adminFromEnv(req.headers);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

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
