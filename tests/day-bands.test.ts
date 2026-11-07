import { describe, it, expect, afterEach } from 'vitest';
import {
  WEEKDAY_KEYS,
  weekdayKeyOf,
  resolveDayBand,
  expandWeek,
  bandsEqual,
  detectPreset,
  toStorage,
  type DayBand,
  type WeekdayKey,
} from '../src/utils/day-bands';

const band = (hi: number, lo: number): DayBand => ({
  high: Array(24).fill(hi),
  low: Array(24).fill(lo),
});
const weekOf = (f: (k: WeekdayKey) => DayBand) =>
  Object.fromEntries(WEEKDAY_KEYS.map((k) => [k, f(k)])) as Record<WeekdayKey, DayBand>;

describe('weekdayKeyOf', () => {
  const orig = process.env.TZ;
  afterEach(() => {
    if (orig === undefined) delete process.env.TZ;
    else process.env.TZ = orig;
  });
  for (const tz of ['America/Los_Angeles', 'UTC']) {
    it(`2026-11-07 is sat with TZ=${tz}`, () => {
      process.env.TZ = tz;
      expect(weekdayKeyOf('2026-11-07')).toBe('sat');
      expect(weekdayKeyOf('2026-11-08')).toBe('sun');
      expect(weekdayKeyOf('2026-11-09')).toBe('mon');
    });
  }
});

describe('resolveDayBand', () => {
  it('prefers the override, then the hourly arrays, then null', () => {
    const prefs = {
      hourly_high_temps_f: band(78, 70).high,
      hourly_low_temps_f: band(78, 70).low,
      weekday_bands: { sat: { hourly_high_temps_f: band(80, 66).high, hourly_low_temps_f: band(80, 66).low } },
    };
    expect(resolveDayBand(prefs, 'sat')).toEqual(band(80, 66));
    expect(resolveDayBand(prefs, 'wed')).toEqual(band(78, 70));
    expect(resolveDayBand({}, 'wed')).toBeNull();
  });
  it('ignores a malformed override', () => {
    const prefs = {
      hourly_high_temps_f: band(78, 70).high,
      hourly_low_temps_f: band(78, 70).low,
      weekday_bands: { sat: { hourly_high_temps_f: [1, 2], hourly_low_temps_f: [1, 2] } },
    };
    expect(resolveDayBand(prefs, 'sat')).toEqual(band(78, 70));
  });
});

describe('detectPreset', () => {
  it('every / weekend / each', () => {
    expect(detectPreset(weekOf(() => band(78, 70)))).toBe('every');
    expect(detectPreset(weekOf((k) => (k === 'sat' || k === 'sun' ? band(80, 66) : band(78, 70))))).toBe('weekend');
    expect(detectPreset(weekOf((k) => (k === 'sat' ? band(80, 66) : band(78, 70))))).toBe('each');
  });
});

describe('toStorage', () => {
  const wk = band(78, 70);
  const we = band(80, 66);
  it('every: one band, no overrides', () => {
    const s = toStorage('every', weekOf(() => wk));
    expect(s.weekday_bands).toBeNull();
    expect(s.hourly_high_temps_f).toEqual(wk.high);
  });
  it('weekend: sat+sun, or null when equal', () => {
    const s = toStorage('weekend', weekOf((k) => (k === 'sat' || k === 'sun' ? we : wk)));
    expect(Object.keys(s.weekday_bands!)).toEqual(['sat', 'sun']);
    expect(s.hourly_high_temps_f).toEqual(wk.high);
    expect(toStorage('weekend', weekOf(() => wk)).weekday_bands).toBeNull();
  });
  it('each: only days differing from Monday, or null when none', () => {
    const s = toStorage('each', weekOf((k) => (k === 'fri' ? we : wk)));
    expect(Object.keys(s.weekday_bands!)).toEqual(['fri']);
    expect(toStorage('each', weekOf(() => wk)).weekday_bands).toBeNull();
  });
  it('round trips through prefs and expandWeek', () => {
    for (const week of [
      weekOf(() => wk),
      weekOf((k) => (k === 'sat' || k === 'sun' ? we : wk)),
      weekOf((k) => (k === 'tue' ? we : k === 'sun' ? band(82, 64) : wk)),
    ]) {
      const back = expandWeek(toStorage(detectPreset(week), week), band(1, 0));
      for (const k of WEEKDAY_KEYS) expect(bandsEqual(back[k], week[k])).toBe(true);
    }
  });
});
