import { describe, it, expect } from 'vitest';
import { narrowHourRuns, runLabel } from '../src/utils/band-check.js';

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
