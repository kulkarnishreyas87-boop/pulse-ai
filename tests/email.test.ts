import { test } from "node:test";
import assert from "node:assert/strict";
import { Brief, type BriefCard } from "../lib/schema";
import { esc, renderEmail, safeUrl, subjectFor } from "../lib/email/render";
import { emailConfig, sendViaResend, type EmailMessage } from "../lib/email/send";
import { MemoryKv } from "../lib/jobs/kv";
import { HANDLERS, type Ctx } from "../lib/jobs/handlers";
import { createRun, getRun, keys, type Job } from "../lib/jobs/queue";
import { Domain } from "../lib/schema";
import { parseWeekId } from "../lib/week";

const card = (id: string, o: Partial<BriefCard> = {}): BriefCard => ({
  arxivId: id, title: `Paper ${id}`, authors: "A", url: `https://arxiv.org/abs/2609.${id}`, whyItMatters: "Shows a thing.",
  summary: "Did a thing. Found a result.", verdict: "read", clientAngle: "Relevant if X.", caveats: "Preprint.", confidence: "Preprint",
  evidenceQuote: "", signals: [], domain: "AI agents", ...o,
});

const brief = (o: Partial<Brief> = {}): Brief =>
  Brief.parse({
    week: "2026-W40", windowStart: "2026-09-28T00:00:00.000Z", windowEnd: "2026-10-04T23:59:59.000Z", generatedAt: "2026-10-05T00:30:00Z",
    topThree: [card("10001"), card("10002", { verdict: "client_flag" })],
    sections: [
      { domainId: "agents", domainName: "AI agents", status: "ok", featured: ["10001", "10002"], cards: [card("10003", { domain: "" })] },
      { domainId: "code", domainName: "LLMs for code", status: "quiet", note: "Nothing cleared the threshold.", featured: [], cards: [] },
    ],
    meta: { readingMinutes: 7 },
    ...o,
  });

const cfgEnv = { RESEND_API_KEY: "re_test", EMAIL_TO: "kavita@example.com", APP_URL: "https://pulse.example.com" };

test("renders the top story, domains, a quiet-week line and the link to the full brief", () => {
  const m = renderEmail(brief(), "https://pulse.example.com/");
  assert.match(m.subject, /^Pulse-AI · Week 40: Paper 10001$/);
  assert.match(m.html, /This week at a glance/);
  assert.match(m.html, /Nothing significant this week/);
  assert.match(m.html, /https:\/\/pulse\.example\.com\/brief\/2026-W40/, "no double slash, correct week");
  assert.match(m.html, /CLIENT FLAG/);
  assert.match(m.text, /Read the full brief: https:\/\/pulse\.example\.com\/brief\/2026-W40/);
  assert.ok(m.text.includes("AI AGENTS") && m.text.includes("not peer reviewed"));
  assert.ok(!/<[a-z]/i.test(m.text), "plain-text part contains no HTML");
});

test("third-party text cannot inject HTML, scripts, links or extra headers", () => {
  const evil = card("20001", {
    title: '<img src=x onerror=alert(1)> Paper "quoted" & <script>steal()</script>',
    whyItMatters: '<a href="https://evil.example">click</a>',
    url: "javascript:alert(1)",
    clientAngle: "</div><iframe src=//evil></iframe>",
  });
  const m = renderEmail(brief({ topThree: [evil] }), "https://pulse.example.com");
  assert.ok(!m.html.includes("<script"), "script tag escaped");
  assert.ok(!m.html.includes("<img src=x"), "img tag escaped");
  assert.ok(!m.html.includes("<iframe"), "iframe escaped");
  assert.ok(!m.html.includes("evil.example\""), "injected link is not an href");
  assert.ok(!m.html.includes("javascript:"), "non-arXiv URL is dropped, not linked");
  assert.match(m.html, /&lt;script&gt;/);
  const s = subjectFor(brief({ topThree: [card("1", { title: "Line one\r\nBcc: attacker@example.com" })] }));
  assert.ok(!/[\r\n]/.test(s), "subject cannot carry a header injection");
});

test("only plain https arXiv links are ever linked", () => {
  assert.equal(safeUrl("https://arxiv.org/abs/2609.10001"), "https://arxiv.org/abs/2609.10001");
  for (const bad of ["http://arxiv.org/abs/1", "https://arxiv.org.evil.com/abs/1", "javascript:alert(1)", "https://evil.com/arxiv.org/abs/1", "https://arxiv.org/abs/1\" onclick=\""]) {
    assert.equal(safeUrl(bad), null, bad);
  }
  assert.equal(esc(`<>&"'`), "&lt;&gt;&amp;&quot;&#39;");
});

