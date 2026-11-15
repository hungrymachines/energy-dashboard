// Pure badge + streak logic for the gamification section (US-MET-027).
//
// Side-effect-free and DOM-free so it unit-tests without a render harness. The
// brand forbids hype (design plan §8): this is "instrumentation that happens to
// be competitive", closer to a power meter than a mobile game. Every badge is a
// verifiable fact with a one-line "how this was measured", and every metric is
// derived from data the EXISTING summary / rankings / daily routes already
// return — no new endpoint.
//
// Honesty rules carried from the rest of the metrics surface:
//  - A badge is only ever awarded when the data proves it. Missing inputs mean
//    "not earned" (conservative), never a fabricated award.
//  - Streaks are stated factually and bounded to a rolling window, never
//    all-time (which would permanently lock out new customers — plan §8/§10).

import type { MetricsSummary } from '../api/me-metrics.js';
import type { DailyEntry } from '../api/me-metrics.js';

/** A day idles clean through the three priciest hours when all 6 of those slots
 *  are idle: 6 slots × 0.5 h = 3.0 h. Mirrors the backend TOP_PEAK_SLOTS cut. */
export const MAX_TOP_PEAK_IDLE_HOURS_PER_DAY = 3.0;
/** Peak Dodger looks at the last three days — recent behaviour, not a month-long
 *  record a new customer can't touch and a long-timer can't lose. */
export const PEAK_DODGER_DAYS = 3;
/** Top half = at or above the 50th percentile of comparable homes. */
export const ABOVE_MEDIAN_PERCENTILE = 50;
/** Full House universe — every machine type a home can connect (mirrors the
 *  MetricsTab coverage ladder). Full House = every one of these reporting. */
export const MACHINE_TYPES = [
  'hvac',
  'water_heater',
  'ev_charger',
  'home_battery',
  'solar',
] as const;

const EPS = 1e-6;

export type BadgeKey = 'peak_dodger' | 'full_house' | 'room_to_move';

export interface Badge {
  key: BadgeKey;
  name: string;
  earned: boolean;
  /** The one-line "how this was measured" — calm, factual, no hype. */
  measured: string;
}

/**
 * Peak Dodger — no energy used in the THREE priciest hours, on each of the last
 * three days.
 *
 * Read off the per-day series rather than the windowed summary, because a sum
 * cannot prove a per-day fact: 9.0 h of idle across the window is equally
 * consistent with three perfect days and with one perfect day plus scattered
 * hours. So this walks the three most recent CONSECUTIVE calendar days ending at
 * the newest day the rollup has, and requires each to sit at the full
 * MAX_TOP_PEAK_IDLE_HOURS_PER_DAY.
 *
 * Anchored on the newest day in the series, not on the browser's today — the
 * rollup runs after midnight UTC for the day that just ended, so "today" never
 * has a row and anchoring there would make the badge permanently unearnable.
 *
 * A missing day, a calendar gap, or a null metric (untrusted meter, flat rate)
 * all mean "not earned" — the conservative call, never a fabricated award.
 */
export function peakDodgerEarned(days: DailyEntry[]): boolean {
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  if (sorted.length < PEAK_DODGER_DAYS) return false;

  const recent = sorted.slice(-PEAK_DODGER_DAYS);
  let nextDay: number | null = null; // the more-recent day already accepted
  for (let i = recent.length - 1; i >= 0; i--) {
    const entry = recent[i];
    const idle = entry.peaks.top_peak_hours_idle;
    if (idle === null || idle < MAX_TOP_PEAK_IDLE_HOURS_PER_DAY - EPS) return false;
    const stamp = parseDay(entry.date);
    if (stamp === null) return false;
    if (nextDay !== null && Math.round((nextDay - stamp) / MS_PER_DAY) !== 1) {
      return false; // a gap — these are not three consecutive days
    }
    nextDay = stamp;
  }
  return true;
}

/**
 * Full House — every machine type connected and reporting. Derived from
 * `machines.by_type`, which the summary builds only from ACTIVE (reporting)
 * appliances, so a positive count for all MACHINE_TYPES means the whole set is
 * live. A "full house" is the complete set, so this is deliberately all types,
 * not merely "more than one".
 */
