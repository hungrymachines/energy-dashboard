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

  it('test_default_hourly_bands_cool_shape_level1', () => {
    // base 72, level 1, away 08:00-17:00, cool. Away always wins (full
    // ±2.0 SAVINGS_OFFSETS width) even where it overlaps the peak window
    // — peak/precool only shape HOME hours.
    const { high, low } = deriveHourlyComfortBand({
      base_temperature: 72.0,
      savings_level: 1,
      time_away: '08:00',
      time_home: '17:00',
      mode: 'cool',
    });
    // 02:00 — home, outside peak (13-21) and precool (9-13): HOME_BAND_OFFSET.
    expect([low[2], high[2]]).toEqual([71.0, 73.0]);
    // 10:00 — away (08:00-17:00) even though also inside the precool window.
    expect([low[10], high[10]]).toEqual([70.0, 74.0]);
    // 15:00 — away AND inside the peak window; still away takes precedence.
    expect([low[15], high[15]]).toEqual([70.0, 74.0]);
    // 18:00 — home (user's back) and inside the peak window: ceiling opens
    // to min(away=2.0, PEAK_HOME_OFFSET_MAX=3.0) = 2.0, floor stays home.
    expect([low[18], high[18]]).toEqual([71.0, 74.0]);
    // 22:00 — home, outside peak/precool again.
    expect([low[22], high[22]]).toEqual([71.0, 73.0]);
  });

  it('test_default_hourly_bands_peak_ceiling_caps_at_peak_home_offset_max', () => {
    const { high, low } = deriveHourlyComfortBand({
      base_temperature: 72.0,
      savings_level: 2,
      time_away: '08:00',
      time_home: '17:00',
      mode: 'cool',
    });
    // 18:00 is home + peak: ceiling capped at min(away=6.0, 3.0) = 3.0.
    expect(high[18]).toBe(72.0 + PEAK_HOME_OFFSET_MAX);
    expect(high[18]).toBe(75.0);
    expect(low[18]).toBe(71.0); // floor untouched by peak (HOME_BAND_OFFSET)
    // 15:00 is still an away hour under this same window, so it keeps the
    // full, uncapped away width (±6.0).
    expect([low[15], high[15]]).toEqual([66.0, 78.0]);
  });

  it('test_default_hourly_bands_precool_floor_drops_in_home_hours', () => {
    // Away window 14:00-20:00 leaves the 9-13 precool hours as HOME hours.
    const { high, low } = deriveHourlyComfortBand({
      base_temperature: 72.0,
      savings_level: 1,
      time_away: '14:00',
      time_home: '20:00',
      mode: 'cool',
    });
    // 10:00 — home, inside precool (9-13): floor drops to PRECOOL_FLOOR_OFFSET=2.0.
    expect([low[10], high[10]]).toEqual([70.0, 73.0]);
    // 13:00 — home (away starts at 14:00), inside peak (13-21) and just
    // past precool: ceiling opens to min(away=2.0, 3.0)=2.0, floor is home.
    expect([low[13], high[13]]).toEqual([71.0, 74.0]);
    // 9:00 is also home+precool.
    expect([low[9], high[9]]).toEqual([70.0, 73.0]);
  });

  it('test_default_hourly_bands_heat_mirrors_cool', () => {
    const { high, low } = deriveHourlyComfortBand({
      base_temperature: 68.0,
      savings_level: 1,
      time_away: '14:00',
      time_home: '20:00',
      mode: 'heat',
    });
    // 10:00 — home, precool window: ceiling RISES (was the floor in cool).
    expect([low[10], high[10]]).toEqual([67.0, 70.0]);
    // 13:00 — home, peak window: floor DROPS (was the ceiling in cool).
    expect([low[13], high[13]]).toEqual([66.0, 69.0]);
    // Away hours are unaffected by mode — still the flat full-width band.
    expect([low[18], high[18]]).toEqual([68.0 - 2.0, 68.0 + 2.0]);
  });

  it('test_default_hourly_bands_values_rounded_to_half', () => {
    const { high, low } = deriveHourlyComfortBand({
      base_temperature: 70.3,
      savings_level: 1,
      time_away: '08:00',
      time_home: '17:00',
      mode: 'cool',
    });
    for (const v of [...high, ...low]) {
      expect(v * 2).toBe(Math.round(v * 2));
    }
  });

  it('test_default_hourly_bands_custom_peak_and_precool_hours', () => {
    // The peak/precool windows are parameters, not just module constants.
    const { high, low } = deriveHourlyComfortBand({
      base_temperature: 72.0,
      savings_level: 2,
      time_away: '14:00',
      time_home: '20:00',
      mode: 'cool',
      peak_hours: [1, 2],
      precool_hours: [3, 4],
    });
    expect([low[1], high[1]]).toEqual([71.0, 75.0]); // custom peak hour, capped at 3.0
    expect([low[3], high[3]]).toEqual([70.0, 73.0]); // custom precool hour
    // Hour 13, inside the module DEFAULT peak window, is now untouched.
    expect([low[13], high[13]]).toEqual([71.0, 73.0]);
  });

  // --- Cross-package parity (US-SDC-034) -------------------------------
  // The same case is pinned, under the same test names, in three suites:
  //   hungry-machines-api/tests/test_comfort.py  (default_hourly_bands)
  //   this file                                  (deriveHourlyComfortBand)
  //   hm-client/tests/comfort.test.ts            (defaultHourlyBands)
  // The literals below are the Python generator's own printed output, so
  // a drift in any one of the three turns all three red together.
  const PARITY_COOL_HIGH = [
    73.0, 73.0, 73.0, 73.0, 73.0, 73.0, 73.0, 73.0,
    78.0, 78.0, 78.0, 78.0, 78.0, 78.0, 78.0, 78.0,
    78.0, 75.0, 75.0, 75.0, 75.0, 73.0, 73.0, 73.0,
  ];
  const PARITY_COOL_LOW = [
    71.0, 71.0, 71.0, 71.0, 71.0, 71.0, 71.0, 71.0,
    66.0, 66.0, 66.0, 66.0, 66.0, 66.0, 66.0, 66.0,
    66.0, 71.0, 71.0, 71.0, 71.0, 71.0, 71.0, 71.0,
  ];
  const PARITY_HEAT_HIGH = [
    73.0, 73.0, 73.0, 73.0, 73.0, 73.0, 73.0, 73.0,
    78.0, 78.0, 78.0, 78.0, 78.0, 78.0, 78.0, 78.0,
    78.0, 73.0, 73.0, 73.0, 73.0, 73.0, 73.0, 73.0,
  ];
  const PARITY_HEAT_LOW = [
    71.0, 71.0, 71.0, 71.0, 71.0, 71.0, 71.0, 71.0,
    66.0, 66.0, 66.0, 66.0, 66.0, 66.0, 66.0, 66.0,
    66.0, 69.0, 69.0, 69.0, 69.0, 71.0, 71.0, 71.0,
  ];

  it('test_default_hourly_bands_cross_package_parity_cool', () => {
    // base 72, level 2, away 08:00-17:00, cool -- the full 24-hour arrays.
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
    // Same inputs, heat: the peak widening moves to the floor (69.0 at
    // 17:00-20:00) and the ceiling stays at the home offset.
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
