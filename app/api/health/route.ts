import { NextResponse } from "next/server";
import { getDb, hasDb } from "@/lib/db/client";
import { geminiModel } from "@/lib/ai/gemini";
import { emailConfig } from "@/lib/email/send";

export const dynamic = "force-dynamic";

/** Configuration and connectivity check. Never returns secrets, only whether each piece is usable. */
export async function GET() {
  let database: "ok" | "missing" | "error" = "missing";
  if (hasDb()) {
    try {
      const d = await getDb();
      await d!.query("SELECT 1");
      database = "ok";
    } catch {
      database = "error";
    }
  }
  const email = emailConfig();
  return NextResponse.json({
    app: "research-pulse",
    database,
    gemini: process.env.GEMINI_API_KEY ? "configured" : "missing",
    model: geminiModel,
    email: email.ready ? "configured" : `not configured (${email.reason})`,
    cron: process.env.CRON_SECRET ? "configured" : "missing",
  });
}
