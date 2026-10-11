import type { Brief, Domain, Paper } from "../schema";
import { generateJson, type JsonLlm } from "../ai/gemini";
import { fetchArxivDay } from "../sources/arxiv";
import { fetchHf, type HfResult } from "../sources/hf";
import { dedupe, prefilter } from "../pipeline/prefilter";
import { judgePapers, scoreKey, BATCH_SIZE, type ScoreCache } from "../pipeline/judge";
import { rankPapers, type RankedPaper } from "../pipeline/rank";
import { verifyAndBuild, writeDrafts } from "../pipeline/write";
import { composeBrief, type DomainInput } from "../pipeline/compose";
import { synthesizeSection } from "../pipeline/synthesize";
import { degradedScoringResult, degradedWritingSection, noDataSection, quietSection, type SectionResult } from "../pipeline/domainBrief";
import type { IngestResult } from "../pipeline/ingest";
import { publishBrief } from "../store";
import { hasDb } from "../db/client";
import type { WeekWindow } from "../week";
import type { WrittenCard } from "../schema";
import { DATA_TTL, keys, type Job, type Run } from "./queue";
import { FETCH_DAYS, coverageWindow, dayOffset, previousWeeks, seenKey, SEEN_TTL } from "../coverage";
import { defaultKv, type Kv } from "./kv";
import { renderEmail } from "../email/render";
import { emailConfig, sendViaResend, type EmailConfig, type EmailMessage } from "../email/send";

/** Everything a handler touches from the outside, injectable so the whole graph can be tested offline. */
export interface Ctx {
  kv: Kv;
  llm: JsonLlm;
  now: () => number;
  sources: {
    arxivDay: (d: Domain, win: WeekWindow, i: number) => Promise<{ papers: Paper[] }>;
    hf: (win: WeekWindow) => Promise<HfResult>;
  };
  publish: (brief: Brief) => Promise<void>;
  emailConfig: () => EmailConfig;
  sendEmail: (cfg: Extract<EmailConfig, { ready: true }>, msg: EmailMessage) => Promise<{ id: string }>;
}

async function publishDefault(brief: Brief) {
  if (hasDb()) return publishBrief(brief);
  // development without a database: write where the dev page looks
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(".cache", { recursive: true });
  const json = JSON.stringify(brief, null, 2);
  await writeFile(`.cache/brief-${brief.week}.json`, json);
  await writeFile(`.cache/brief-latest.json`, json);
}

/**
 * EMAIL_DRY_RUN=1 runs the whole email step (guards, rendering, logging) but records the message in
 * storage instead of sending it. For test runs, and for checking a new deployment before going live.
 */
export function dryRunSender(kv: Kv) {
  return async (_cfg: unknown, msg: EmailMessage) => {
    await kv.set(`emaildry:${msg.idempotencyKey}`, { subject: msg.subject, to: msg.to, textChars: msg.text.length, htmlChars: msg.html.length, text: msg.text }, DATA_TTL);
    return { id: `dry-run:${msg.idempotencyKey}` };
  };
}

export function defaultCtx(): Ctx {
  const kv = defaultKv();
  const dry = process.env.EMAIL_DRY_RUN === "1";
  return {
    kv, llm: generateJson, now: Date.now, sources: { arxivDay: fetchArxivDay, hf: fetchHf }, publish: publishDefault,
    emailConfig: () => emailConfig(),
    sendEmail: dry ? dryRunSender(kv) : (cfg, msg) => sendViaResend(cfg.apiKey, msg),
  };
}

const win = (run: Run): WeekWindow => ({ week: run.week, start: new Date(run.windowStart), end: new Date(run.windowEnd) });
const domainOf = (run: Run, id?: string): Domain => {
  const d = run.domains.find((x) => x.id === id);
  if (!d) throw new Error(`Unknown domain ${id}`);
  return d;
};

export function kvScoreCache(kv: Kv): ScoreCache {
  return {
    get: (k) => kv.get(k).then((x) => (x as any) ?? undefined),
    set: (k, s) => kv.set(k, s, 60 * 24 * 3600),
  };
}

interface RankData {
  ranked: RankedPaper[];
  topIds: string[];
  stats: SectionResult["stats"];
}

type Handler = (job: Job, run: Run, ctx: Ctx) => Promise<string | void>;

const hf: Handler = async (_job, run, ctx) => {
  const r = await ctx.sources.hf(coverageWindow(win(run)));
  if (!r.ok) throw new Error("Every Hugging Face request failed");
  await ctx.kv.set(keys.data(run.week, "hf"), { signals: [...r.signals], papers: r.papers }, DATA_TTL);
  return `${r.signals.size} signals`;
};

