import { describe, it, expect } from 'vitest';
import {
  bandCheckReason,
  liveOffsetFor,
  liveOffsetNote,
  narrowHourRuns,
  offsetNote,
  runLabel,
} from '../src/utils/band-check.js';

describe('narrowHourRuns', () => {
  const lows = Array(24).fill(69);

  it('groups consecutive narrow hours and keeps the narrowest width', () => {
    const highs = [...Array(4).fill(70), ...Array(4).fill(71), ...Array(14).fill(74), 71, 71];
    expect(narrowHourRuns(lows, highs, 2.5)).toEqual([
      { day: 'every', start_hour: 0, end_hour: 8, width_f: 1 },
      { day: 'every', start_hour: 22, end_hour: 24, width_f: 2 },
    ]);
  });

  it('does not flag a range exactly wide enough', () => {
    expect(narrowHourRuns(lows, Array(24).fill(71.5), 2.5)).toEqual([]);
  });

  it('skips hours with a missing or inverted edge', () => {
    const highs: Array<number | null> = [null, 68, ...Array(22).fill(74)];
    expect(narrowHourRuns(lows, highs, 2.5)).toEqual([]);
  });
});

describe('runLabel', () => {
  it('puts the weekday in front of a single day\'s run', () => {
    expect(runLabel({ day: 'every', start_hour: 0, end_hour: 8 })).toBe('00:00–08:00');
    expect(runLabel({ day: 'sun', start_hour: 22, end_hour: 24 })).toBe('Sun 22:00–24:00');
  });
});

describe('offsetNote', () => {
  it('inside the limit: says how far outside the range the unit may be set', () => {
    const text = offsetNote({ sensor_gap_f: 2, offset_limit_f: 3, offset_capped: false }, false, 'F');
    expect(text).toContain('about 2.0 °F cooler than your room sensor');
    expect(text).toContain('may be set up to 3.0 °F outside it');
  });

  it('past the limit: says so and names the three ways out', () => {
    const text = offsetNote({ sensor_gap_f: 4.5, offset_limit_f: 3, offset_capped: true }, false, 'F');
    expect(text).toContain('more than the 3.0 °F a unit may be set outside your range');
    expect(text).toContain('turn on the wider offset below, map a different temperature sensor to this unit, or widen the range');
  });

  it('with the wider offset on, a 4.5 °F difference is inside the 6 °F limit', () => {
    const text = offsetNote({ sensor_gap_f: 4.5, offset_limit_f: 3, offset_capped: true }, true, 'F');
    expect(text).toContain('may be set up to 6.0 °F outside it');
  });

  it('past 6 °F with the option on: two ways out are left', () => {
    const text = offsetNote({ sensor_gap_f: 7, offset_limit_f: 6, offset_capped: true }, true, 'F');
    expect(text).toContain('more than the 6.0 °F');
    expect(text).not.toContain('turn on the wider offset');
    expect(text).toContain('map a different temperature sensor to this unit, or widen the range');
  });

  it('gives differences in °C without the 32 offset', () => {
    expect(offsetNote({ sensor_gap_f: 1.8, offset_limit_f: 3, offset_capped: false }, false, 'C')).toContain(
      'about 1.0 °C cooler',
    );
  });
});

describe('liveOffsetFor and liveOffsetNote', () => {
  const hass = {
    states: {
      'sensor.hungry_machines_front_ac_schedule': {
        attributes: {
          appliance_id: 'a-1', setpoint_offset_f: -3, setpoint_offset_limited: true,
          setpoint_offset_limit_f: 3,
        },
      },
      'sensor.hungry_machines_office_schedule': {
        attributes: { appliance_id: 'a-2', setpoint_offset_f: -0.5, setpoint_offset_limit_f: 3 },
      },
      'sensor.other': { attributes: { appliance_id: 'a-3' } },
    },
  };

  it('reads what the integration publishes for one appliance', () => {
    expect(liveOffsetFor(hass, 'a-1')).toEqual({ offset_f: -3, limited: true, limit_f: 3 });
    expect(liveOffsetFor(hass, 'a-2')).toEqual({ offset_f: -0.5, limited: false, limit_f: 3 });
    expect(liveOffsetFor(hass, 'a-3')).toBeNull();
    expect(liveOffsetFor(hass, 'nope')).toBeNull();
    expect(liveOffsetFor(undefined, 'a-1')).toBeNull();
  });

  it('says nothing for an offset under a degree', () => {
    expect(liveOffsetNote(liveOffsetFor(hass, 'a-2'), false, 'F')).toBe('');
    expect(liveOffsetNote(null, false, 'F')).toBe('');
  });

  it('says which way the unit is set, and flags the limit', () => {
    const text = liveOffsetNote(liveOffsetFor(hass, 'a-1'), false, 'F');
    expect(text).toContain('set 3.0 °F below the temperature the plan wants in the room');
    expect(text).toContain('That is the 3.0 °F limit, and the room is still off its target');
    expect(text).toContain('turn on the wider offset below');
    expect(liveOffsetNote({ offset_f: 2, limited: false, limit_f: 3 }, false, 'F')).toContain(
      'set 2.0 °F above',
    );
  });
});

describe('bandCheckReason', () => {
  it('is empty when no range is too narrow', () => {
    expect(bandCheckReason({ sensor_gap_f: 2, min_width_f: null, offset_limit_f: 3 }, 'F')).toBe('');
  });
});
