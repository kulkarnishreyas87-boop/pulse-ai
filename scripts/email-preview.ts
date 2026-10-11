/**
 * Renders the latest brief as the Monday email, without sending anything.
 *   npm run email:preview                      writes .cache/email-preview.html and .txt
 *   npm run email:preview -- --week 2026-W40
 *   npm run email:preview -- --send            ALSO sends it, once, to EMAIL_TO (needs RESEND_API_KEY)
 * Sending is explicit on purpose: this script never emails anyone unless you pass --send.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { Brief } from "../lib/schema";
import { renderEmail } from "../lib/email/render";
import { emailConfig, sendViaResend } from "../lib/email/send";

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};

async function main() {
  const file = arg("week") ? `.cache/brief-${arg("week")}.json` : ".cache/brief-latest.json";
  const brief = Brief.parse(JSON.parse(readFileSync(file, "utf8")));
  const cfg = emailConfig();
  const appUrl = cfg.ready ? cfg.appUrl : process.env.APP_URL || "http://localhost:3060";
  const mail = renderEmail(brief, appUrl);
  writeFileSync(".cache/email-preview.html", mail.html);
  writeFileSync(".cache/email-preview.txt", mail.text);
  console.log(`Subject: ${mail.subject}`);
  console.log(`Wrote .cache/email-preview.html (${mail.html.length} bytes) and .cache/email-preview.txt`);

  if (!process.argv.includes("--send")) return console.log("Preview only. Nothing was sent.");
  if (!cfg.ready) throw new Error(`Cannot send: ${cfg.reason}`);
  const { id } = await sendViaResend(cfg.apiKey, {
    from: cfg.from, to: cfg.to, subject: `[Test] ${mail.subject}`, html: mail.html, text: mail.text,
    idempotencyKey: `preview:${brief.week}:${Date.now()}`,
  });
  console.log(`Sent test email ${id} to ${cfg.to.length} recipient(s).`);
}

main().catch((e) => {
  console.error(String(e instanceof Error ? e.message : e));
  process.exit(1);
});
