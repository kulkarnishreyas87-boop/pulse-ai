import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Brief } from "../lib/schema";
import { MAX_SAVED, parseSaved, toSaved, toggleSaved } from "../lib/saved";

const sample = Brief.parse(JSON.parse(readFileSync(join(import.meta.dirname, "..", "data", "seed", "brief.json"), "utf8")));
const s = sample.sections[0];
const card = s.cards[0] ?? sample.topThree[0];
const ctx = { week: sample.week, domainId: s.domainId, domainName: s.domainName };

test("saved: saving keeps what the reader needs later (title, link, why, domain, week)", () => {
  const a = toSaved(card, ctx, new Date("2026-10-12T08:00:00Z"));
  assert.equal(a.arxivId, card.arxivId);
  assert.equal(a.url, card.url);
  assert.equal(a.whyItMatters, card.whyItMatters);
  assert.equal(a.domainId, s.domainId);
  assert.equal(a.week, sample.week);
  assert.equal(a.savedAt, "2026-10-12T08:00:00.000Z");
});

test("saved: the button toggles: save, then save again removes it", () => {
  const a = toSaved(card, ctx);
  const once = toggleSaved([], a);
  assert.equal(once.length, 1);
  assert.deepEqual(toggleSaved(once, a), []);
});

test("saved: newest first, never duplicated, and bounded", () => {
  const mk = (i: number) => ({ ...toSaved(card, ctx), arxivId: `2610.${String(i).padStart(5, "0")}` });
  let list: ReturnType<typeof toSaved>[] = [];
  for (let i = 0; i < MAX_SAVED + 5; i++) list = toggleSaved(list, mk(i));
  assert.equal(list.length, MAX_SAVED);
  assert.equal(list[0].arxivId, mk(MAX_SAVED + 4).arxivId, "newest first");
  assert.equal(new Set(list.map((a) => a.arxivId)).size, list.length);
});

test("saved: corrupted or tampered storage is ignored rather than breaking the page", () => {
  assert.deepEqual(parseSaved(null), []);
  assert.deepEqual(parseSaved("not json"), []);
  assert.deepEqual(parseSaved('{"a":1}'), []);
  const good = toSaved(card, ctx);
  const evil = { ...good, arxivId: "x", url: "javascript:alert(1)" };
  const parsed = parseSaved(JSON.stringify([good, evil, null, { title: 3 }]));
  assert.deepEqual(parsed.map((a) => a.arxivId), [good.arxivId], "only well-formed https links survive");
});
