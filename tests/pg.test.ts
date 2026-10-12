import { test, before } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { schemaSql, type Db } from "../lib/db/client";

// These tests query bare table names, so they run against the "public" schema of their in-process Postgres.
process.env.DB_SCHEMA = "public";
import { PgKv } from "../lib/db/pgkv";
import { loadBrief, loadDomains, loadLatestBrief, loadWeeks, replaceDomains, saveBrief } from "../lib/db/repo";
import { Brief, Domain } from "../lib/schema";

/** A real Postgres running in-process, so these tests exercise the actual SQL, not a mock of it. */
let pg: PGlite;
let db: Db;
before(async () => {
  pg = new PGlite();
  db = { query: async (t, p) => (await pg.query(t, p as any[])).rows as any[] };
  for (const s of schemaSql()) await db.query(s);
});

const fresh = async () => {
  await db.query("TRUNCATE kv");
  return db;
};

test("schema is idempotent: running it again changes nothing and loses no data", async () => {
  await fresh();
  const kv = new PgKv(db);
  await kv.set("keep", { a: 1 });
  for (const s of schemaSql()) await db.query(s);
  assert.deepEqual(await kv.get("keep"), { a: 1 });
});

test("PgKv: JSON round-trips for objects, arrays, strings, numbers and booleans", async () => {
  const kv = new PgKv(await fresh());
  const v = { x: [1, 2, { y: "z", n: null }], s: "it's \"quoted\" \\ back", t: true, big: 12345678901 };
  await kv.set("obj", v);
  assert.deepEqual(await kv.get("obj"), v);
  await kv.set("str", "lease-owner-7");
  await kv.set("num", 42);
  await kv.set("arr", [1, "a"]);
  assert.equal(await kv.get("str"), "lease-owner-7");
  assert.equal(await kv.get("num"), 42);
  assert.deepEqual(await kv.get("arr"), [1, "a"]);
  assert.equal(await kv.get("missing"), null);
  await kv.del("obj");
  assert.equal(await kv.get("obj"), null);
});

test("PgKv: keys with odd characters are safe (no SQL injection through a key)", async () => {
  const kv = new PgKv(await fresh());
  const k = `data:2026-W40:cv-industrial:day3 /?&=%'; DROP TABLE kv; --`;
  await kv.set(k, 1);
  assert.equal(await kv.get(k), 1);
  await kv.set("still-here", 2);
  assert.equal(await kv.get("still-here"), 2, "the table survived");
});

test("PgKv: mget preserves order and returns null for gaps, across chunk boundaries", async () => {
  const kv = new PgKv(await fresh());
  await kv.set("k1", 1);
  await kv.set("k3", 3);
  assert.deepEqual(await kv.mget(["k1", "k2", "k3"]), [1, null, 3]);
  const many = Array.from({ length: 450 }, (_, i) => `bulk:${i}`);
  for (const k of many.filter((_, i) => i % 50 === 0)) await kv.set(k, k);
  const got = await kv.mget<string>(many);
  assert.equal(got.length, 450);
  assert.equal(got[0], "bulk:0");
  assert.equal(got[1], null);
  assert.equal(got[400], "bulk:400");
  assert.deepEqual(await kv.mget([]), []);
});

test("PgKv: setNx has exactly one winner under a real concurrent race", async () => {
  const kv = new PgKv(await fresh());
  const results = await Promise.all(Array.from({ length: 16 }, (_, i) => kv.setNx("lease:job", `w${i}`, 60)));
  assert.equal(results.filter(Boolean).length, 1, "exactly one worker gets the lease");
  assert.equal(await kv.setNx("lease:job", "late", 60), false);
  const owner = await kv.get<string>("lease:job");
  assert.match(owner!, /^w\d+$/);
  assert.equal(results.indexOf(true), Number(owner!.slice(1)), "the stored owner is the winner");
});

