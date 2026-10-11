import { isoWeekId, parseWeekId, type WeekWindow } from "./week";

/**
 * Why a run looks back before its week.
 *
 * arXiv makes papers public in nightly batches, not when they are submitted. Anything submitted after
 * Thursday afternoon (US Eastern) is only published on Monday evening US time, which is AFTER a Monday
 * morning run. Measured live on Sunday 11 Oct 2026 16:05 UTC: 232 and 237 cs.AI papers were visible for
 * that Wednesday and Thursday, and 0 for Friday, Saturday and Sunday.
 *
 * A fixed Monday-to-Sunday window would therefore never show those late-week papers: they would be
 * invisible on this Monday and outside next Monday's window. So each run fetches LOOKBACK_DAYS before
 * its week as well, and skips papers an earlier run already considered. Every paper is considered
 * exactly once, in the first run after it became public.
 */
export const LOOKBACK_DAYS = 3;
export const FETCH_DAYS = 7 + LOOKBACK_DAYS;
const DAY = 86_400_000;

/** The submission dates a run fetches: its week plus the lookback. */
export function coverageWindow(win: WeekWindow): WeekWindow {
  return { week: win.week, start: new Date(win.start.getTime() - LOOKBACK_DAYS * DAY), end: win.end };
}

/** Fetch job `arg` (0..FETCH_DAYS-1) to a day offset from the week's Monday (-3..6). */
export const dayOffset = (arg: number) => arg - LOOKBACK_DAYS;

/** Key holding the ids of every paper a run considered for a domain. */
export const seenKey = (week: string, domainId: string) => `seenrun:${week}:${domainId}`;
export const SEEN_TTL = 60 * 60 * 24 * 45;

/** The weeks whose runs could overlap this one's lookback. Two, to be safe if a week's run was late. */
export function previousWeeks(week: string, n = 2): string[] {
  const start = parseWeekId(week).start.getTime();
  return Array.from({ length: n }, (_, i) => isoWeekId(new Date(start - (i + 1) * 7 * DAY)));
}
