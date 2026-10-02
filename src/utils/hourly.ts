export function expandHourlyTo48(arr: number[]): number[] {
  if (!Array.isArray(arr) || arr.length !== 24) {
    throw new RangeError(
      `expandHourlyTo48 expects exactly 24 values, got ${Array.isArray(arr) ? arr.length : 0}`,
    );
  }
  const out: number[] = new Array(48);
  for (let i = 0; i < 24; i++) {
    out[2 * i] = arr[i];
    out[2 * i + 1] = arr[i];
  }
  return out;
}

export function collapse48ToHourly(arr: number[]): number[] {
  if (!Array.isArray(arr) || arr.length !== 48) {
    throw new RangeError(
      `collapse48ToHourly expects exactly 48 values, got ${Array.isArray(arr) ? arr.length : 0}`,
    );
  }
  const out: number[] = new Array(24);
  for (let i = 0; i < 24; i++) {
    out[i] = arr[2 * i];
  }
  return out;
}

export function hasHourlyComfortBands(prefs: {
  hourly_high_temps_f?: number[] | null;
  hourly_low_temps_f?: number[] | null;
}): boolean {
  const high = prefs.hourly_high_temps_f;
  const low = prefs.hourly_low_temps_f;
  return Array.isArray(high) && Array.isArray(low) && high.length === 24 && low.length === 24;
}

export function hasCustomRates(rates: { source: 'custom' | 'zone' | 'dynamic' }): boolean {
  return rates.source === 'custom';
}

// Mirrors `app/services/comfort.py: SAVINGS_OFFSETS` on the backend.
const SAVINGS_OFFSETS: Record<number, number> = { 1: 2.0, 2: 6.0, 3: 12.0 };

// Tight tolerance (°F) when the user is at home — applied symmetrically
// to high and low limits regardless of mode. Keep in sync with
// `app/services/comfort.py: HOME_BAND_OFFSET`.
const HOME_BAND_OFFSET = 1.0;

// Default hourly-band shape (US-SDC-030/032). Mirrors
// `app/services/comfort.py: DEFAULT_PEAK_HOURS` / `DEFAULT_PRECOOL_HOURS` /
// `PEAK_HOME_OFFSET_MAX` / `PRECOOL_FLOOR_OFFSET`. Hours are local
// wall-clock, half-open [start, end).
export const DEFAULT_PEAK_HOURS: readonly [number, number] = [13, 21];
export const DEFAULT_PRECOOL_HOURS: readonly [number, number] = [9, 13];
export const PEAK_HOME_OFFSET_MAX = 3.0;
export const PRECOOL_FLOOR_OFFSET = 2.0;

export type ComfortMode = 'cool' | 'heat' | 'auto';

/** Parse "HH:MM" into a half-hour interval index (0-47). Bad input → 0.
 * Mirrors `app/services/comfort.py: _time_to_interval`. */
function timeToInterval(time: string): number {
  if (typeof time !== 'string' || !time.includes(':')) return 0;
  const [hStr, mStr] = time.split(':');
  const hours = Number(hStr);
  const minutes = Number(mStr);
  if (!Number.isFinite(hours)) return 0;
  return hours * 2 + (Number.isFinite(minutes) && minutes >= 30 ? 1 : 0);
}

/** Mirrors `app/services/comfort.py: _is_away`. */
function isAwayInterval(interval: number, awayStart: number, homeStart: number): boolean {
  if (awayStart <= homeStart) return interval >= awayStart && interval < homeStart;
  return interval >= awayStart || interval < homeStart;
}

/** Round to the nearest 0.5. Mirrors `app/services/comfort.py: _round_half`. */
function roundHalf(value: number): number {
  return Math.round(value * 2) / 2;
}

/**
 * Derive the 24-hour default comfort-band shape the optimizer would use
 * for a given base temperature, savings level, home/away schedule, and
 * mode when no hourly override is stored. Used to seed the constraint
 * editor's hourly table and as the offline fallback for "Reset to
 * defaults" when the live `/preferences/default-bands` endpoint fails.
 *
 * Ports `app/services/comfort.py: default_hourly_bands` verbatim — see
 * that function's docstring for the shape rationale (peak hours widen
 * the side facing the peak, pre-peak hours open the side that stores
 * the pre-cool/pre-heat, away hours always win with the full savings
 * width). Returns one value per HOUR (24 elements), each rounded to 0.5.
 */
export function deriveHourlyComfortBand(opts: {
  base_temperature: number;
  savings_level: number;
  time_away: string;
  time_home: string;
  mode: ComfortMode;
  peak_hours?: readonly [number, number];
  precool_hours?: readonly [number, number];
}): { high: number[]; low: number[] } {
  const base = Number.isFinite(opts.base_temperature) ? opts.base_temperature : 72;
  const away = SAVINGS_OFFSETS[opts.savings_level] ?? 2.0;
  const awayStart = timeToInterval(opts.time_away);
  const homeStart = timeToInterval(opts.time_home);
  const peakHours = opts.peak_hours ?? DEFAULT_PEAK_HOURS;
  const precoolHours = opts.precool_hours ?? DEFAULT_PRECOOL_HOURS;

  const peakOffset = Math.min(away, PEAK_HOME_OFFSET_MAX);
  const precoolOffset = PRECOOL_FLOOR_OFFSET;

  const high: number[] = new Array(24);
  const low: number[] = new Array(24);
  for (let h = 0; h < 24; h++) {
    const inAway = isAwayInterval(2 * h, awayStart, homeStart);
    const inPeak = h >= peakHours[0] && h < peakHours[1];
    const inPrecool = h >= precoolHours[0] && h < precoolHours[1];

    let highOffset: number;
    let lowOffset: number;
    if (opts.mode === 'heat') {
      highOffset = inAway ? away : inPrecool ? precoolOffset : HOME_BAND_OFFSET;
      lowOffset = inAway ? away : inPeak ? peakOffset : HOME_BAND_OFFSET;
    } else {
      highOffset = inAway ? away : inPeak ? peakOffset : HOME_BAND_OFFSET;
      lowOffset = inAway ? away : inPrecool ? precoolOffset : HOME_BAND_OFFSET;
    }

    high[h] = roundHalf(base + highOffset);
    low[h] = roundHalf(base - lowOffset);
  }
  return { high, low };
}
