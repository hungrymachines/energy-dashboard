import { describe, it, expect } from 'vitest';
import {
  expandHourlyTo48,
  collapse48ToHourly,
  hasHourlyComfortBands,
  hasCustomRates,
  deriveHourlyComfortBand,
  PEAK_HOME_OFFSET_MAX,
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

// ---- US-SDC-032: deriveHourlyComfortBand ports comfort.default_hourly_bands
// (US-SDC-030) verbatim. Cases mirror tests/test_comfort.py 1:1 (Python
// test name in each `it` title) so the two stay in lockstep.

describe('deriveHourlyComfortBand', () => {
  it('test_default_hourly_bands_returns_24_elements', () => {
    const { high, low } = deriveHourlyComfortBand({
      base_temperature: 72.0,
      savings_level: 1,
      time_away: '08:00',
      time_home: '17:00',
      mode: 'cool',
    });
    expect(high).toHaveLength(24);
    expect(low).toHaveLength(24);
    for (let i = 0; i < 24; i++) {
      expect(high[i]).toBeGreaterThan(low[i]);
    }
  });

  it('test_default_hourly_bands_is_the_owner_set_shape', () => {
    // 2026-10-02: tight overnight, wide 08:00-21:59. Offsets from base are
    // night base-2..base+1 and day base-5..base+6, so at base 72 that is
    // 70-73 overnight and 67-78 from 08:00 through 21:59.
    const { high, low } = deriveHourlyComfortBand({
      base_temperature: 72.0,
      savings_level: 1,
      time_away: '08:00',
      time_home: '17:00',
      mode: 'cool',
    });
    expect([low[0], high[0]]).toEqual([70.0, 73.0]);
    expect([low[7], high[7]]).toEqual([70.0, 73.0]);
    expect([low[8], high[8]]).toEqual([67.0, 78.0]);
    expect([low[12], high[12]]).toEqual([67.0, 78.0]);
    expect([low[17], high[17]]).toEqual([67.0, 78.0]);
    expect([low[21], high[21]]).toEqual([67.0, 78.0]);
    expect([low[22], high[22]]).toEqual([70.0, 73.0]);
    expect([low[23], high[23]]).toEqual([70.0, 73.0]);
  });

  it('test_default_hourly_bands_ignores_level_away_and_home', () => {
    // ONE band for everybody. This panel used to default to level 3 (60-84
    // away at base 72) while hm-client used 2 and the API used 1.
    const ref = deriveHourlyComfortBand({
      base_temperature: 72.0,
      savings_level: 1,
      time_away: '08:00',
      time_home: '17:00',
      mode: 'cool',
    });
    for (const level of [1, 2, 3]) {
      for (const [away, home] of [
        ['08:00', '17:00'],
        ['06:30', '15:00'],
        ['10:00', '21:00'],
      ]) {
        const { high, low } = deriveHourlyComfortBand({
          base_temperature: 72.0,
          savings_level: level,
          time_away: away,
          time_home: home,
          mode: 'cool',
        });
        expect(high).toEqual(ref.high);
        expect(low).toEqual(ref.low);
      }
    }
  });

  it('test_default_hourly_bands_shifts_with_base_temperature', () => {
    const { high, low } = deriveHourlyComfortBand({
      base_temperature: 68.0,
      savings_level: 1,
      time_away: '08:00',
      time_home: '17:00',
      mode: 'cool',
    });
    expect([low[0], high[0]]).toEqual([66.0, 69.0]);
    expect([low[12], high[12]]).toEqual([63.0, 74.0]);
  });

  it('test_default_hourly_bands_peak_and_precool_args_are_inert', () => {
    const ref = deriveHourlyComfortBand({
      base_temperature: 72.0,
      savings_level: 1,
      time_away: '08:00',
      time_home: '17:00',
      mode: 'cool',
    });
    const { high, low } = deriveHourlyComfortBand({
      base_temperature: 72.0,
      savings_level: 1,
      time_away: '08:00',
      time_home: '17:00',
      mode: 'cool',
      peak_hours: [3, 6],
      precool_hours: [1, 3],
    });
    expect(high).toEqual(ref.high);
    expect(low).toEqual(ref.low);
  });

  it('test_default_hourly_bands_heat_mirrors_cool', () => {
    // Heating saves by running COLDER by day: (-5, +6) becomes (-6, +5).
    const { high, low } = deriveHourlyComfortBand({
      base_temperature: 72.0,
      savings_level: 1,
      time_away: '08:00',
      time_home: '17:00',
      mode: 'heat',
    });
    expect([low[0], high[0]]).toEqual([71.0, 74.0]);
    expect([low[12], high[12]]).toEqual([66.0, 77.0]);
    expect(high[12] - low[12]).toBe(11.0);
  });

  it('test_default_hourly_bands_values_rounded_to_half', () => {
    const { high, low } = deriveHourlyComfortBand({
      base_temperature: 72.3,
      savings_level: 1,
      time_away: '08:00',
      time_home: '17:00',
      mode: 'cool',
    });
    for (const v of [...high, ...low]) {
      expect(v * 2).toBe(Math.trunc(v * 2));
    }
  });

  // --- Cross-package parity -------------------------------------------
  // Pinned with the same names in hungry-machines-api/tests/test_comfort.py
  // (the source of truth) and hm-client/tests/comfort.test.ts.
  const PARITY_COOL_HIGH = [
    73.0, 73.0, 73.0, 73.0, 73.0, 73.0, 73.0, 73.0,
    78.0, 78.0, 78.0, 78.0, 78.0, 78.0, 78.0, 78.0,
    78.0, 78.0, 78.0, 78.0, 78.0, 78.0, 73.0, 73.0,
  ];
  const PARITY_COOL_LOW = [
    70.0, 70.0, 70.0, 70.0, 70.0, 70.0, 70.0, 70.0,
    67.0, 67.0, 67.0, 67.0, 67.0, 67.0, 67.0, 67.0,
    67.0, 67.0, 67.0, 67.0, 67.0, 67.0, 70.0, 70.0,
  ];
  const PARITY_HEAT_HIGH = [
    74.0, 74.0, 74.0, 74.0, 74.0, 74.0, 74.0, 74.0,
    77.0, 77.0, 77.0, 77.0, 77.0, 77.0, 77.0, 77.0,
    77.0, 77.0, 77.0, 77.0, 77.0, 77.0, 74.0, 74.0,
  ];
  const PARITY_HEAT_LOW = [
    71.0, 71.0, 71.0, 71.0, 71.0, 71.0, 71.0, 71.0,
    66.0, 66.0, 66.0, 66.0, 66.0, 66.0, 66.0, 66.0,
    66.0, 66.0, 66.0, 66.0, 66.0, 66.0, 71.0, 71.0,
  ];

  it('test_default_hourly_bands_cross_package_parity_cool', () => {
    const { high, low } = deriveHourlyComfortBand({
      base_temperature: 72.0,
      savings_level: 2,
      time_away: '08:00',
      time_home: '17:00',
      mode: 'cool',
    });
    expect(high).toEqual(PARITY_COOL_HIGH);
    expect(low).toEqual(PARITY_COOL_LOW);
  });

  it('test_default_hourly_bands_cross_package_parity_heat', () => {
    const { high, low } = deriveHourlyComfortBand({
      base_temperature: 72.0,
      savings_level: 2,
      time_away: '08:00',
      time_home: '17:00',
      mode: 'heat',
    });
    expect(high).toEqual(PARITY_HEAT_HIGH);
    expect(low).toEqual(PARITY_HEAT_LOW);
  });
});
