// Pure helpers for per-weekday comfort bands (weekday_bands).
// Keys are the API's lowercase day names, Mon first; hour 0 is local midnight.

export const WEEKDAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type WeekdayKey = (typeof WEEKDAY_KEYS)[number];

/** One day's band: 24 hourly values each, °F. */
export interface DayBand {
  high: number[];
  low: number[];
}

export type DayPreset = 'every' | 'weekend' | 'each';

export type WeekdayBands = Partial<
  Record<WeekdayKey, { hourly_high_temps_f: number[]; hourly_low_temps_f: number[] }>
>;

export interface BandPrefs {
  hourly_high_temps_f?: number[] | null;
  hourly_low_temps_f?: number[] | null;
  weekday_bands?: WeekdayBands | null;
}

export interface BandStorage {
  hourly_high_temps_f: number[];
  hourly_low_temps_f: number[];
  weekday_bands: WeekdayBands | null;
}

// getUTCDay: 0 = Sunday. Parsed by hand and built with Date.UTC, because
// new Date('YYYY-MM-DD') is UTC midnight and lands on the previous day in
// every US timezone when read with getDay().
export function weekdayKeyOf(isoDate: string): WeekdayKey {
  const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number);
  const sundayFirst = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return WEEKDAY_KEYS[(sundayFirst + 6) % 7];
}

export function todayIsoLocal(): string {
  const n = new Date();
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`;
}

function wellFormed(arr: unknown): arr is number[] {
  return Array.isArray(arr) && arr.length === 24 && arr.every((v) => typeof v === 'number' && Number.isFinite(v));
}

export function resolveDayBand(prefs: BandPrefs | null | undefined, key: WeekdayKey): DayBand | null {
  if (!prefs) return null;
  const o = prefs.weekday_bands?.[key];
  if (o && wellFormed(o.hourly_high_temps_f) && wellFormed(o.hourly_low_temps_f)) {
    return { high: o.hourly_high_temps_f, low: o.hourly_low_temps_f };
  }
  if (wellFormed(prefs.hourly_high_temps_f) && wellFormed(prefs.hourly_low_temps_f)) {
    return { high: prefs.hourly_high_temps_f, low: prefs.hourly_low_temps_f };
  }
  return null;
}

export function expandWeek(
  prefs: BandPrefs | null | undefined,
  fallback: DayBand,
): Record<WeekdayKey, DayBand> {
  const week = {} as Record<WeekdayKey, DayBand>;
  for (const k of WEEKDAY_KEYS) {
    const b = resolveDayBand(prefs, k) ?? fallback;
    week[k] = { high: [...b.high], low: [...b.low] };
  }
  return week;
}

export function bandsEqual(a: DayBand, b: DayBand): boolean {
  return (
    a.high.length === b.high.length &&
    a.low.length === b.low.length &&
    a.high.every((v, i) => v === b.high[i]) &&
    a.low.every((v, i) => v === b.low[i])
  );
}

export function detectPreset(week: Record<WeekdayKey, DayBand>): DayPreset {
  if (WEEKDAY_KEYS.every((k) => bandsEqual(week[k], week.mon))) return 'every';
  const weekdaysSame = (['tue', 'wed', 'thu', 'fri'] as const).every((k) => bandsEqual(week[k], week.mon));
  if (weekdaysSame && bandsEqual(week.sat, week.sun)) return 'weekend';
  return 'each';
}

const entry = (b: DayBand) => ({ hourly_high_temps_f: [...b.high], hourly_low_temps_f: [...b.low] });

export function toStorage(preset: DayPreset, week: Record<WeekdayKey, DayBand>): BandStorage {
  const base = week.mon;
  const out: WeekdayBands = {};
  if (preset === 'weekend') {
    if (!bandsEqual(week.sat, base)) {
      out.sat = entry(week.sat);
      out.sun = entry(week.sat);
    }
  } else if (preset === 'each') {
    for (const k of WEEKDAY_KEYS) {
      if (k !== 'mon' && !bandsEqual(week[k], base)) out[k] = entry(week[k]);
    }
  }
  return {
    hourly_high_temps_f: [...base.high],
    hourly_low_temps_f: [...base.low],
    weekday_bands: Object.keys(out).length ? out : null,
  };
}
