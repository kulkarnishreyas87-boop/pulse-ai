import { NextResponse } from "next/server";
import { z } from "zod";
import { LIMITS, overLimit } from "@/lib/ratelimit";
import { expandDomain } from "@/lib/ai/expand";
import { generateJson } from "@/lib/ai/gemini";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Body = z.object({ name: z.string().trim().min(2).max(80), intentNote: z.string().max(400).default("") });

/** Proposes search settings for a domain. Nothing is saved: the user reviews and edits the proposal. */
export async function POST(req: Request) {
  // Settings is open, so both a per-caller limit and a shared daily cap protect the Gemini quota.
  if (await overLimit(LIMITS.suggest, req.headers)) return NextResponse.json({ error: "Too many requests. Wait a minute." }, { status: 429 });
  if (await overLimit(LIMITS.suggestDaily, req.headers)) {
    return NextResponse.json({ error: "Today's limit for AI suggestions has been reached. You can still type search terms by hand." }, { status: 429 });
  }

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
