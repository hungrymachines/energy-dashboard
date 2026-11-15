import { describe, expect, it } from 'vitest';
import { normalizeDaily, normalizeRankings, normalizeSummary } from '../src/api/me-metrics.js';
import { normalizeAppliancesHealth, normalizeHomeFacts } from '../src/api/appliance-health.js';

describe('normalizeSummary', () => {
  it('turns an empty body into nulls and zero machines', () => {
    const s = normalizeSummary({});
    expect(s.savings.modeled_usd).toBeNull();
    expect(s.savings.degenerate).toBe(false);
    expect(s.adherence.override_by_hour).toBeNull();
    expect(s.machines).toEqual({ active: 0, by_type: {} });
    expect(s.window).toBe(30);
  });

  it('keeps real numbers, parses numeric strings, drops garbage', () => {
    const s = normalizeSummary({
      window: 7,
      savings: { modeled_usd: '4.5', realized_usd: 'x', savings_pct: 12 },
      machines: { active: 2, by_type: { hvac: 1, bad: 'n/a' } },
    });
    expect(s.savings.modeled_usd).toBe(4.5);
    expect(s.savings.realized_usd).toBeNull();
    expect(s.savings.savings_pct).toBe(12);
    expect(s.machines.by_type).toEqual({ hvac: 1 });
    expect(s.window).toBe(7);
  });

  it('accepts only a full 24-entry histogram', () => {
    expect(normalizeSummary({ adherence: { override_by_hour: [1, 2] } }).adherence.override_by_hour).toBeNull();
    const ok = Array.from({ length: 24 }, (_, i) => i);
    expect(normalizeSummary({ adherence: { override_by_hour: ok } }).adherence.override_by_hour).toEqual(ok);
    const neg = [...ok];
    neg[3] = -1;
    expect(normalizeSummary({ adherence: { override_by_hour: neg } }).adherence.override_by_hour).toBeNull();
  });

  it('survives a non-object body', () => {
    expect(normalizeSummary(null).days_counted).toBe(0);
  });
});

describe('normalizeDaily', () => {
  it('drops rows without a date and keeps the rest', () => {
    const r = normalizeDaily({ days: [{ savings: { modeled_usd: 1 } }, { date: '2026-11-01', peaks: { top_peak_hours_idle: 3 } }] });
    expect(r.days).toHaveLength(1);
    expect(r.days[0].peaks.top_peak_hours_idle).toBe(3);
    expect(r.days[0].savings.modeled_usd).toBeNull();
  });

  it('turns a thin body into an empty series', () => {
    expect(normalizeDaily(undefined)).toEqual({ start: null, end: null, days: [] });
  });
});

describe('normalizeRankings', () => {
  it('never returns rank 0 and drops population counts', () => {
    const r = normalizeRankings({
      rankings: [
        { metric: 'savings_pct', rank: 0, percentile: 50, n: 40, count: 9 },
        { metric: 'off_peak_kwh_share_pct', rank: 3.2, cohort_label: 'your ZIP code', total: 12 },
      ],
    });
    expect(r.rankings[0].rank).toBeNull();
    expect(r.rankings[1].rank).toBe(3);
    expect(Object.keys(r.rankings[1]).sort()).toEqual(
      ['cohort_kind', 'cohort_label', 'metric', 'percentile', 'rank', 'your_value'],
    );
  });
});

describe('normalizeAppliancesHealth', () => {
  it('fills a partial entry and skips one with no id', () => {
    const h = normalizeAppliancesHealth({
      appliances: [{ name: 'orphan' }, { appliance_id: 'a1', status: 'attention', alert: { message: 'No readings' } }],
    });
    expect(h.appliances).toHaveLength(1);
    const e = h.appliances[0];
    expect(e.status).toBe('attention');
    expect(e.alert).toEqual({ message: 'No readings' });
    expect(e.readings.status).toBe('unknown');
    expect(e.command).toBeNull();
    expect(e.sensors).toEqual([]);
    expect(e.power.mapped).toBe(false);
  });

  it('maps an unknown status to ok and keeps extra command fields', () => {
    const e = normalizeAppliancesHealth({
      appliances: [{ appliance_id: 'a', status: 'weird', command: { verdict: 'healthy', setpoint_hold_fail_pct: 4 } }],
    }).appliances[0];
    expect(e.status).toBe('ok');
    expect(e.command?.verdict).toBe('healthy');
    expect(e.command?.setpoint_hold_fail_pct).toBe(4);
  });

  it('handles an empty body', () => {
    expect(normalizeAppliancesHealth({}).appliances).toEqual([]);
  });
});

describe('normalizeHomeFacts', () => {
  it('treats a machine with no facts as learning when the flag is absent', () => {
    const h = normalizeHomeFacts({ appliances: [{ appliance_id: 'a', facts: [] }, { name: 'no id' }] });
    expect(h.appliances).toHaveLength(1);
    expect(h.appliances[0].learning).toBe(true);
  });

  it('keeps facts with a key and nulls a non-finite value', () => {
    const m = normalizeHomeFacts({
      appliances: [{ appliance_id: 'a', learning: false, facts: [{ key: 'k', value: 1.5, unit: 'F' }, { value: 3 }, { key: 'z', value: {} }] }],
    }).appliances[0];
    expect(m.learning).toBe(false);
    expect(m.facts.map((f) => [f.key, f.value])).toEqual([['k', 1.5], ['z', null]]);
  });
});
