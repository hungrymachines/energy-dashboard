import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HmBuildingInfo, formatHour } from '../src/ui/building-info.js';
import { setApiBase, setTokens } from '../src/api/client.js';
import { temperatureUnitStore } from '../src/utils/temperature.js';

if (!customElements.get('hm-building-info')) {
  customElements.define('hm-building-info', HmBuildingInfo);
}

type El = HmBuildingInfo & { updateComplete: Promise<boolean> };

async function flush(el: El): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await el.updateComplete;
    await Promise.resolve();
  }
}

const hist = (peakAt: number | null) =>
  Array.from({ length: 24 }, (_, h) => (peakAt !== null && h === peakAt ? 5 : 0));

function summary(over: Record<string, unknown> = {}) {
  return {
    window: 30,
    latest_date: '2026-11-14',
    days_counted: 30,
    savings: { modeled_usd: 12.5, realized_usd: 8.25, realized_days: 20, modeled_days: 30, savings_pct: 14.2, degenerate: false },
    peaks: { peak_hours_idle: 3.5, top_peak_hours_idle: 2, off_peak_kwh_share_pct: 61.2 },
    flexibility: { degree_hours: 140.4, percent_hours: null },
    comfort: { in_band_home_pct: 90 },
    adherence: { conformance_pct: 95, override_events: 5, override_by_hour: hist(18) },
    machines: { active: 2, by_type: { hvac: 1, water_heater: 1 } },
    ...over,
  };
}

const DAILY = {
  start: '2026-11-13',
  end: '2026-11-14',
  days: [
    { date: '2026-11-13', savings: { modeled_usd: 0.5, realized_usd: null, savings_pct: 10, degenerate: false }, peaks: {}, flexibility: {}, comfort: {} },
    { date: '2026-11-14', savings: { modeled_usd: 0.4, realized_usd: 0.3, savings_pct: 9, degenerate: false }, peaks: {}, flexibility: {}, comfort: {} },
  ],
};

function stub(sum: unknown, daily: unknown = DAILY, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const body = String(url).includes('/daily') ? daily : sum;
      return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

async function mount(): Promise<El> {
  const el = document.createElement('hm-building-info') as El;
  document.body.appendChild(el);
  await flush(el);
  return el;
}

const text = (el: El, sel: string) => el.shadowRoot!.querySelector(sel)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

describe('hm-building-info', () => {
  beforeEach(() => {
    setApiBase('https://api.test');
    setTokens({ access: 'a', refresh: 'r' });
    temperatureUnitStore.setPreference('F');
  });
  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    temperatureUnitStore.setPreference(null);
  });

  it('formats hours', () => {
    expect(formatHour(0)).toBe('12 AM');
    expect(formatHour(12)).toBe('12 PM');
    expect(formatHour(18)).toBe('6 PM');
  });

  it('shows modeled and realized savings with the realized-days line', async () => {
    stub(summary());
    const el = await mount();
    const t = text(el, '[data-testid="tile-savings"]');
    expect(t).toContain('$12.50');
    expect(t).toContain('$8.25');
    expect(text(el, '[data-testid="realized-days"]')).toBe('over 20 of 30 days');
    expect(el.shadowRoot!.querySelector('[data-testid="realized-gate"]')).toBeNull();
    expect(t).toContain('14.2% off your baseline cost.');
  });

  it('explains the measured-savings gate when realized is null', async () => {
    stub(summary({ savings: { modeled_usd: 1, realized_usd: null, realized_days: 0, modeled_days: 3, savings_pct: null, degenerate: false } }));
    const el = await mount();
    expect(text(el, '[data-testid="realized-gate"]')).toContain('at least 80% as scheduled');
    expect(text(el, '[data-testid="tile-savings"]')).toContain('—');
  });

  it('shows peak, off-peak, flexibility and machine coverage', async () => {
    stub(summary());
    const el = await mount();
    expect(text(el, '[data-testid="tile-peaks-idle"]')).toContain('3.5 h');
    expect(text(el, '[data-testid="tile-offpeak"]')).toContain('61.2%');
    expect(text(el, '[data-testid="tile-flexibility"]')).toContain('140 °F·h');
    expect(text(el, '[data-testid="tile-machines"]')).toContain('2 of 8 machine types');
  });

  it('shows flexibility in Celsius and follows a unit change', async () => {
    stub(summary());
    temperatureUnitStore.setPreference('C');
    const el = await mount();
    const t = text(el, '[data-testid="tile-flexibility"]');
    expect(t).toContain('78 °C·h');
    expect(t).not.toContain('°F');
    temperatureUnitStore.setPreference('F');
    await flush(el);
    expect(text(el, '[data-testid="tile-flexibility"]')).toContain('140 °F·h');
  });

  it('counts a pool pump, hot tub or robot as a connected machine type', async () => {
    stub(summary({ machines: { active: 3, by_type: { hvac: 1, pool_pump: 1, solar: 1 } } }));
    const el = await mount();
    const t = text(el, '[data-testid="tile-machines"]');
    expect(t).toContain('3 of 8 machine types');
    expect(t).toMatch(/Pool pump ?✓ connected/);
    expect(t).toMatch(/Hot tub ?— not connected/);
  });

  it('draws the daily chart and override histogram as SVG', async () => {
    stub(summary());
    const el = await mount();
    const bars = el.shadowRoot!.querySelectorAll('[data-region="daily-chart"] rect[data-series]');
    // 3 bars: day one has no realized value, so it draws none.
    expect(bars.length).toBe(3);
    const hbars = el.shadowRoot!.querySelectorAll('rect[data-region="override-bar"]');
    expect(hbars.length).toBe(24);
    expect(el.shadowRoot!.querySelectorAll('rect[data-empty="false"]').length).toBe(1);
    expect(text(el, '[data-testid="override-histogram"]')).toContain('6 PM');
  });

  it('shows plain states for an empty histogram and missing histogram', async () => {
    stub(summary({ adherence: { conformance_pct: null, override_events: 0, override_by_hour: hist(null) } }));
    let el = await mount();
    expect(el.shadowRoot!.querySelector('[data-testid="override-hist-empty"]')).not.toBeNull();
    document.body.innerHTML = '';
    stub(summary({ adherence: { conformance_pct: null, override_events: null, override_by_hour: null } }));
    el = await mount();
    expect(el.shadowRoot!.querySelector('[data-testid="override-hist-missing"]')).not.toBeNull();
  });

  it('shows an empty state when no days are counted', async () => {
    stub({ days_counted: 0 }, { days: [] });
    const el = await mount();
    expect(el.shadowRoot!.querySelector('[data-state="empty"]')).not.toBeNull();
    expect(el.shadowRoot!.querySelector('[data-testid="tile-savings"]')).toBeNull();
  });

  it('shows an error with retry and drops the payload', async () => {
    stub({ detail: 'boom' }, {}, 500);
    const el = await mount();
    expect(el.shadowRoot!.querySelector('[role="alert"]')).not.toBeNull();
    expect(el.shadowRoot!.querySelector('[data-testid="tile-savings"]')).toBeNull();
  });
});
