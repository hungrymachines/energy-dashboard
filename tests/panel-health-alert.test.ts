import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HungryMachinesPanel } from '../src/panel/hungry-machines-panel.js';
import { authStore } from '../src/store.js';
import { clearTokens, setApiBase } from '../src/api/client.js';

if (!customElements.get('hungry-machines-panel')) {
  customElements.define('hungry-machines-panel', HungryMachinesPanel);
}

type PanelEl = HungryMachinesPanel & { updateComplete: Promise<boolean> };

const USER = {
  user_id: 'u1',
  email: 'jane@example.com',
  location_zip: '94107',
  home_size_sqft: 1800,
  pricing_location: 3,
  timezone: 'America/Los_Angeles',
  subscription_tier: 'free',
  weather_entity_id: '',
};

function entry(name: string, status: string, alert: { message: string } | null, readings = 'healthy') {
  return {
    appliance_id: name,
    name,
    appliance_type: 'hvac',
    status,
    alert,
    readings: { status: readings, newest_age_seconds: 60, message: '' },
    command: null,
    sensors: [],
    power: { mapped: false, coverage_pct: null, matched_pct: null },
    notes: [],
  };
}

function stubFetch(health: unknown | 'fail'): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = String(url);
      let body: unknown = null;
      if (u.includes('/integration/appliances/health')) {
        if (health === 'fail') return new Response('no', { status: 500 });
        body = health;
      } else if (u.includes('/schedules')) {
        body = { date: '2026-11-15', appliances: [] };
      } else if (u.includes('/rates')) {
        body = { pricing_location: 3, intervals: [], rates_cents_per_kwh: [], unit: 'cents/kWh' };
      } else if (u.includes('/appliances')) {
        body = [];
      }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

async function mount(): Promise<PanelEl> {
  const el = document.createElement('hungry-machines-panel') as PanelEl;
  document.body.appendChild(el);
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await el.updateComplete;
  }
  return el;
}

const strip = (el: PanelEl) => el.shadowRoot!.querySelector('.health-alert');

describe('dashboard alert strip', () => {
  beforeEach(() => {
    setApiBase('https://api.example.test');
    localStorage.clear();
    vi.spyOn(authStore, 'hydrate').mockImplementation(async () => {});
    window.location.hash = '';
    authStore.state = { access: 'a', refresh: 'r', user: USER as never, status: 'authed', error: null };
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    clearTokens();
    window.location.hash = '';
  });

  it('stays hidden with only intermittent or mode-differs data', async () => {
    stubFetch({
      lookback_hours: 6,
      appliances: [entry('Den', 'ok', null), entry('Loft', 'ok', null, 'unknown')],
    });
    const el = await mount();
    expect(strip(el)).toBeNull();
  });

  it('stays hidden when the health call fails', async () => {
    stubFetch('fail');
    const el = await mount();
    expect(strip(el)).toBeNull();
  });

  it('lists a stale machine and its button opens the Connection Health tab', async () => {
    stubFetch({
      lookback_hours: 6,
      appliances: [
        entry('Den', 'ok', null),
        entry('Garage EV', 'attention', { message: 'No readings for 3 hours' }, 'stale_data'),
      ],
    });
    const el = await mount();
    const s = strip(el)!;
    expect(s).not.toBeNull();
    expect(s.textContent).toContain('Garage EV: No readings for 3 hours');
    expect(s.textContent).not.toContain('Den');
    s.querySelector('button')!.click();
    await el.updateComplete;
    expect(window.location.hash).toBe('#health');
    expect(el.shadowRoot!.querySelector('hm-connection-health')).not.toBeNull();
  });
});
