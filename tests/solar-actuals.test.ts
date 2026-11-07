import { describe, it, expect, vi } from 'vitest';
import {
  comparedKwh,
  fetchSolarActuals,
  localMidnightMs,
  slotAveragesKw,
  toKw,
} from '../src/utils/solar-actuals.js';

const LA = 'America/Los_Angeles';
const DATE = '2025-11-18';
// Local midnight in LA on 2025-11-18 (PST, UTC-8).
const MIDNIGHT = Date.UTC(2025, 10, 18, 8, 0);
const HOUR = 3_600_000;

describe('toKw', () => {
  it('converts W, kW and MW and keeps production positive', () => {
    expect(toKw('2500', 'W')).toBe(2.5);
    expect(toKw(2.5, 'kW')).toBe(2.5);
    expect(toKw('-1200', 'W')).toBe(1.2);
    expect(toKw('0.001', 'MW')).toBe(1);
  });

  it('returns null for unavailable, unknown and empty states', () => {
    expect(toKw('unavailable', 'W')).toBeNull();
    expect(toKw('unknown', 'W')).toBeNull();
    expect(toKw('', 'W')).toBeNull();
  });
});

describe('localMidnightMs', () => {
  it('finds local midnight in a fixed-offset season', () => {
    expect(localMidnightMs(DATE, LA)).toBe(MIDNIGHT);
  });

  it('uses the offset in force at midnight on a DST change day', () => {
    // 2026-11-01: Chicago leaves CDT (UTC-5) at 02:00, so midnight is 05:00Z.
    expect(localMidnightMs('2026-11-01', 'America/Chicago')).toBe(Date.UTC(2026, 10, 1, 5, 0));
  });
});

describe('slotAveragesKw', () => {
  it('averages a step series into local half-hour slots', () => {
    const slots = slotAveragesKw(
      [
        { t: MIDNIGHT, kw: 0 },
        { t: MIDNIGHT + 10 * HOUR, kw: 2 },
        { t: MIDNIGHT + 10.25 * HOUR, kw: 4 },
      ],
      DATE,
      LA,
      MIDNIGHT + 11 * HOUR,
    );
    expect(slots).toHaveLength(48);
    expect(slots[19]).toBe(0);
    // 10:00-10:30: 15 min at 2 kW, 15 min at 4 kW.
    expect(slots[20]).toBe(3);
    expect(slots[21]).toBe(4);
    // Not yet happened.
    expect(slots[22]).toBeNull();
  });

  it('leaves a slot null when it has under ten valid minutes', () => {
    const slots = slotAveragesKw(
      [
        { t: MIDNIGHT, kw: 1 },
        { t: MIDNIGHT + 5 * HOUR + 5 * 60_000, kw: null },
      ],
      DATE,
      LA,
      MIDNIGHT + 8 * HOUR,
    );
    expect(slots[9]).toBe(1);
    // 05:00-05:30 had 5 valid minutes.
    expect(slots[10]).toBeNull();
    expect(slots[12]).toBeNull();
  });

  it('starts empty until the first sample', () => {
    const slots = slotAveragesKw([{ t: MIDNIGHT + 6 * HOUR, kw: 1 }], DATE, LA, MIDNIGHT + 7 * HOUR);
    expect(slots[11]).toBeNull();
    expect(slots[12]).toBe(1);
  });
});

describe('fetchSolarActuals', () => {
  const hassWith = (callWS: (msg: Record<string, unknown>) => Promise<unknown>) => ({
    callWS,
    states: { 'sensor.pv_power': { attributes: { unit_of_measurement: 'W' } } },
  });

  it("reads today's history from HA and converts to kW", async () => {
    // Shape checked against HA 2026.6.4 (recorder/history/__init__.py): with
    // minimal_response + no_attributes every row is { s: string, lu: seconds },
    // repeats of the same state are dropped, and the start-time row is
    // stamped with start_time itself.
    const callWS = vi.fn(async () => ({
      'sensor.pv_power': [
        { s: '0', lu: MIDNIGHT / 1000 },
        { s: '3000', lu: (MIDNIGHT + 9 * HOUR) / 1000 },
      ],
    }));
    const out = await fetchSolarActuals(hassWith(callWS), 'sensor.pv_power', DATE, LA, MIDNIGHT + 10 * HOUR);
    expect(callWS).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'history/history_during_period',
        entity_ids: ['sensor.pv_power'],
        start_time: new Date(MIDNIGHT).toISOString(),
        no_attributes: true,
      }),
    );
    expect(out![0]).toBe(0);
    expect(out![18]).toBe(3);
    expect(out![20]).toBeNull();
  });

  it('returns null when HA has no websocket or the call fails', async () => {
    expect(await fetchSolarActuals({}, 'sensor.pv_power', DATE, LA, MIDNIGHT + HOUR)).toBeNull();
    const failing = hassWith(async () => {
      throw new Error('recorder off');
    });
    expect(await fetchSolarActuals(failing, 'sensor.pv_power', DATE, LA, MIDNIGHT + HOUR)).toBeNull();
  });

  it('returns null when the entity has no history', async () => {
    const empty = hassWith(async () => ({}));
    expect(await fetchSolarActuals(empty, 'sensor.pv_power', DATE, LA, MIDNIGHT + HOUR)).toBeNull();
  });
});

describe('comparedKwh', () => {
  it('compares only the slots that have a measurement', () => {
    const actuals = Array<number | null>(48).fill(null);
    actuals[20] = 2;
    actuals[21] = 4;
    const forecast = Array<number>(48).fill(1);
    expect(comparedKwh(actuals, forecast)).toEqual({ actualKwh: 3, forecastKwh: 1, slots: 2 });
  });
});
