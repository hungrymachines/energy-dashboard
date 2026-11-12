import type { TempUnit } from './temperature.js';
import { formatDelta } from './temperature.js';

/**
 * Comfort ranges narrower than a unit can hold.
 *
 * Some units read the room from their own built-in sensor, which can sit
 * a degree or more from the room sensor the ranges are written for.
 * Inside a range narrower than that difference the unit can stop while
 * the room sensor still reads outside the range. The API measures the
 * difference per unit and reports the narrowest range the unit is
 * expected to hold; this file turns that into the hours to widen.
 */

/** One run of consecutive hours narrower than the minimum width. */
export interface NarrowRun {
  /** `every` for the every-day range, or a weekday key (`mon`..`sun`). */
  day: string;
  start_hour: number;
  /** Exclusive; 24 is midnight. */
  end_hour: number;
  /** Narrowest hour of the run, °F. */
  width_f: number;
}

export interface BandCheck {
  /** How far the unit's own sensor sits from the room sensor, °F. */
  sensor_gap_f: number;
  /** Narrowest range the unit is expected to hold, °F. */
  min_width_f: number;
  /** Stored ranges narrower than that. Empty when none. */
  narrow: NarrowRun[];
}

const DAY_LABELS: Record<string, string> = {
  mon: 'Mon',
  tue: 'Tue',
  wed: 'Wed',
  thu: 'Thu',
  fri: 'Fri',
  sat: 'Sat',
  sun: 'Sun',
};

const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;

/** `00:00–08:00`, with the weekday in front when the run is one day's. */
export function runLabel(run: Pick<NarrowRun, 'day' | 'start_hour' | 'end_hour'>): string {
  const span = `${hh(run.start_hour)}–${hh(run.end_hour)}`;
  const day = DAY_LABELS[run.day];
  return day ? `${day} ${span}` : span;
}

/**
 * Runs of hours whose range (high minus low, °F) is under `minWidthF`.
 * An hour with a missing or non-numeric edge is skipped: the editor's
 * own validation speaks for it.
 */
export function narrowHourRuns(
  lowsF: Array<number | null>,
  highsF: Array<number | null>,
  minWidthF: number,
  day = 'every',
): NarrowRun[] {
  const runs: NarrowRun[] = [];
  let current: NarrowRun | null = null;
  for (let h = 0; h < 24; h++) {
    const low = lowsF[h];
    const high = highsF[h];
    const width =
      typeof low === 'number' && typeof high === 'number' && Number.isFinite(low) && Number.isFinite(high)
        ? high - low
        : null;
    if (width !== null && width > 0 && width < minWidthF - 1e-9) {
      const rounded = Math.round(width * 10) / 10;
      if (current) {
        current.end_hour = h + 1;
        current.width_f = Math.min(current.width_f, rounded);
      } else {
        current = { day, start_hour: h, end_hour: h + 1, width_f: rounded };
        runs.push(current);
      }
    } else {
      current = null;
    }
  }
  return runs;
}

/** Why a narrow range matters, in the user's unit. */
export function bandCheckReason(check: Pick<BandCheck, 'sensor_gap_f' | 'min_width_f'>, unit: TempUnit): string {
  return (
    `This unit's own sensor reads about ${formatDelta(check.sensor_gap_f, unit)} from your room sensor. ` +
    `In a range narrower than ${formatDelta(check.min_width_f, unit)} it can stop while the room is still outside the range.`
  );
}
