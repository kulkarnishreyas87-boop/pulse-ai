/**
 * Proxy evaluation: does the brief catch the papers the research community itself flagged?
 *   DB_SCHEMA=dev npm run proxy-eval -- --week 2026-W41 --compare public
 *
 * Ground truth (a PROXY, not human labels): papers submitted in the week that
 *   - got >= MIN_UPVOTES on Hugging Face Daily Papers (community attention), and
 *   - are on-topic for the domain by meaning (embedding similarity in the top 10% of that week's papers).
 * Neither signal is what decides whether a paper passes the quality bar (keywords are not used here, and
 * attention only orders papers that already passed), so this is an independent check on recall.
 *
 * For each domain it reports how many of those papers reached the shortlist, passed, and were shown,
 * for the run in DB_SCHEMA and, with --compare, for the run stored in another schema (e.g. the old one).
 * Read-only: it never writes.
 */
import { requireDb, type Db } from "../lib/db/client";
import { FETCH_DAYS } from "../lib/coverage";
import { parseWeekId } from "../lib/week";

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const MIN_UPVOTES = Number(arg("min-upvotes") ?? 10);
const ON_TOPIC_PERCENTILE = 0.9;

async function kvGet(d: Db, schema: string, key: string) {
  const rows = await d.query(`SELECT value FROM "${schema}".kv WHERE key = $1`, [key]);
  return rows[0]?.value ?? null;
}

async function systemView(d: Db, schema: string, week: string, domain: string) {
  const ingest: any = await kvGet(d, schema, `data:${week}:${domain}:ingest`);
  const section: any = await kvGet(d, schema, `data:${week}:${domain}:section`);
  const brief: any = (await d.query(`SELECT brief FROM "${schema}".briefs WHERE week = $1`, [week]))[0]?.brief;
  const shown = new Set<string>(brief ? [...brief.topThree, ...brief.sections.flatMap((s: any) => s.cards)].map((c: any) => c.arxivId) : []);
  return {
    shortlist: new Set<string>((ingest?.shortlist ?? []).map((p: any) => p.id)),
    passed: new Set<string>((section?.ranked ?? []).filter((r: any) => r.passes).map((r: any) => r.paper.id)),
    shown,
    exists: Boolean(ingest),
  };
}

async function main() {
  const week = arg("week");
  if (!week) throw new Error("Usage: npm run proxy-eval -- --week 2026-W41 [--compare public]");
  const schema = process.env.DB_SCHEMA || "dev";
  const compare = arg("compare");
  const win = parseWeekId(week);
  const d = await requireDb();

  const run: any = await kvGet(d, schema, `run:${week}`);
  if (!run) throw new Error(`No run for ${week} in schema "${schema}"`);
  const hf: any = await kvGet(d, schema, `data:${week}:hf`);
  const upvotes = new Map<string, number>((hf?.signals ?? []).map(([id, s]: [string, any]) => [id, s.upvotes ?? 0]));

  console.log(`Proxy evaluation for ${week}. Ground truth: on-topic (top ${Math.round((1 - ON_TOPIC_PERCENTILE) * 100)}% by meaning) papers with >= ${MIN_UPVOTES} Hugging Face upvotes, submitted ${win.start.toISOString().slice(0, 10)} to ${win.end.toISOString().slice(0, 10)}.\n`);
  const totals: Record<string, { truth: number; shortlist: number; passed: number; shown: number }> = {};
  for (const dom of run.domains) {
    // the candidate pool of the evaluated run, with similarities
    const days = await Promise.all(Array.from({ length: FETCH_DAYS }, (_, i) => kvGet(d, schema, `data:${week}:${dom.id}:day${i}`)));
    const simMaps = await Promise.all(Array.from({ length: FETCH_DAYS }, (_, i) => kvGet(d, schema, `data:${week}:${dom.id}:sim${i}`)));
    const sim = new Map<string, number>(simMaps.flatMap((m: any) => Object.entries(m ?? {})) as [string, number][]);
    const pool = new Map<string, any>();
    for (const day of days) for (const p of (day as any[]) ?? []) pool.set(p.id, p);
    const sims = [...sim.values()].sort((a, b) => a - b);
    const cutoff = sims.length ? sims[Math.floor(ON_TOPIC_PERCENTILE * (sims.length - 1))] : Infinity;
    const truth = [...pool.values()].filter(
      (p) => (upvotes.get(p.id) ?? 0) >= MIN_UPVOTES && (sim.get(p.id) ?? -1) >= cutoff && new Date(p.published) >= win.start && new Date(p.published) <= win.end,
    );

    const systems: [string, string][] = [["new", schema], ...(compare ? [["old", compare] as [string, string]] : [])];
    console.log(`${dom.name}: ${pool.size} papers in the pool, ${truth.length} community-flagged on-topic paper(s)`);
    for (const [label, sch] of systems) {
      const v = await systemView(d, sch, week, dom.id);
      if (!v.exists) {
        console.log(`   ${label.padEnd(3)} (${sch}): no run data`);
        continue;
      }
      const c = { truth: truth.length, shortlist: truth.filter((p) => v.shortlist.has(p.id)).length, passed: truth.filter((p) => v.passed.has(p.id)).length, shown: truth.filter((p) => v.shown.has(p.id)).length };
      const t = (totals[label] ??= { truth: 0, shortlist: 0, passed: 0, shown: 0 });
      t.truth += c.truth; t.shortlist += c.shortlist; t.passed += c.passed; t.shown += c.shown;
      console.log(`   ${label.padEnd(3)} (${sch}): shortlisted ${c.shortlist}/${c.truth}, passed the bar ${c.passed}/${c.truth}, shown ${c.shown}/${c.truth}`);
    }
    for (const p of truth.slice(0, 5)) console.log(`      - [${upvotes.get(p.id)} upvotes] ${p.title.slice(0, 90)}`);
  }
  const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "n/a");
  console.log("\nOverall (recall against the community proxy):");
  for (const [label, t] of Object.entries(totals)) {
    console.log(`   ${label}: shortlist ${pct(t.shortlist, t.truth)} (${t.shortlist}/${t.truth}), passed ${pct(t.passed, t.truth)}, shown ${pct(t.shown, t.truth)}`);
  }
}

main().catch((e) => {
  console.error(String(e instanceof Error ? e.message : e).replace(/postgres(ql)?:\/\/\S+/g, "[database url]"));
  process.exit(1);
});
