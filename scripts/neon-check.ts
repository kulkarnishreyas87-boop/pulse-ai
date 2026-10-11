/**
 * Proves the queue's storage contract against the REAL Neon database (not the in-process test Postgres).
 *   npm run neon-check
 * Uses throwaway keys under "neoncheck:" and deletes them afterwards. Touches no real data.
 */
import { requireDb } from "../lib/db/client";
import { PgKv } from "../lib/db/pgkv";
import { isDeepStrictEqual } from "node:util";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
  if (!ok) failures++;
};

async function main() {
  const d = await requireDb();
  const P = `neoncheck:${Date.now()}:`;
  const kv = new PgKv(d);
  try {
    const v = { s: "it's \"quoted\" ✓", n: 12345678901, a: [1, { b: null }], t: true };
    await kv.set(P + "obj", v);
    // jsonb stores object keys in its own order, so compare values, not serialised strings
    check("JSON round-trip (unicode, quotes, nesting, big number)", isDeepStrictEqual(await kv.get(P + "obj"), v));
    await kv.set(P + "str", "owner-7");
    check("plain string value", (await kv.get(P + "str")) === "owner-7");

    const keys = [P + "obj", P + "missing", P + "str"];
    const got = await kv.mget(keys);
    check("mget with an array parameter keeps order and gaps", got[1] === null && got[2] === "owner-7" && (got[0] as any)?.n === 12345678901);

    const t0 = Date.now();
    const racers = await Promise.all(Array.from({ length: 12 }, (_, i) => new PgKv(d, () => t0).setNx(P + "lease", `w${i}`, 60)));
    check("atomic claim: 12 concurrent requests over HTTP, exactly one winner", racers.filter(Boolean).length === 1, `${racers.filter(Boolean).length} winner(s)`);

    const later = new PgKv(d, () => t0 + 61_000);
    check("an expired lease can be taken over", await later.setNx(P + "lease", "rescuer", 60));
    check("a live lease cannot", !(await later.setNx(P + "lease", "intruder", 60)));

    await new PgKv(d, () => t0).set(P + "ttl", 1, 5);
    check("expired rows are invisible", (await new PgKv(d, () => t0 + 6_000).get(P + "ttl")) === null);

    const tables = (await d.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`)).map((r) => r.table_name);
    check("tables present", ["briefs", "domains", "kv"].every((t) => tables.includes(t)), tables.join(", "));
  } finally {
    const del = await d.query(`DELETE FROM kv WHERE key LIKE $1 RETURNING key`, [P + "%"]);
    console.log(`cleaned up ${del.length} test rows`);
  }
  console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll Neon checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(String(e instanceof Error ? e.message : e).replace(/postgres(ql)?:\/\/\S+/g, "[database url]"));
  process.exit(1);
});
