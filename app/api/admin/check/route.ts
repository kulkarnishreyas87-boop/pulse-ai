import { NextResponse } from "next/server";
import { adminFromEnv } from "@/lib/admin";

export const dynamic = "force-dynamic";

/** Lets the Settings page confirm a passcode before any edits are made. Rate-limited on failure. */
export async function POST(req: Request) {
  const auth = adminFromEnv(req.headers);
  return auth.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
}
