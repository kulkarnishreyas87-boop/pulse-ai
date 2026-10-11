/** A reporting week: Monday 00:00 to Sunday 23:59:59 UTC. Defined once so "this week" is never ambiguous. */
export interface WeekWindow {
  week: string; // ISO week id, e.g. 2026-W41
  start: Date;
  end: Date;
}

const DAY = 86_400_000;

export function isoWeekId(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = t.getUTCDay() || 7; // Mon=1..Sun=7
  t.setUTCDate(t.getUTCDate() + 4 - dow); // Thursday of this ISO week decides the year
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const wk = Math.ceil(((t.getTime() - yearStart) / DAY + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(wk).padStart(2, "0")}`;
}

function mondayOf(d: Date): Date {
  const dow = d.getUTCDay() || 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - (dow - 1)));
}

/** The last fully completed Mon..Sun week before `now`. This is what a Monday-morning brief covers. */
export function lastCompletedWeek(now: Date = new Date()): WeekWindow {
  const start = new Date(mondayOf(now).getTime() - 7 * DAY);
  return windowFromStart(start);
}

/** Parse "2026-W41" into its window. */
export function parseWeekId(id: string): WeekWindow {
  const m = /^(\d{4})-W(\d{2})$/.exec(id);
  if (!m) throw new Error(`Bad week id: ${id} (expected like 2026-W41)`);
  const jan4 = new Date(Date.UTC(Number(m[1]), 0, 4));
  const start = new Date(mondayOf(jan4).getTime() + (Number(m[2]) - 1) * 7 * DAY);
  return windowFromStart(start);
}

function windowFromStart(start: Date): WeekWindow {
  const end = new Date(start.getTime() + 7 * DAY - 1000);
  return { week: isoWeekId(start), start, end };
}

/** arXiv submittedDate format: YYYYMMDDHHMM (GMT). */
export function arxivStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}

export function dayList(start: Date, count: number): string[] {
  return Array.from({ length: count }, (_, i) =>
    new Date(start.getTime() + i * DAY).toISOString().slice(0, 10),
  );
}