test("PgKv: entries expire, and an expired lease can be taken over, but a live one cannot", async () => {
  let t = Date.parse("2026-10-05T00:00:00Z");
  const kv = new PgKv(await fresh(), () => t);
  await kv.set("tmp", "v", 10);
  assert.equal(await kv.setNx("lease", "w1", 10), true);
  t += 5_000;
  assert.equal(await kv.setNx("lease", "w2", 10), false, "still live at +5s");
  assert.equal(await kv.get("tmp"), "v");
  t += 6_000;
  assert.equal(await kv.get("tmp"), null, "expired at +11s");
  assert.equal(await kv.setNx("lease", "w2", 10), true, "taken over after expiry");
  assert.equal(await kv.get("lease"), "w2");
  await kv.set("forever", "x"); // no TTL
  t += 10 * 365 * 86_400_000;
  assert.equal(await kv.get("forever"), "x");
});

test("PgKv: sweep removes long-expired rows only", async () => {
  let t = Date.parse("2026-10-05T00:00:00Z");
  const kv = new PgKv(await fresh(), () => t);
  await kv.set("old", 1, 10);
  await kv.set("fresh", 1, 10);
  await kv.set("forever", 1);
  t += 2 * 86_400_000;
  await kv.set("fresh", 1, 10); // re-set recently
  assert.equal(await kv.sweep(), 1);
  assert.equal(await kv.get("forever"), 1);
  assert.equal(await kv.get("fresh"), 1);
});

const brief = (week: string, start: string, extra: object = {}): Brief =>
  Brief.parse({ week, windowStart: start, windowEnd: start, generatedAt: start, topThree: [], sections: [], ...extra });

test("briefs: upsert is idempotent, 'latest' is the newest window, and re-running an old week cannot hide this week", async () => {
  await db.query("TRUNCATE briefs");
  await saveBrief(db, brief("2026-W39", "2026-09-21T00:00:00.000Z"));
  await saveBrief(db, brief("2026-W40", "2026-09-28T00:00:00.000Z", { isPartial: true }));
  assert.equal(((await loadLatestBrief(db)) as any).week, "2026-W40");
  await saveBrief(db, brief("2026-W40", "2026-09-28T00:00:00.000Z", { isPartial: false })); // recompose
  assert.equal(((await loadBrief(db, "2026-W40")) as any).isPartial, false, "overwritten, not duplicated");
  await saveBrief(db, brief("2026-W39", "2026-09-21T00:00:00.000Z", { isStale: true })); // an old week re-run later
  assert.equal(((await loadLatestBrief(db)) as any).week, "2026-W40", "latest still this week");
  assert.deepEqual(await loadWeeks(db), ["2026-W40", "2026-W39"]);
  assert.equal(await loadBrief(db, "2026-W01"), null);
  assert.equal(await loadLatestBrief((await (async () => { await db.query("TRUNCATE briefs"); return db; })())), null);
});

test("briefs: the full document survives storage exactly", async () => {
  await db.query("TRUNCATE briefs");
  const b = brief("2026-W40", "2026-09-28T00:00:00.000Z", {
    topThree: [{ arxivId: "2609.1", title: "Ünïcode ✓ \"q\" <b>", authors: "A", url: "u", whyItMatters: "w", summary: "s", verdict: "read", clientAngle: "c", caveats: "k", confidence: "p" }],
  });
  await saveBrief(db, b);
  assert.deepEqual(Brief.parse(await loadLatestBrief(db)), b);
});

test("domains: ordered, upsert, and removed ones disappear", async () => {
  await db.query("TRUNCATE domains");
  const d = (id: string, name: string) => Domain.parse({ id, name, keywords: ["abc def"] });
  await replaceDomains(db, [d("a", "Alpha"), d("b", "Beta"), d("c", "Gamma")]);
  assert.deepEqual((await loadDomains(db)).map((x: any) => x.id), ["a", "b", "c"]);
  await replaceDomains(db, [d("c", "Gamma renamed"), d("a", "Alpha")]); // reorder, rename, remove b
  const rows = (await loadDomains(db)) as any[];
  assert.deepEqual(rows.map((x) => x.id), ["c", "a"]);
  assert.equal(rows[0].name, "Gamma renamed");
});
