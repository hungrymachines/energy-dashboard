import { describe, it, expect, vi } from 'vitest';
import {
  cToF,
  displayTemp,
  fDeltaToC,
  fToC,
  formatDelta,
  haUnitFrom,
  limitsFor,
  liveTemp,
  parseTempInput,
  resolveUnit,
  unitLabel,
  temperatureUnitStore,
  type LimitField,
} from '../src/utils/temperature.js';

describe('temperature conversion', () => {
  it('round-trips every 0.5 °C step in each range exactly', () => {
    for (const field of ['hourly', 'base', 'water_heater'] as LimitField[]) {
      const { min, max } = limitsFor(field, 'C');
      for (let c = min; c <= max; c += 0.5) {
        const f = cToF(c);
        expect(displayTemp(f, 'C')).toBe(String(c));
        expect(parseTempInput(String(c), 'C')).toBe(f);
      }
    }
  });

  it('passes °F through unchanged', () => {
    expect(displayTemp(70.5, 'F')).toBe('70.5');
    expect(parseTempInput(' 72 ', 'F')).toBe(72);
    expect(liveTemp(71.6, 'F', 'F')).toBe('72');
  });

  it('converts deltas without an offset', () => {
    expect(fDeltaToC(1.8)).toBeCloseTo(1);
    expect(formatDelta(1.08, 'C')).toBe('0.6 °C');
    expect(formatDelta(0.6, 'F')).toBe('0.6 °F');
    expect(fToC(32)).toBe(0);
  });

  it('shows live °C to 0.1', () => {
    expect(liveTemp(22.24, 'C', 'C')).toBe('22.2');
    expect(liveTemp(72, 'F', 'C')).toBe('22.2');
    expect(liveTemp(22.2, 'C', 'F')).toBe('72');
  });

  it('rejects unparseable input', () => {
    expect(parseTempInput('', 'C')).toBeNull();
    expect(parseTempInput('abc', 'F')).toBeNull();
  });

  it('labels units', () => {
    expect(unitLabel('C')).toBe('°C');
    expect(unitLabel('F')).toBe('°F');
  });
});

describe('unit resolution', () => {
  it('prefers the preference, then HA, then °F', () => {
    expect(resolveUnit('C', 'F')).toBe('C');
    expect(resolveUnit(null, 'C')).toBe('C');
    expect(resolveUnit(undefined, null)).toBe('F');
  });

  it('reads the HA unit system', () => {
    expect(haUnitFrom({ config: { unit_system: { temperature: '°C' } } })).toBe('C');
    expect(haUnitFrom({ config: { unit_system: { temperature: '°F' } } })).toBe('F');
    expect(haUnitFrom({ config: { unit_system: { temperature: 'K' } } })).toBeNull();
    expect(haUnitFrom(undefined)).toBeNull();
  });
});

describe('temperatureUnitStore', () => {
  it('notifies once per real change of unit', () => {
    temperatureUnitStore.setPreference(null);
    temperatureUnitStore.setHaUnit(null);
    const fn = vi.fn();
    const off = temperatureUnitStore.subscribe(fn);
    temperatureUnitStore.setHaUnit('F'); // unit stays F
    expect(fn).not.toHaveBeenCalled();
    temperatureUnitStore.setPreference('C');
    expect(fn).toHaveBeenCalledTimes(1);
    temperatureUnitStore.setHaUnit('C'); // pref still wins, unit unchanged
    expect(fn).toHaveBeenCalledTimes(1);
    temperatureUnitStore.setPreference(null);
    expect(fn).toHaveBeenCalledTimes(1); // HA is C now
    temperatureUnitStore.setHaUnit('F');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(temperatureUnitStore.state.unit).toBe('F');
    off();
  });
});
