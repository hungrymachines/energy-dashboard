// Pure badge and streak logic, ported from the website's badges tests.
import { describe, expect, it } from 'vitest';
import {
  median,
  savingsAboveMedianStreak,
  peakDodgerEarned,
  fullHouseEarned,
  roomToMoveEarned,
  computeBadges,
  MAX_TOP_PEAK_IDLE_HOURS_PER_DAY,
  PEAK_DODGER_DAYS,
} from '../src/utils/badges.js';
import type { MetricsSummary, DailyEntry } from '../src/api/me-metrics.js';


function makeSummary(over: {
  days_counted?: number;
  peak_hours_idle?: number | null;
  by_type?: Record<string, number>;
  comfort?: number | null;
}): MetricsSummary {
  return {
    window: 30,
    latest_date: '2026-08-04',
    days_counted: over.days_counted ?? 30,
    savings: {
      modeled_usd: null,
      realized_usd: null,
      realized_days: 0,
      modeled_days: 0,
      savings_pct: null,
      degenerate: false,
    },
    peaks: {
      peak_hours_idle: over.peak_hours_idle === undefined ? null : over.peak_hours_idle,
      top_peak_hours_idle: null,
      off_peak_kwh_share_pct: null,
    },
    flexibility: { degree_hours: null, percent_hours: null },
    comfort: { in_band_home_pct: over.comfort === undefined ? null : over.comfort },
    adherence: { conformance_pct: null, override_events: null, override_by_hour: null },
    machines: {
      active: over.by_type ? Object.values(over.by_type).reduce((a, b) => a + b, 0) : 0,
      by_type: over.by_type ?? {},
    },
  };
}

const ALL_TYPES: Record<string, number> = {
  hvac: 1,
  water_heater: 1,
  ev_charger: 1,
  home_battery: 1,
  solar: 1,
};

function day(
  date: string,
  savings_pct: number | null,
  top_peak_hours_idle: number | null = null,
): DailyEntry {
  return {
    date,
    savings: { modeled_usd: null, realized_usd: null, savings_pct, degenerate: false },
    peaks: { peak_hours_idle: null, top_peak_hours_idle, off_peak_kwh_share_pct: null },
    flexibility: { degree_hours: null, percent_hours: null },
    comfort: { in_band_home_pct: null },
  };
}

// ---------------------------------------------------------------------------
// Pure logic
// ---------------------------------------------------------------------------

describe('median', () => {
  it('returns null on empty input', () => {
    expect(median([])).toBeNull();
  });
  it('averages the two middle values for an even count', () => {
    expect(median([10, 20, 30, 40])).toBe(25);
  });
  it('takes the middle value for an odd count regardless of order', () => {
    expect(median([50, 10, 30])).toBe(30);
  });
});

describe('savingsAboveMedianStreak', () => {
  it('counts the trailing consecutive days strictly above the window median', () => {
    // median of [10,20,30,40,50] = 30; trailing above: 50, 40 (30 is NOT > 30).
    const days = [
      day('2026-08-01', 10),
      day('2026-08-02', 20),
      day('2026-08-03', 30),
      day('2026-08-04', 40),
      day('2026-08-05', 50),
    ];
    const r = savingsAboveMedianStreak(days);
    expect(r.medianPct).toBe(30);
    expect(r.days).toBe(2);
  });

  it('breaks the streak on a calendar gap (an omitted day is not consecutive)', () => {
    // median of [10,20,50] = 20; 08-04 (50>20) counts, but 08-03 is missing so
    // 08-02 is not adjacent → streak stops at 1.
    const days = [day('2026-08-01', 10), day('2026-08-02', 20), day('2026-08-04', 50)];
    const r = savingsAboveMedianStreak(days);
    expect(r.medianPct).toBe(20);
    expect(r.days).toBe(1);
  });

  it('breaks on a null savings day', () => {
    const days = [
      day('2026-08-01', 40),
      day('2026-08-02', null),
      day('2026-08-03', 50),
    ];
    // present values [40,50] → median 45; trailing 08-03 (50>45) counts, 08-02
    // is null → break. streak 1.
    const r = savingsAboveMedianStreak(days);
    expect(r.days).toBe(1);
  });

  it('returns days 0 and medianPct null when no day carries a savings figure', () => {
    const r = savingsAboveMedianStreak([day('2026-08-01', null)]);
    expect(r.days).toBe(0);
    expect(r.medianPct).toBeNull();
  });

  it('is order-independent (sorts by date before walking from the newest)', () => {
    const days = [
      day('2026-08-05', 50),
      day('2026-08-01', 10),
      day('2026-08-04', 40),
      day('2026-08-03', 30),
      day('2026-08-02', 20),
    ];
    expect(savingsAboveMedianStreak(days).days).toBe(2);
  });
});

