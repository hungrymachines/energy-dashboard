import type { TempUnit } from './temperature.js';
import { formatDelta } from './temperature.js';

/**
 * A unit whose own sensor disagrees with the room sensor.
 *
 * Some units read the room from their own built-in sensor, which can sit
 * a degree or more from the room sensor the comfort range is written
 * for. The range is about the room, so the integration moves such a
 * unit's setpoint until the room sensor reads the plan's target, and the
 * setpoint may sit outside the range: by up to 3 °F, or 6 °F once the
 * unit's "wider setpoint offset" option is on.
 *
 * Two sources feed what the panel says about it. The service reports a
 * stored difference per unit (`BandCheck`), with the hours of the range
 * that are too narrow when the difference is past the limit. The
 * integration publishes what it is doing right now (`LiveOffset`).
 */

/** The offset limit once a unit's "wider setpoint offset" is on, °F. */
export const WIDE_OFFSET_LIMIT_F = 6;

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
  /** How far below the room sensor the unit's own sensor reads, °F. */
  sensor_gap_f: number;
  /** How far outside the range a setpoint may sit for this unit, °F. */
  offset_limit_f?: number;
  /** The difference is more than that. */
  offset_capped?: boolean;
  /** The unit's stored "wide setpoint offset" option. */
  wide_setpoint_offset?: boolean;
  /** Narrowest range the unit is expected to hold, °F. null when the
   * setpoint offset covers the whole difference: no range is too narrow. */
  min_width_f: number | null;
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

/** Why a narrow range matters, in the user's unit. Empty when the
 * setpoint offset covers the whole difference. */
export function bandCheckReason(
  check: Pick<BandCheck, 'sensor_gap_f' | 'min_width_f' | 'offset_limit_f'>,
  unit: TempUnit,
): string {
  if (check.min_width_f === null) return '';
  const limit = check.offset_limit_f;
  const covered =
    typeof limit === 'number' ? ` Setpoints follow it by up to ${formatDelta(limit, unit)}.` : '';
  return (
    `This unit's own sensor reads about ${formatDelta(check.sensor_gap_f, unit)} cooler than your room sensor.${covered} ` +
    `In a range narrower than ${formatDelta(check.min_width_f, unit)} it can stop while the room is still outside the range.`
  );
}

/**
 * What the stored sensor difference means for this unit, in the user's
 * unit. `wide` is the option as it stands in the form.
 */
export function offsetNote(
  check: Pick<BandCheck, 'sensor_gap_f' | 'offset_limit_f' | 'offset_capped'>,
  wide: boolean,
  unit: TempUnit,
): string {
  const gap = formatDelta(check.sensor_gap_f, unit);
  const lead = `This unit's own sensor reads about ${gap} cooler than your room sensor.`;
  const limitF = wide ? WIDE_OFFSET_LIMIT_F : (check.offset_limit_f ?? 3);
  const limit = formatDelta(limitF, unit);
  if (check.sensor_gap_f <= limitF) {
    return `${lead} To hold your range in the room, the unit may be set up to ${limit} outside it.`;
  }
  const ways = wide
    ? 'You can map a different temperature sensor to this unit, or widen the range.'
    : `You can turn on the wider offset below, map a different temperature sensor to this unit, or widen the range.`;
  return (
    `${lead} That is more than the ${limit} a unit may be set outside your range, ` +
    `so the room can sit outside a narrow range. ${ways}`
  );
}

/** What the integration is doing about a unit right now. */
export interface LiveOffset {
  /** Setpoint minus the plan's setpoint, °F. Negative = set lower. */
  offset_f: number;
  /** It stopped at the limit with the room still off its target. */
  limited: boolean;
  /** How far outside the range the setpoint may go, °F. */
  limit_f: number;
}

type HassStates = { states?: Record<string, { attributes?: Record<string, unknown> }> };

/** The live offset the integration publishes for one appliance, or null. */
export function liveOffsetFor(hass: unknown, applianceId: string): LiveOffset | null {
  const states = (hass as HassStates | null | undefined)?.states;
  if (!states) return null;
  for (const state of Object.values(states)) {
    const attrs = state?.attributes;
    if (!attrs || attrs['appliance_id'] !== applianceId) continue;
    const offset = attrs['setpoint_offset_f'];
    if (typeof offset !== 'number' || !Number.isFinite(offset)) return null;
    const limit = attrs['setpoint_offset_limit_f'];
    return {
      offset_f: offset,
      limited: attrs['setpoint_offset_limited'] === true,
      limit_f: typeof limit === 'number' && Number.isFinite(limit) ? limit : 3,
    };
  }
  return null;
}

/** One sentence on the live offset. Empty when it is under a degree. */
export function liveOffsetNote(live: LiveOffset | null, wide: boolean, unit: TempUnit): string {
  if (!live || (Math.abs(live.offset_f) < 1 && !live.limited)) return '';
  const where = live.offset_f < 0 ? 'below' : 'above';
  const now =
    `Right now this unit is set ${formatDelta(Math.abs(live.offset_f), unit)} ${where} ` +
    `the temperature the plan wants in the room, because its own sensor reads differently from your room sensor.`;
  if (!live.limited) return now;
  const ways = wide
    ? 'You can map a different temperature sensor to this unit, or widen the range.'
    : 'You can turn on the wider offset below, map a different temperature sensor to this unit, or widen the range.';
  return `${now} That is the ${formatDelta(live.limit_f, unit)} limit, and the room is still off its target. ${ways}`;
}
