import { NextResponse } from "next/server";
import { z } from "zod";
import { adminFromEnv, rateLimited } from "@/lib/admin";
import { expandDomain } from "@/lib/ai/expand";
import { generateJson } from "@/lib/ai/gemini";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Body = z.object({ name: z.string().trim().min(2).max(80), intentNote: z.string().max(400).default("") });

/** Proposes search settings for a domain. Nothing is saved: the user reviews and edits the proposal. */
export async function POST(req: Request) {
  const auth = adminFromEnv(req.headers);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (rateLimited("expand")) return NextResponse.json({ error: "Too many requests. Wait a minute." }, { status: 429 });

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Enter a domain name (2 to 80 characters)." }, { status: 400 });

  try {
    return NextResponse.json(await expandDomain(parsed.data.name, parsed.data.intentNote, generateJson));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Expansion failed.";
    const noKey = msg.includes("GEMINI_API_KEY");
    return NextResponse.json(
      { error: noKey ? "The AI service is not configured on the server." : "Could not suggest search terms right now. You can still type them in by hand." },
      { status: noKey ? 503 : 502 },
    );
  }
}