test("partial and stale briefs say so, and the subject is marked", () => {
  const b = brief({ isPartial: true, isStale: true, meta: { domainsMissing: ["RAG"], domainsDegraded: ["LLMs for code"] } });
  const m = renderEmail(b, "https://x.example");
  assert.match(m.subject, /^\[Partial\] /);
  assert.match(m.html, /Partial brief: RAG/);
  assert.match(m.html, /Hugging Face alone/);
  assert.match(m.html, /AI summaries were unavailable for: LLMs for code/);
  assert.match(renderEmail(brief(), "https://x.example", { updated: true }).text, /NOTE: Updated:/);
});

test("a card whose 'why' was removed by the verifier still gets a headline", () => {
  const m = renderEmail(brief({ topThree: [card("1", { whyItMatters: "", summary: "First sentence here. Second one." })] }), "https://x.example");
  assert.match(m.text, /First sentence here\./);
  assert.ok(!m.text.includes("Second one"));
});

test("config: missing or invalid settings mean 'not ready' with a reason, never a crash", () => {
  assert.equal(emailConfig({}).ready, false);
  assert.match((emailConfig({ ...cfgEnv, RESEND_API_KEY: "" }) as any).reason, /RESEND_API_KEY/);
  assert.match((emailConfig({ ...cfgEnv, EMAIL_TO: "" }) as any).reason, /EMAIL_TO/);
  assert.match((emailConfig({ ...cfgEnv, EMAIL_TO: "not-an-email" }) as any).reason, /invalid/);
  assert.match((emailConfig({ ...cfgEnv, EMAIL_TO: "a@x.co,b@x.co,c@x.co,d@x.co,e@x.co,f@x.co" }) as any).reason, /more than/);
  assert.match((emailConfig({ ...cfgEnv, EMAIL_TO: "a@x.co\nBcc: evil@x.co" }) as any).reason, /invalid/);
  assert.match((emailConfig({ ...cfgEnv, APP_URL: "" }) as any).reason, /APP_URL/);
  const ok = emailConfig({ ...cfgEnv, EMAIL_TO: "a@x.co, b@x.co" });
  assert.ok(ok.ready && ok.to.length === 2 && /onboarding@resend\.dev/.test(ok.from));
  assert.ok(emailConfig({ RESEND_API_KEY: "k", EMAIL_TO: "a@x.co", VERCEL_PROJECT_PRODUCTION_URL: "pulse.vercel.app" }).ready);
});

test("Resend request: auth header, idempotency key, JSON body; errors surface Resend's reason but never the key", async () => {
  const msg: EmailMessage = { from: "RP <a@x.co>", to: ["k@x.co"], subject: "S", html: "<p>h</p>", text: "t", idempotencyKey: "2026-W40:full" };
  let seen: any;
  const ok = (async (url: string, init: any) => { seen = { url, init }; return new Response(JSON.stringify({ id: "em_123" }), { status: 200 }); }) as unknown as typeof fetch;
  assert.deepEqual(await sendViaResend("re_secret", msg, ok), { id: "em_123" });
  assert.equal(seen.url, "https://api.resend.com/emails");
  assert.equal(seen.init.headers.Authorization, "Bearer re_secret");
  assert.equal(seen.init.headers["Idempotency-Key"], "2026-W40:full");
  assert.deepEqual(JSON.parse(seen.init.body).to, ["k@x.co"]);

  const denied = (async () => new Response(JSON.stringify({ message: "You can only send testing emails to your own email address", name: "validation_error" }), { status: 403 })) as unknown as typeof fetch;
  await assert.rejects(sendViaResend("re_secret", msg, denied), (e: Error) => /403/.test(e.message) && /your own email/.test(e.message) && !e.message.includes("re_secret"));
  const html = (async () => new Response("<html>bad gateway</html>", { status: 502 })) as unknown as typeof fetch;
  await assert.rejects(sendViaResend("k", msg, html), /502/);
});

/* ---- the email job ---- */
const win = parseWeekId("2026-W40");
const run = async (kv: MemoryKv) => {
  await createRun(kv, win, [Domain.parse({ id: "agents", name: "AI agents", keywords: ["agent x"] })], Date.now());
  return (await getRun(kv, "2026-W40"))!;
};
const job = { id: "email", week: "2026-W40", kind: "email", deps: [], status: "running", attempts: 1, notBefore: 0 } as Job;

function ctxWith(kv: MemoryKv, over: Partial<Ctx> = {}) {
  const sent: EmailMessage[] = [];
  const ctx = {
    kv, llm: (async () => { throw new Error("unused"); }) as any, now: () => 1_000, sources: {} as any, publish: async () => {},
    emailConfig: () => emailConfig(cfgEnv),
    sendEmail: async (_c: any, m: EmailMessage) => (sent.push(m), { id: `em_${sent.length}` }),
    ...over,
  } as Ctx;
  return { ctx, sent };
}