export function fullHouseEarned(summary: MetricsSummary): boolean {
  const byType = summary.machines.by_type;
  return MACHINE_TYPES.every((t) => (byType[t] ?? 0) > 0);
}

/**
 * Room to Move — flexibility in the TOP HALF of comparable homes: the caller's
 * flexibility ranking sits at or above the 50th percentile.
 *
 * Flexibility alone, by design decision (Aug 4 2026). This badge previously
 * required comfort ≥ 95% as well, on the reasoning that rewarding flexibility
 * by itself reads as "sacrifice comfort, win more". That pairing is dropped
 * here; comfort is still reported next to flexibility on the metrics tile, so
 * the two numbers stay visible together even though the badge no longer binds
 * them.
 *
 * A null percentile (rankings unavailable, or the cohort has no distribution
 * yet) means NOT earned — never a fabricated award.
 */
export function roomToMoveEarned(flexibilityPercentile: number | null): boolean {
  if (flexibilityPercentile === null) return false;
  return flexibilityPercentile >= ABOVE_MEDIAN_PERCENTILE;
}

/** The three badges with their earned state + measurement lines. `summary` is
 *  required; `days` (the daily series) drives Peak Dodger and is an empty list
 *  when that fetch failed; `flexibilityPercentile` (from the rankings route) is
 *  null when rankings are unavailable, which only affects Steady Hand. */
export function computeBadges(
  summary: MetricsSummary,
  flexibilityPercentile: number | null,
  days: DailyEntry[] = [],
): Badge[] {
  return [
    {
      key: 'peak_dodger',
      name: 'Peak Dodger',
      earned: peakDodgerEarned(days),
      measured:
        'Measured by using no energy during the three priciest hours of the day, on each of the last three days.',
    },
    {
      key: 'full_house',
      name: 'Full House',
      earned: fullHouseEarned(summary),
      measured:
        'Measured when every machine type — HVAC, water heater, EV charger, home battery, and solar — is connected and reporting.',
    },
    {
      key: 'room_to_move',
      name: 'Room to Move',
      earned: roomToMoveEarned(flexibilityPercentile),
      measured:
        'Measured by giving the optimizer more comfort range to work with than at least half of comparable homes.',
    },
  ];
}

/** Median of a numeric list (average of the two middle values for an even
 *  count). Empty → null. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/** Parse an ISO YYYY-MM-DD as a UTC calendar day (avoids local-tz drift when
 *  comparing adjacency). Invalid → null. */
function parseDay(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(t) ? null : t;
}

const MS_PER_DAY = 86_400_000;

export interface SavingsStreak {
  /** Consecutive most-recent calendar days with savings above the window median. */
  days: number;
  /** The window median savings_pct the streak is measured against, or null when
   *  no day carries a savings figure yet. */
  medianPct: number | null;
}

/**
 * Savings-above-median streak, stated factually (design plan §8: "14
 * consecutive days with savings above your 30-day median").
 *
 * The reference is the median savings_pct across every day in the window that
 * carries a figure. The streak is the run of the MOST RECENT calendar days
 * whose savings_pct is strictly above that median — broken by the first day at
 * or below it, a day with no savings figure, or a calendar gap (an omitted day
 * is not "consecutive"). Bounded by the rolling daily window, so it is never
 * all-time. When no day has a savings figure the streak is 0 and medianPct is
 * null, so the UI shows a "coming soon" state rather than a fabricated streak.
 */
export function savingsAboveMedianStreak(days: DailyEntry[]): SavingsStreak {
  const present = days
    .map((d) => d.savings.savings_pct)
    .filter((v): v is number => v !== null);
  const med = median(present);
  if (med === null) return { days: 0, medianPct: null };

  // Sort ascending so index length-1 is the most recent day.
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  let streak = 0;
  let nextDay: number | null = null; // the more-recent counted day's timestamp
  for (let i = sorted.length - 1; i >= 0; i--) {
    const entry = sorted[i];
    const pct = entry.savings.savings_pct;
    if (pct === null || pct <= med) break;
    const day = parseDay(entry.date);
    if (day === null) break;
    if (nextDay !== null) {
      // Must be exactly one calendar day before the day we counted last.
      const gap = Math.round((nextDay - day) / MS_PER_DAY);
      if (gap !== 1) break;
    }
    streak += 1;
    nextDay = day;
  }
  return { days: streak, medianPct: med };
}
