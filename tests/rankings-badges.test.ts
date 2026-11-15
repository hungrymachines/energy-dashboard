import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HmRankingsBadges, cohortPhrase } from '../src/ui/rankings-badges.js';
import { setApiBase, setTokens } from '../src/api/client.js';

if (!customElements.get('hm-rankings-badges')) {
  customElements.define('hm-rankings-badges', HmRankingsBadges);
}

type El = HmRankingsBadges & { updateComplete: Promise<boolean> };

async function flush(el: El): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await el.updateComplete;
    await Promise.resolve();
  }
}

const peaks = (top: number | null) => ({ peak_hours_idle: null, top_peak_hours_idle: top, off_peak_kwh_share_pct: null });
const dayRow = (date: string, pct: number | null, top: number | null) => ({
  date,
  savings: { modeled_usd: null, realized_usd: null, savings_pct: pct, degenerate: false },
  peaks: peaks(top),
  flexibility: {},
  comfort: {},
});

const SUMMARY = {
  window: 30,
  latest_date: '2026-11-14',
  days_counted: 30,
  savings: {},
  peaks: peaks(null),
  flexibility: {},
  comfort: {},
  adherence: {},
  machines: { active: 5, by_type: { hvac: 1, water_heater: 1, ev_charger: 1, home_battery: 1, solar: 1 } },
};
const DAILY = {
  start: '2026-11-12',
  end: '2026-11-14',
  days: [dayRow('2026-11-12', 10, 3), dayRow('2026-11-13', 20, 3), dayRow('2026-11-14', 30, 3)],
};
const RANKINGS = {
  window: 30,
  latest_date: '2026-11-14',
  rankings: [
    { metric: 'savings_pct', cohort_kind: 'zip5', cohort_label: 'your ZIP code', rank: 2, percentile: 80, your_value: 20 },
    { metric: 'off_peak_kwh_share_pct', cohort_kind: 'fleet', cohort_label: null, rank: null, percentile: null, your_value: null },
    { metric: 'flexibility_degree_hours', cohort_kind: 'zip3', cohort_label: null, rank: 1, percentile: 75, your_value: 9 },
    { metric: 'active_appliances', cohort_kind: 'fleet', cohort_label: null, rank: 1, percentile: 99, your_value: 5 },
  ],
};

function stub(routes: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const key = Object.keys(routes).find((k) => String(url).includes(k));
      if (!key || routes[key] === 'fail') return new Response('{}', { status: 500 });
      return new Response(JSON.stringify(routes[key]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

async function mount(): Promise<El> {
  const el = document.createElement('hm-rankings-badges') as El;
  document.body.appendChild(el);
  await flush(el);
  return el;
}

const text = (el: El, sel: string) => el.shadowRoot!.querySelector(sel)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

describe('hm-rankings-badges', () => {
  beforeEach(() => {
    setApiBase('https://api.test');
    setTokens({ access: 'a', refresh: 'r' });
  });
  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('phrases the cohort without a count', () => {
    expect(cohortPhrase('zip5')).toBe('among local Hungry Machines homes');
    expect(cohortPhrase(null)).toBe('among Hungry Machines homes');
  });

  it('renders three ranking cards, an em dash for an unranked one, and no active_appliances card', async () => {
    stub({ '/me/metrics/summary': SUMMARY, '/me/metrics/daily': DAILY, '/me/rankings': RANKINGS });
    const el = await mount();
    expect(text(el, '[data-testid="ranking-savings_pct"]')).toContain('#2 among local Hungry Machines homes');
    expect(text(el, '[data-testid="ranking-off_peak_kwh_share_pct"]')).toContain('— not enough data yet');
    expect(text(el, '[data-testid="ranking-flexibility_degree_hours"]')).toContain('#1 among Hungry Machines homes in your area');
    expect(el.shadowRoot!.querySelector('[data-testid="ranking-active_appliances"]')).toBeNull();
  });

  it('shows the streak and earned badges', async () => {
    stub({ '/me/metrics/summary': SUMMARY, '/me/metrics/daily': DAILY, '/me/rankings': RANKINGS });
    const el = await mount();
    expect(text(el, '[data-testid="savings-streak"]')).toContain('1 consecutive day with savings above your 30-day median');
    for (const k of ['peak_dodger', 'full_house', 'room_to_move']) {
      expect(el.shadowRoot!.querySelector(`[data-testid="badge-${k}"]`)?.getAttribute('data-earned')).toBe('true');
    }
  });

  it('degrades when rankings and daily fail: no streak number, no Room to Move, no Peak Dodger', async () => {
    stub({ '/me/metrics/summary': SUMMARY, '/me/metrics/daily': 'fail', '/me/rankings': 'fail' });
    const el = await mount();
    expect(text(el, '[data-testid="savings-streak"]')).toContain('Your streak appears');
    expect(el.shadowRoot!.querySelector('[data-testid="badge-room_to_move"]')?.getAttribute('data-earned')).toBe('false');
    expect(el.shadowRoot!.querySelector('[data-testid="badge-peak_dodger"]')?.getAttribute('data-earned')).toBe('false');
    expect(text(el, '[data-testid="rankings"]')).toContain('Rankings appear once');
  });

  it('shows a retry banner when the summary fails', async () => {
    stub({ '/me/metrics/summary': 'fail', '/me/metrics/daily': DAILY, '/me/rankings': RANKINGS });
    const el = await mount();
    expect(el.shadowRoot!.querySelector('[role="alert"]')).not.toBeNull();
    expect(el.shadowRoot!.querySelector('[data-testid="badge-full_house"]')).toBeNull();
  });
});
