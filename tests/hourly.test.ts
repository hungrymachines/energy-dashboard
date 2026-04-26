import { describe, it, expect } from 'vitest';
import {
  expandHourlyTo48,
  collapse48ToHourly,
  hasHourlyComfortBands,
  hasCustomRates,
} from '../src/utils/hourly.js';

describe('expandHourlyTo48', () => {
  it('duplicates each hour into two consecutive 30-min slots', () => {
    const input = Array.from({ length: 24 }, (_, i) => i);
    const out = expandHourlyTo48(input);
    expect(out).toHaveLength(48);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0);
    expect(out[2]).toBe(1);
    expect(out[3]).toBe(1);
    expect(out[46]).toBe(23);
    expect(out[47]).toBe(23);
    for (let h = 0; h < 24; h++) {
      expect(out[2 * h]).toBe(h);
      expect(out[2 * h + 1]).toBe(h);
    }
  });

  it('throws RangeError on empty array', () => {
    expect(() => expandHourlyTo48([])).toThrow(RangeError);
  });

  it('throws RangeError on wrong-length array', () => {
    expect(() => expandHourlyTo48([1, 2, 3])).toThrow(RangeError);
  });

  it('error message mentions the actual length', () => {
    try {
      expandHourlyTo48([1, 2, 3]);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RangeError);
      expect((err as Error).message).toMatch(/24/);
      expect((err as Error).message).toMatch(/3/);
    }
  });
});

describe('collapse48ToHourly', () => {
  it('samples even indices to produce a 24-element hourly array', () => {
    const input = Array.from({ length: 48 }, (_, i) => i);
    const out = collapse48ToHourly(input);
    expect(out).toHaveLength(24);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(2);
    expect(out[23]).toBe(46);
  });

  it('is the round-trip inverse of expand for a constant-per-hour 24-element array', () => {
    const original = Array.from({ length: 24 }, (_, i) => i * 0.5 + 60);
    const expanded = expandHourlyTo48(original);
    const collapsed = collapse48ToHourly(expanded);
    expect(collapsed).toEqual(original);
  });

  it('throws RangeError on wrong-length array', () => {
    expect(() => collapse48ToHourly([])).toThrow(RangeError);
    expect(() => collapse48ToHourly([1, 2, 3])).toThrow(RangeError);
    expect(() => collapse48ToHourly(Array.from({ length: 24 }, () => 0))).toThrow(RangeError);
  });
});

describe('hasHourlyComfortBands', () => {
  it('returns true when both arrays are length 24', () => {
    const prefs = {
      hourly_high_temps_f: Array.from({ length: 24 }, () => 76),
      hourly_low_temps_f: Array.from({ length: 24 }, () => 68),
    };
    expect(hasHourlyComfortBands(prefs)).toBe(true);
  });

  it('returns false when high is null', () => {
    expect(
      hasHourlyComfortBands({
        hourly_high_temps_f: null,
        hourly_low_temps_f: Array.from({ length: 24 }, () => 68),
      }),
    ).toBe(false);
  });

  it('returns false when low is null', () => {
    expect(
      hasHourlyComfortBands({
        hourly_high_temps_f: Array.from({ length: 24 }, () => 76),
        hourly_low_temps_f: null,
      }),
    ).toBe(false);
  });

  it('returns false when both are undefined', () => {
    expect(hasHourlyComfortBands({})).toBe(false);
  });

  it('returns false when either array has wrong length', () => {
    expect(
      hasHourlyComfortBands({
        hourly_high_temps_f: Array.from({ length: 12 }, () => 76),
        hourly_low_temps_f: Array.from({ length: 24 }, () => 68),
      }),
    ).toBe(false);
    expect(
      hasHourlyComfortBands({
        hourly_high_temps_f: Array.from({ length: 24 }, () => 76),
        hourly_low_temps_f: Array.from({ length: 48 }, () => 68),
      }),
    ).toBe(false);
  });
});

describe('hasCustomRates', () => {
  it('returns true when source is "custom"', () => {
    expect(hasCustomRates({ source: 'custom' })).toBe(true);
  });

  it('returns false when source is "zone"', () => {
    expect(hasCustomRates({ source: 'zone' })).toBe(false);
  });
});