test("email job: sends exactly once per variant, however many times it runs", async () => {
  const kv = new MemoryKv();
  const r = await run(kv);
  await kv.set(keys.data("2026-W40", "brief"), brief());
  const { ctx, sent } = ctxWith(kv);
  assert.match((await HANDLERS.email(job, r, ctx)) as string, /sent full email to 1 recipient/);
  assert.match((await HANDLERS.email(job, r, ctx)) as string, /already sent/);
  await Promise.all([HANDLERS.email(job, r, ctx), HANDLERS.email(job, r, ctx), HANDLERS.email(job, r, ctx)]);
  assert.equal(sent.length, 1, "a double tick or a race cannot send twice");
  assert.equal(sent[0].idempotencyKey, "2026-W40:full");
  assert.deepEqual(sent[0].to, ["kavita@example.com"]);
});

test("email job: not configured is a skip, not a failure", async () => {
  const kv = new MemoryKv();
  const r = await run(kv);
  await kv.set(keys.data("2026-W40", "brief"), brief());
  const { ctx, sent } = ctxWith(kv, { emailConfig: () => emailConfig({}) });
  assert.match((await HANDLERS.email(job, r, ctx)) as string, /^skipped: RESEND_API_KEY/);
  assert.equal(sent.length, 0);
});

test("email job: no published brief means no email", async () => {
  const kv = new MemoryKv();
  const r = await run(kv);
  const { ctx, sent } = ctxWith(kv);
  assert.match((await HANDLERS.email(job, r, ctx)) as string, /no brief/);
  assert.equal(sent.length, 0);
});

test("email job: a failed send releases the guard so the retry can deliver, and one email results", async () => {
  const kv = new MemoryKv();
  const r = await run(kv);
  await kv.set(keys.data("2026-W40", "brief"), brief());
  let calls = 0;
  const sent: EmailMessage[] = [];
  const { ctx } = ctxWith(kv, {
    sendEmail: async (_c, m) => {
      if (++calls === 1) throw new Error("Resend 502: bad gateway");
      sent.push(m);
      return { id: "em_ok" };
    },
  });
  await assert.rejects(HANDLERS.email(job, r, ctx), /502/);
  assert.equal(await kv.get("sent:2026-W40:full"), null, "guard released on failure");
  assert.match((await HANDLERS.email(job, r, ctx)) as string, /sent full/);
  assert.equal(sent.length, 1);
});

test("email job: a partial email goes out at the cutoff, and one 'Updated' email follows when the rest arrives", async () => {
  const kv = new MemoryKv();
  const r = await run(kv);
  const { ctx, sent } = ctxWith(kv);
  await kv.set(keys.data("2026-W40", "brief"), brief({ isPartial: true, meta: { domainsMissing: ["RAG"] } }));
  await HANDLERS.email(job, r, ctx);
  await kv.set(keys.data("2026-W40", "brief"), brief()); // recomposed, now complete
  await HANDLERS.email(job, r, ctx);
  await HANDLERS.email(job, r, ctx); // a third run changes nothing
  assert.equal(sent.length, 2);
  assert.match(sent[0].subject, /^\[Partial\]/);
  assert.match(sent[1].subject, /^Updated: Pulse-AI/);
  assert.match(sent[1].text, /NOTE: Updated:/);
  assert.deepEqual(sent.map((m) => m.idempotencyKey), ["2026-W40:partial", "2026-W40:full"]);
});

test("EMAIL_DRY_RUN: the full email step runs but nothing leaves the machine; the message is recorded instead", async () => {
  const { dryRunSender, defaultCtx } = await import("../lib/jobs/handlers");
  const kv = new MemoryKv();
  const r = await run(kv);
  await kv.set(keys.data("2026-W40", "brief"), brief());
  const realFetch = globalThis.fetch;
  let network = 0;
  globalThis.fetch = (async () => { network++; return new Response("{}"); }) as typeof fetch;
  try {
    const { ctx } = ctxWith(kv, { sendEmail: dryRunSender(kv) as any });
    assert.match((await HANDLERS.email(job, r, ctx)) as string, /sent full email/);
    assert.equal(network, 0, "no request to Resend");
    const rec: any = await kv.get("emaildry:2026-W40:full");
    assert.match(rec.subject, /Pulse-AI · Week 40/);
    assert.deepEqual(rec.to, ["kavita@example.com"]);
    assert.match(rec.text, /Read the full brief/);
    assert.match((await HANDLERS.email(job, r, ctx)) as string, /already sent/, "guards still apply in a dry run");
  } finally {
    globalThis.fetch = realFetch;
  }
  // and the switch is what defaultCtx actually uses
  process.env.EMAIL_DRY_RUN = "1";
  try {
    const c = defaultCtx();
    const out = await c.sendEmail({ ready: true, apiKey: "k", from: "f", to: ["a@b.co"], appUrl: "https://x" }, { from: "f", to: ["a@b.co"], subject: "s", html: "h", text: "t", idempotencyKey: "probe:dry" });
    assert.equal(out.id, "dry-run:probe:dry");
    await c.kv.del("emaildry:probe:dry");
  } finally {
    delete process.env.EMAIL_DRY_RUN;
  }
});
