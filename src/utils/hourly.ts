// Default comfort band. The same shape the API uses. Offsets from base_temperature:
//   00:00-07:59  base-2 .. base+1   (70-73 at base 72)
//   08:00-21:59  base-5 .. base+6   (67-78 at base 72)
//   22:00-23:59  base-2 .. base+1
// savings_level / time_away / time_home no longer vary the default.
const DEFAULT_DAY_HOURS: readonly [number, number] = [8, 22];
const DEFAULT_NIGHT_OFFSETS: readonly [number, number] = [-2.0, 1.0]; // low, high
const DEFAULT_DAY_OFFSETS: readonly [number, number] = [-5.0, 6.0];

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

export type ComfortMode = 'cool' | 'heat' | 'auto';

/** Round to the nearest 0.5. Mirrors the API's `_round_half`. */
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
 * Ports the API's `default_hourly_bands` verbatim — the
 * owner-set default band (see the constants above). `savings_level`,
 * `time_away` and `time_home` are accepted for signature parity with the
 * stored preferences but no longer change the result; only
 * `base_temperature` and `mode` do. Returns one value per HOUR (24
 * elements), each rounded to 0.5.
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

  const high: number[] = new Array(24);
  const low: number[] = new Array(24);
  for (let h = 0; h < 24; h++) {
    const inDay = h >= DEFAULT_DAY_HOURS[0] && h < DEFAULT_DAY_HOURS[1];
    let [lowOffset, highOffset] = inDay ? DEFAULT_DAY_OFFSETS : DEFAULT_NIGHT_OFFSETS;
    if (opts.mode === 'heat') {
      // Mirror of the cooling shape: heating saves by running COLDER by day.
      [lowOffset, highOffset] = [-highOffset, -lowOffset];
    }
    high[h] = roundHalf(base + highOffset);
    low[h] = roundHalf(base + lowOffset);
  }
  return { high, low };
}
