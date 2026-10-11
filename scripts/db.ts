/**
 * Database CLI (Neon Postgres). Needs DATABASE_URL in .env.local.
 *   npm run db -- migrate                  create the tables (safe to run any time)
 *   npm run db -- status                   row counts and the latest brief
 *   npm run db -- import-brief 2026-W40    load .cache/brief-<week>.json into the briefs table
 *   npm run db -- import-domains           load the starter domains into the domains table
 */
import { readFileSync } from "node:fs";
import { Brief } from "../lib/schema";
import { requireDb, databaseUrl } from "../lib/db/client";
import { saveBrief, loadWeeks, replaceDomains, loadDomains } from "../lib/db/repo";
import { defaultDomains } from "../lib/domains";

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (!databaseUrl()) throw new Error("DATABASE_URL is not set. Add your Neon connection string to .env.local.");
  const d = await requireDb(); // creates the tables if missing

  if (cmd === "migrate" || cmd === undefined) {
    console.log("Tables ready: kv, briefs, domains.");
  } else if (cmd === "status") {
    const count = async (t: string) => Number((await d.query(`SELECT count(*)::int AS n FROM ${t}`))[0].n);
    console.log(`kv rows: ${await count("kv")}, briefs: ${await count("briefs")}, domains: ${await count("domains")}`);
    console.log("weeks:", (await loadWeeks(d)).join(", ") || "(none)");
    console.log("domains:", (await loadDomains(d)).map((x: any) => x.name).join(", ") || "(none; the app uses the built-in starter domains)");
  } else if (cmd === "import-brief") {
    if (!arg) throw new Error("Usage: npm run db -- import-brief 2026-W40");
    const brief = Brief.parse(JSON.parse(readFileSync(`.cache/brief-${arg}.json`, "utf8")));
    await saveBrief(d, brief);
    console.log(`Imported ${brief.week} (${brief.meta.wordCount} words) into the briefs table.`);
  } else if (cmd === "import-domains") {
    await replaceDomains(d, defaultDomains);
    console.log(`Imported ${defaultDomains.length} starter domains.`);
  } else {
    throw new Error(`Unknown command "${cmd}". Use migrate, status, import-brief or import-domains.`);
  }
}

main().catch((e) => {
  console.error(String(e instanceof Error ? e.message : e));
  process.exit(1);
});