describe('peakDodgerEarned (three priciest hours, last three days)', () => {
  const FULL = MAX_TOP_PEAK_IDLE_HOURS_PER_DAY;

  it('is earned when each of the last three consecutive days idled all three priciest hours', () => {
    const days = [
      day('2026-08-01', null, 0),
      day('2026-08-02', null, FULL),
      day('2026-08-03', null, FULL),
      day('2026-08-04', null, FULL),
    ];
    expect(peakDodgerEarned(days)).toBe(true);
  });

  it('is not earned when one of the three days fell short', () => {
    const days = [
      day('2026-08-02', null, FULL),
      day('2026-08-03', null, 2.5),
      day('2026-08-04', null, FULL),
    ];
    expect(peakDodgerEarned(days)).toBe(false);
  });

  it('is not earned with fewer than three days of data', () => {
    expect(peakDodgerEarned([day('2026-08-03', null, FULL), day('2026-08-04', null, FULL)])).toBe(
      false,
    );
  });

  it('is not earned across a calendar gap — three days must be consecutive', () => {
    const days = [
      day('2026-08-01', null, FULL),
      day('2026-08-03', null, FULL),
      day('2026-08-04', null, FULL),
    ];
    expect(peakDodgerEarned(days)).toBe(false);
  });

  it('is not earned (never fabricated) when the metric is null on a day', () => {
    const days = [
      day('2026-08-02', null, FULL),
      day('2026-08-03', null, null),
      day('2026-08-04', null, FULL),
    ];
    expect(peakDodgerEarned(days)).toBe(false);
  });

  it('anchors on the newest day in the series, not the browser clock', () => {
    // Three perfect days well in the past still earn it — the rollup lags a day,
    // so anchoring on "today" would make the badge unearnable.
    const days = [
      day('2026-07-10', null, FULL),
      day('2026-07-11', null, FULL),
      day('2026-07-12', null, FULL),
    ];
    expect(peakDodgerEarned(days)).toBe(true);
  });

  it('reads exactly PEAK_DODGER_DAYS days', () => {
    expect(PEAK_DODGER_DAYS).toBe(3);
  });
});

describe('fullHouseEarned', () => {
  it('is earned only when all five machine types are reporting', () => {
    expect(fullHouseEarned(makeSummary({ by_type: ALL_TYPES }))).toBe(true);
  });
  it('is not earned when a type is missing', () => {
    const missing = { ...ALL_TYPES };
    delete missing.solar;
    expect(fullHouseEarned(makeSummary({ by_type: missing }))).toBe(false);
  });
  it('is not earned for a brand-new home with no machines', () => {
    expect(fullHouseEarned(makeSummary({}))).toBe(false);
  });
});

describe('roomToMoveEarned (flexibility alone, top half)', () => {
  it('is earned at or above the 50th percentile of comparable homes', () => {
    expect(roomToMoveEarned(60)).toBe(true);
    expect(roomToMoveEarned(50)).toBe(true); // the boundary is inclusive
  });

  it('is not earned below the median', () => {
    expect(roomToMoveEarned(49)).toBe(false);
    expect(roomToMoveEarned(0)).toBe(false);
  });

  it('does not depend on comfort — flexibility alone decides it', () => {
    // Comfort is irrelevant to this badge now; the percentile is the whole test.
    expect(roomToMoveEarned(70)).toBe(true);
  });

  it('is not earned (never fabricated) when the percentile is unavailable', () => {
    expect(roomToMoveEarned(null)).toBe(false);
  });
});

describe('computeBadges', () => {
  it('returns three named badges, each carrying a "how this was measured" line', () => {
    const badges = computeBadges(makeSummary({}), null, []);
    expect(badges.map((b) => b.key)).toEqual(['peak_dodger', 'full_house', 'room_to_move']);
    for (const b of badges) {
      expect(b.name.length).toBeGreaterThan(0);
      expect(b.measured.toLowerCase()).toContain('measured');
    }
  });
});

