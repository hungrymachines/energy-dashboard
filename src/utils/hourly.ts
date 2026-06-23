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
// When the user is NOT using hourly overrides, the optimizer derives
// the comfort band from base_temperature + savings_level + time_away/home,
// and the constraint editor shows those derived values in the disabled
// hourly table. Keep this map in sync with the backend's.
const SAVINGS_OFFSETS: Record<number, number> = { 1: 2.0, 2: 6.0, 3: 12.0 };

// Tight tolerance (°F) when the user is at home — applied symmetrically
// to high and low limits regardless of mode. Keep in sync with
// `app/services/comfort.py: HOME_BAND_OFFSET`.
const HOME_BAND_OFFSET = 1.0;

export type ComfortMode = 'cool' | 'heat' | 'auto';

/** Parse "HH:MM" into a 0-23 hour index, clamped. Bad input → 0. */
function timeStrToHour(time: string): number {
  if (typeof time !== 'string' || !time.includes(':')) return 0;
  const [hStr] = time.split(':');
  const h = Number(hStr);
  if (!Number.isFinite(h)) return 0;
  return Math.max(0, Math.min(23, Math.floor(h)));
}

function isAwayHour(hour: number, awayHour: number, homeHour: number): boolean {
  if (awayHour <= homeHour) return hour >= awayHour && hour < homeHour;
  // Wrap past midnight (e.g. away 22:00, home 06:00).
  return hour >= awayHour || hour < homeHour;
}

/**
 * Derive a 24-hour comfort band from the legacy preference fields, in
 * the same shape the constraint editor's hourly table renders. Used to
 * populate the disabled table when the user has just unchecked
 * "Use my hourly bands" — gives them a preview of what the optimizer
 * will fall back to.
 *
 * Mirrors `app/services/comfort.py: build_comfort_band`. Returns one
 * value per HOUR (24 elements), not per half-hour interval.
 *
 * Band shape is symmetric and mode-independent:
 *   home hours → base ± HOME_BAND_OFFSET (tight, user is present)
 *   away hours → base ± SAVINGS_OFFSETS[level] (wide, lets the
 *                 optimizer pre-cool OR pre-heat depending on prices)
 */
export function deriveHourlyComfortBand(opts: {
  base_temperature: number;
  savings_level: number;
  time_away: string;
  time_home: string;
  // Kept for callsite compatibility — the mode no longer changes the
  // band shape (the optimizer uses it separately to choose actions).
  mode: ComfortMode;
}): { high: number[]; low: number[] } {
  const base = Number.isFinite(opts.base_temperature) ? opts.base_temperature : 72;
  const awayOffset = SAVINGS_OFFSETS[opts.savings_level] ?? 2.0;
  const awayHour = timeStrToHour(opts.time_away);
  const homeHour = timeStrToHour(opts.time_home);

  const high: number[] = new Array(24);
  const low: number[] = new Array(24);
  for (let h = 0; h < 24; h++) {
    const offset = isAwayHour(h, awayHour, homeHour) ? awayOffset : HOME_BAND_OFFSET;
    high[h] = base + offset;
    low[h] = base - offset;
  }
  return { high, low };
}
