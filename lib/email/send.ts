export interface EmailMessage {
  from: string;
  to: string[];
  subject: string;
  html: string;
  text: string;
  idempotencyKey: string;
}

export type EmailConfig =
  | { ready: true; apiKey: string; from: string; to: string[]; appUrl: string }
  | { ready: false; reason: string };

const EMAIL_RE = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;
export const MAX_RECIPIENTS = 5;

/** Reads the environment. Missing config means "skip the email", never "fail the week". */
export function emailConfig(env: Record<string, string | undefined> = process.env): EmailConfig {
  const apiKey = env.RESEND_API_KEY?.trim();
  if (!apiKey) return { ready: false, reason: "RESEND_API_KEY is not set" };

  const to = (env.EMAIL_TO ?? "").split(/[,;\s]+/).filter(Boolean);
  if (!to.length) return { ready: false, reason: "EMAIL_TO is not set" };
  const bad = to.find((a) => !EMAIL_RE.test(a));
  if (bad) return { ready: false, reason: `EMAIL_TO contains an invalid address` };
  if (to.length > MAX_RECIPIENTS) return { ready: false, reason: `EMAIL_TO has more than ${MAX_RECIPIENTS} recipients` };

  const appUrl = (env.APP_URL || (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : "")).trim();
  if (!/^https?:\/\//.test(appUrl)) return { ready: false, reason: "APP_URL is not set (needed for the link to the full brief)" };

  // Resend's shared test sender works with no domain, but only delivers to the account owner's own address.
  return { ready: true, apiKey, to, appUrl, from: env.EMAIL_FROM?.trim() || "Pulse-AI <onboarding@resend.dev>" };
}

/**
 * Sends through the Resend REST API. The Idempotency-Key makes a retried request (for example after a
 * timeout where the first attempt actually went through) deliver only once.
 */
export async function sendViaResend(
  apiKey: string,
  msg: EmailMessage,
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: string }> {
  const res = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": msg.idempotencyKey.slice(0, 250),
    },
    body: JSON.stringify({ from: msg.from, to: msg.to, subject: msg.subject, html: msg.html, text: msg.text }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
  if (!res.ok || !body.id) {
    // Surface Resend's own explanation (for example the test-sender recipient restriction), never the key.
    throw new Error(`Resend ${res.status}: ${(body.message ?? body.name ?? "no id returned").slice(0, 200)}`);
  }
  return { id: body.id };
}
