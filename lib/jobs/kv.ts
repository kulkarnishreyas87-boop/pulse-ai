import { lazyDb } from "../db/client";
import { PgKv } from "../db/pgkv";

/**
 * The few storage operations the job queue needs. Keeping it this small is deliberate: the same queue
 * logic runs on Neon Postgres in production and on memory or a local file in tests and development.
 * `setNx` (set only if absent, with expiry) is the one atomic primitive; it is what makes job claiming safe.
 */
export interface Kv {
  get<T>(key: string): Promise<T | null>;
  mget<T>(keys: string[]): Promise<(T | null)[]>;
  set(key: string, value: unknown, ttlSec?: number): Promise<void>;
  setNx(key: string, value: unknown, ttlSec: number): Promise<boolean>;
  del(key: string): Promise<void>;
}

export class MemoryKv implements Kv {
  private m = new Map<string, { v: string; exp: number }>();
  constructor(private now: () => number = Date.now) {}
  private live(key: string) {
    const e = this.m.get(key);
    if (!e) return null;
    if (e.exp && e.exp <= this.now()) {
      this.m.delete(key);
      return null;
    }
    return e;
  }
  async get<T>(key: string) {
    const e = this.live(key);
    return e ? (JSON.parse(e.v) as T) : null;
  }
  async mget<T>(keys: string[]) {
    return Promise.all(keys.map((k) => this.get<T>(k)));
  }
  async set(key: string, value: unknown, ttlSec = 0) {
    this.m.set(key, { v: JSON.stringify(value), exp: ttlSec ? this.now() + ttlSec * 1000 : 0 });
  }
  async setNx(key: string, value: unknown, ttlSec: number) {
    if (this.live(key)) return false;
    await this.set(key, value, ttlSec);
    return true;
  }
  async del(key: string) {
    this.m.delete(key);
  }
}

/**
 * Local development only: one JSON file per key under a directory, so a real week of data (tens of MB)
 * is not rewritten on every small update. Claiming uses an exclusive create, which is atomic on a
 * single machine. Not for production or for several machines.
 */
export class FileKv implements Kv {
  constructor(private dir: string, private now: () => number = Date.now) {}
  private async path(key: string) {
    const { join } = await import("node:path");
    return join(this.dir, encodeURIComponent(key).replace(/%/g, "_") + ".json");
  }
  private async read(key: string): Promise<{ v: unknown; exp: number } | null> {
    try {
      const { readFile } = await import("node:fs/promises");
      const e = JSON.parse(await readFile(await this.path(key), "utf8"));
      if (e.exp && e.exp <= this.now()) return null;
      return e;
    } catch {
      return null;
    }
  }
  async get<T>(key: string) {
    return ((await this.read(key))?.v as T) ?? null;
  }
  async mget<T>(keys: string[]) {
    return Promise.all(keys.map((k) => this.get<T>(k)));
  }
  async set(key: string, value: unknown, ttlSec = 0) {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(this.dir, { recursive: true });
    await writeFile(await this.path(key), JSON.stringify({ v: value, exp: ttlSec ? this.now() + ttlSec * 1000 : 0 }));
  }
  async setNx(key: string, value: unknown, ttlSec: number) {
    const { mkdir, writeFile, unlink } = await import("node:fs/promises");
    await mkdir(this.dir, { recursive: true });
    const p = await this.path(key);
    const body = JSON.stringify({ v: value, exp: ttlSec ? this.now() + ttlSec * 1000 : 0 });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await writeFile(p, body, { flag: "wx" });
        return true;
      } catch {
        if (await this.read(key)) return false; // exists and still live
        await unlink(p).catch(() => {}); // expired: clear it and try once more
      }
    }
    return false;
  }
  async del(key: string) {
    const { unlink } = await import("node:fs/promises");
    await unlink(await this.path(key)).catch(() => {});
  }
}

let dev: Kv | undefined;
/** Neon Postgres when DATABASE_URL is set; a local directory in development; an error in production (a queue with no storage cannot work). */
export function defaultKv(): Kv {
  const d = lazyDb();
  if (d) return new PgKv(d);
  if (process.env.NODE_ENV === "production") throw new Error("DATABASE_URL is not configured, so the job queue cannot run.");
  return (dev ??= new FileKv(`${process.cwd()}/.cache/kv`));
}