const fetchDay: Handler = async (job, run, ctx) => {
  const r = await ctx.sources.arxivDay(domainOf(run, job.domainId), win(run), dayOffset(job.arg!));
  // Raw day data is large and only needed by prefilter (and its retries), so it expires after 3 days, not 3 weeks.
  await ctx.kv.set(keys.data(run.week, job.domainId!, `day${job.arg}`), r.papers, 3 * 24 * 3600);
  return `${r.papers.length} papers`;
};

/** Merges the seven days and Hugging Face, prefilters, and spawns one judge job per batch of the shortlist. */
const prefilterJob: Handler = async (job, run, ctx) => {
  const domain = domainOf(run, job.domainId);
  const days = await ctx.kv.mget<Paper[]>(Array.from({ length: FETCH_DAYS }, (_, i) => keys.data(run.week, domain.id, `day${i}`)));
  const missingDays = days.filter((d) => d === null).length;
  const hfData = await ctx.kv.get<{ signals: [string, any][]; papers: Paper[] }>(keys.data(run.week, "hf"));
  const arxivPapers = days.flatMap((d) => d ?? []);

  if (missingDays === FETCH_DAYS && !hfData) throw new Error("No arXiv days and no Hugging Face data available");

  // Papers an earlier run already considered are skipped, so the lookback days never repeat a paper.
  const earlier = await ctx.kv.mget<string[]>(previousWeeks(run.week).map((w) => seenKey(w, domain.id)));
  const seen = new Set(earlier.flatMap((x) => x ?? []));
  const signals = new Map(hfData?.signals ?? []);
  const fresh = arxivPapers.filter((p) => !seen.has(p.id));
  const withSignal = fresh.map((p) => ({ ...p, hf: signals.get(p.id) }));
  const known = new Set(arxivPapers.map((p) => p.id));
  const hfOnly = (hfData?.papers ?? []).filter((p) => !known.has(p.id) && !seen.has(p.id));
  const merged = dedupe([...withSignal, ...hfOnly]);
  const alreadyCovered = new Set([...arxivPapers, ...(hfData?.papers ?? [])].filter((p) => seen.has(p.id)).map((p) => p.id)).size;
  await ctx.kv.set(seenKey(run.week, domain.id), merged.map((p) => p.id), SEEN_TTL);
  const shortlist = prefilter(merged, domain, 25);

  const ingest: IngestResult = {
    domainId: domain.id,
    week: run.week,
    shortlist,
    query: "",
    stale: missingDays > 0, // some days (or all) rest on Hugging Face alone
    stats: {
      arxivTotal: arxivPapers.length,
      arxivFetched: arxivPapers.length,
      arxivTruncated: false,
      arxivError: missingDays ? `${missingDays} of ${FETCH_DAYS} days could not be fetched` : null,
      hfOk: Boolean(hfData),
      hfOnlyMatched: prefilter(hfOnly, domain, Infinity).length,
      afterDedupe: merged.length,
      shortlisted: shortlist.length,
    },
  };
  await ctx.kv.set(keys.data(run.week, domain.id, "ingest"), ingest, DATA_TTL);

  // Spawn judge batches, then make `write` wait for them. Both happen before this job is marked done.
  const batches = Math.ceil(shortlist.length / BATCH_SIZE);
  const judgeIds: string[] = [];
  for (let b = 0; b < batches; b++) {
    const j: Job = { id: `judge:${domain.id}:${b}`, week: run.week, kind: "judge", domainId: domain.id, arg: b, deps: [job.id], status: "pending", attempts: 0, notBefore: 0 };
    judgeIds.push(j.id);
    await ctx.kv.set(keys.job(run.week, j.id), j, DATA_TTL);
  }
  await ctx.kv.set(keys.extra(run.week, domain.id), judgeIds, DATA_TTL);
  const write = await ctx.kv.get<Job>(keys.job(run.week, `write:${domain.id}`));
  if (write) await ctx.kv.set(keys.job(run.week, write.id), { ...write, deps: [job.id, ...judgeIds] }, DATA_TTL);
  return `${shortlist.length} shortlisted, ${batches} judge batches, ${alreadyCovered} already covered last week${missingDays ? `, ${missingDays} days missing` : ""}`;
};

const judgeJob: Handler = async (job, run, ctx) => {
  const domain = domainOf(run, job.domainId);
  const ingest = await ctx.kv.get<IngestResult>(keys.data(run.week, domain.id, "ingest"));
  if (!ingest) throw new Error("Ingest data missing");
  const slice = ingest.shortlist.slice(job.arg! * BATCH_SIZE, (job.arg! + 1) * BATCH_SIZE);
  const r = await judgePapers(slice, domain, ctx.llm, kvScoreCache(ctx.kv));
  return `${r.scores.size}/${slice.length} scored (${r.cacheHits} cached)`;
};

