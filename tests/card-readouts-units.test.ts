import { describe, it, expect, afterEach } from 'vitest';
import { HmThermostatCard } from '../src/cards/thermostat-card.js';
import { temperatureUnitStore, formatDelta } from '../src/utils/temperature.js';

if (!customElements.get('hm-thermostat-card')) {
  customElements.define('hm-thermostat-card', HmThermostatCard);
}

type Fmt = { _formatTemp(id: string | undefined, raw: string | null): string; hass: unknown };

function card(states: Record<string, unknown>): Fmt {
  const el = new HmThermostatCard() as unknown as Fmt;
  el.hass = { states };
  return el;
}

afterEach(() => {
  temperatureUnitStore.setPreference(null);
  temperatureUnitStore.setHaUnit(null);
});

describe('thermostat-card readouts', () => {
  it('shows a °F entity in °C', () => {
    temperatureUnitStore.setPreference('C');
    const c = card({ 'sensor.a': { state: '72', attributes: { unit_of_measurement: '°F' } } });
    expect(c._formatTemp('sensor.a', '72')).toBe('22.2°');
  });

  it('shows a °C entity in °F', () => {
    temperatureUnitStore.setPreference('F');
    const c = card({ 'sensor.a': { state: '20', attributes: { unit_of_measurement: '°C' } } });
    expect(c._formatTemp('sensor.a', '20')).toBe('68°');
  });

  it("falls back to HA's unit when the entity has none", () => {
    temperatureUnitStore.setHaUnit('C');
    temperatureUnitStore.setPreference('F');
    const c = card({ 'sensor.a': { state: '20' } });
    expect(c._formatTemp('sensor.a', '20')).toBe('68°');
  });

  it('leaves non-numeric states alone', () => {
    const c = card({});
    expect(c._formatTemp('sensor.a', 'unavailable')).toBe('unavailable°');
    expect(c._formatTemp('sensor.a', null)).toBe('—');
  });
});

describe('delta formatting', () => {
  it('applies no 32 offset', () => {
    expect(formatDelta(1.8, 'C')).toBe('1.0 °C');
    expect(formatDelta(1.8, 'F')).toBe('1.8 °F');
  });
});
