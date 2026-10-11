import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileKv, MemoryKv, type Kv } from "../lib/jobs/kv";
import { checkCron } from "../lib/admin";

/** The queue's correctness rests on these few behaviours, so every backend must satisfy the same contract. */
function contract(name: string, make: (now: () => number) => { kv: Kv; cleanup?: () => void }) {
  test(`${name}: get/set/del round-trip JSON and missing keys are null`, async () => {
    const { kv, cleanup } = make(() => 0);
    assert.equal(await kv.get("nope"), null);
    await kv.set("a", { x: [1, 2, { y: "z" }] });
    assert.deepEqual(await kv.get("a"), { x: [1, 2, { y: "z" }] });
    await kv.del("a");
    assert.equal(await kv.get("a"), null);
    cleanup?.();
  });

  test(`${name}: keys with odd characters are safe`, async () => {
    const { kv, cleanup } = make(() => 0);
    const k = "data:2026-W40:cv-industrial:day3 /?&=%";
    await kv.set(k, 1);
    assert.equal(await kv.get(k), 1);
    cleanup?.();
  });

  test(`${name}: mget preserves order and returns null for gaps`, async () => {
    const { kv, cleanup } = make(() => 0);
    await kv.set("k1", 1);
    await kv.set("k3", 3);
    assert.deepEqual(await kv.mget(["k1", "k2", "k3"]), [1, null, 3]);
    cleanup?.();
  });

  test(`${name}: setNx is exclusive, even under a race`, async () => {
    const { kv, cleanup } = make(() => 0);
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => kv.setNx("lock", i, 60)));
    assert.equal(results.filter(Boolean).length, 1, "exactly one winner");
    assert.equal(await kv.setNx("lock", "late", 60), false);
    cleanup?.();
  });

  test(`${name}: entries expire, and an expired lock can be taken again`, async () => {
    let t = 1_000;
    const { kv, cleanup } = make(() => t);
    await kv.set("tmp", "v", 10);
    assert.equal(await kv.get("tmp"), "v");
    assert.equal(await kv.setNx("lease", "w1", 10), true);
    t += 11_000;
    assert.equal(await kv.get("tmp"), null, "expired");
    assert.equal(await kv.setNx("lease", "w2", 10), true, "lease re-claimable after expiry");
    assert.equal(await kv.get("lease"), "w2");
    cleanup?.();
  });
}

contract("MemoryKv", (now) => ({ kv: new MemoryKv(now) }));
contract("FileKv", (now) => {
  const dir = mkdtempSync(join(tmpdir(), "rp-kv-"));
  return { kv: new FileKv(dir, now), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
});

test("cron auth: bearer secret required in production, open only in development", () => {
  const h = (v?: string) => new Headers(v ? { authorization: v } : {});
  assert.equal(checkCron(h("Bearer s3"), { secret: "s3", production: true }).ok, true);
  assert.equal(checkCron(h("Bearer nope"), { secret: "s3", production: true }).status, 401);
  assert.equal(checkCron(h(), { secret: "s3", production: true }).status, 401);
  assert.equal(checkCron(h("s3"), { secret: "s3", production: true }).ok, false, "must be a Bearer token");
  assert.equal(checkCron(h(), { secret: undefined, production: true }).status, 503, "no secret in production = locked");
  assert.equal(checkCron(h(), { secret: undefined, production: false }).ok, true);
});