const finalSection = async (ctx: Ctx, run: Run, domain: Domain, res: SectionResult) =>
  ctx.kv.set(keys.data(run.week, domain.id, "section"), res, DATA_TTL);

/** Ranks in code, then drafts cards for the top papers. Quiet and degraded outcomes are finalised here. */
const writeJob: Handler = async (job, run, ctx) => {
  const domain = domainOf(run, job.domainId);
  const ingest = await ctx.kv.get<IngestResult>(keys.data(run.week, domain.id, "ingest"));
  if (!ingest) {
    await finalSection(ctx, run, domain, { section: noDataSection(domain), ranked: [], stats: { shortlisted: 0, scored: 0, unscored: 0, cacheHits: 0, passed: 0, degradedReason: "no ingest data" } });
    return "no data";
  }
  if (!ingest.shortlist.length) {
    await finalSection(ctx, run, domain, { section: quietSection(domain, "No papers matched this domain this week."), ranked: [], stats: { shortlisted: 0, scored: 0, unscored: 0, cacheHits: 0, passed: 0 } });
    return "quiet: nothing matched";
  }

  const cache = kvScoreCache(ctx.kv);
  const scored = (
    await Promise.all(ingest.shortlist.map(async (paper) => ({ paper, score: await cache.get(scoreKey(domain, paper.id)) })))
  ).flatMap((x) => (x.score ? [{ paper: x.paper, score: x.score }] : []));

  if (!scored.length) {
    await finalSection(ctx, run, domain, degradedScoringResult(domain, ingest.shortlist, "no scores were produced"));
    return "degraded: no scores";
  }

  const ranked = rankPapers(scored);
  const passed = ranked.filter((r) => r.passes);
  const stats = { shortlisted: ingest.shortlist.length, scored: scored.length, unscored: ingest.shortlist.length - scored.length, cacheHits: 0, passed: passed.length };

  if (!passed.length) {
    await finalSection(ctx, run, domain, { section: quietSection(domain, "Nothing cleared the significance threshold this week."), ranked, stats });
    return "quiet: nothing cleared the threshold";
  }

  const top = passed.slice(0, domain.maxPapers);
  // Saved BEFORE the model call, so if drafting fails the verify stage can still show ranked papers.
  await ctx.kv.set(keys.data(run.week, domain.id, "rank"), { ranked, topIds: top.map((t) => t.paper.id), stats } satisfies RankData, DATA_TTL);
  const drafts = await writeDrafts(top, domain, ctx.llm);
  await ctx.kv.set(keys.data(run.week, domain.id, "drafts"), drafts, DATA_TTL);
  return `${top.length} papers drafted`;
};

/** Fact-checks the drafts and builds the final cards. Falls back to extractive cards if drafting never succeeded. */
const verifyJob: Handler = async (job, run, ctx) => {
  const domain = domainOf(run, job.domainId);
  if (await ctx.kv.get(keys.data(run.week, domain.id, "section"))) return "already final";

  const rank = await ctx.kv.get<RankData>(keys.data(run.week, domain.id, "rank"));
  if (!rank) {
    const ingest = await ctx.kv.get<IngestResult>(keys.data(run.week, domain.id, "ingest"));
    await finalSection(ctx, run, domain, ingest ? degradedScoringResult(domain, ingest.shortlist, "ranking did not complete") : { section: noDataSection(domain), ranked: [], stats: { shortlisted: 0, scored: 0, unscored: 0, cacheHits: 0, passed: 0 } });
    return "degraded: no ranking";
  }
  const top = rank.topIds.flatMap((id) => rank.ranked.filter((r) => r.paper.id === id));
  const drafts = await ctx.kv.get<WrittenCard[]>(keys.data(run.week, domain.id, "drafts"));
  if (!drafts) {
    await finalSection(ctx, run, domain, { section: degradedWritingSection(domain, top), ranked: rank.ranked, stats: { ...rank.stats, degradedReason: "drafting failed" } });
    return "degraded: no drafts";
  }
  const { cards, stats: write } = await verifyAndBuild(top, drafts, ctx.llm);
  await finalSection(ctx, run, domain, { section: { domainId: domain.id, domainName: domain.name, featured: [], status: "ok", cards }, ranked: rank.ranked, stats: { ...rank.stats, write } });
  return `${cards.length} cards`;
};

/**
 * Adds the "what this week shows" takeaway. If the model call fails the job is retried; if the takeaway
 * fails a check it is simply left out. Either way the section itself is untouched and still published.
 */
const synthJob: Handler = async (job, run, ctx) => {
  const domain = domainOf(run, job.domainId);
  const key = keys.data(run.week, domain.id, "section");
  const res = await ctx.kv.get<SectionResult>(key);
  if (!res) return "skipped: no section";
  if (res.section.status !== "ok") return `skipped: section is ${res.section.status}`;
  if (res.section.takeaway) return "already done";
  const s = await synthesizeSection(res.section, res.ranked, domain, ctx.llm);
  if (!s.takeaway) return `no takeaway (${s.rejected})`;
  await ctx.kv.set(key, { ...res, section: { ...res.section, takeaway: s.takeaway, takeawayIds: s.ids } }, DATA_TTL);
  return `takeaway from ${s.ids.length} papers`;
};

/** Assembles and publishes the brief from whatever sections exist. Runs again if late sections arrive after the cutoff. */
const composeJob: Handler = async (_job, run, ctx) => {
  const inputs: DomainInput[] = [];
  const missing: string[] = [];
  for (const d of run.domains) {
    const res = await ctx.kv.get<SectionResult>(keys.data(run.week, d.id, "section"));
    if (!res) {
      missing.push(d.name);
      continue;
    }
    const ingest = await ctx.kv.get<IngestResult>(keys.data(run.week, d.id, "ingest"));
    inputs.push({ section: res.section, ranked: res.ranked, stale: ingest?.stale ?? false, papersSeen: ingest?.stats.afterDedupe ?? 0, papersScored: res.stats.scored });
  }
  if (!inputs.length) throw new Error("No domain produced a section, so there is nothing to publish");
  // Every domain degraded with zero papers means the data never arrived. A brief of empty "unavailable"
  // sections must not replace last week's real one, so fail loudly and leave the previous brief in place.
  // (A genuinely quiet week is different: those sections are "quiet", not degraded, and do publish.)
  if (inputs.every((i) => i.section.status === "degraded" && i.section.cards.length === 0)) {
    throw new Error("No domain produced any content (data sources unavailable); keeping the previous brief");
  }
  const brief = composeBrief(inputs, win(run), { missingDomains: missing, now: new Date(ctx.now()), coverageStart: coverageWindow(win(run)).start.toISOString() });
  await ctx.publish(brief);
  await ctx.kv.set(keys.data(run.week, "brief"), brief, DATA_TTL); // the email job reads it from here
  return missing.length ? `partial: missing ${missing.join(", ")}` : `published ${brief.meta.wordCount} words`;
};

/**
 * Emails the brief. Safe by construction:
 *  - Not configured (no key or recipient) means SKIP, never fail the week.
 *  - One email per week and variant (partial, full) is enforced by a guard taken BEFORE sending. If the send
 *    fails the guard is released so a retry can go through; Resend's Idempotency-Key stops a retry after an
 *    ambiguous timeout from delivering twice.
 *  - A partial brief is emailed at the cutoff, and a completed one follows once if late domains finish.
 */
const emailJob: Handler = async (_job, run, ctx) => {
  const brief = await ctx.kv.get<Brief>(keys.data(run.week, "brief"));
  if (!brief) return "skipped: no brief was published, so nothing to send";
  const cfg = ctx.emailConfig();
  if (!cfg.ready) return `skipped: ${cfg.reason}`;

  const variant = brief.isPartial ? "partial" : "full";
  const guard = `sent:${run.week}:${variant}`;
  if (!(await ctx.kv.setNx(guard, ctx.now(), DATA_TTL))) return `skipped: the ${variant} email was already sent`;

  const earlierPartial = variant === "full" && (await ctx.kv.get(`sent:${run.week}:partial`)) !== null;
  try {
    const mail = renderEmail(brief, cfg.appUrl, { updated: earlierPartial });
    const subject = (earlierPartial ? "Updated: " : "") + mail.subject;
    const { id } = await ctx.sendEmail(cfg, { from: cfg.from, to: cfg.to, subject, html: mail.html, text: mail.text, idempotencyKey: `${run.week}:${variant}` });
    await ctx.kv.set(`emaillog:${run.week}:${variant}`, { id, at: ctx.now(), recipients: cfg.to.length }, DATA_TTL);
    return `sent ${variant} email to ${cfg.to.length} recipient(s)`;
  } catch (e) {
    await ctx.kv.del(guard);
    throw e;
  }
};

export const HANDLERS: Record<Job["kind"], Handler> = {
  hf, fetch: fetchDay, prefilter: prefilterJob, judge: judgeJob, write: writeJob, verify: verifyJob, synth: synthJob, compose: composeJob, email: emailJob,
};
