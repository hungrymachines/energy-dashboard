import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HungryMachinesPanel } from '../src/panel/hungry-machines-panel.js';
import { HmLoginForm } from '../src/ui/login-form.js';
import { HmScheduleChart } from '../src/ui/schedule-chart.js';
import { authStore, type AuthState } from '../src/store.js';
import { clearTokens, setApiBase } from '../src/api/client.js';

if (!customElements.get('hm-login-form')) {
  customElements.define('hm-login-form', HmLoginForm);
}
if (!customElements.get('hm-schedule-chart')) {
  customElements.define('hm-schedule-chart', HmScheduleChart);
}
if (!customElements.get('hungry-machines-panel')) {
  customElements.define('hungry-machines-panel', HungryMachinesPanel);
}

type PanelEl = HungryMachinesPanel & { updateComplete: Promise<boolean> };

const SAMPLE_USER = {
  user_id: 'user-123',
  email: 'jane@example.com',
  location_zip: '94107',
  home_size_sqft: 1800,
  pricing_location: 3,
  timezone: 'America/Los_Angeles',
  subscription_tier: 'free',
};

const RATES = Array.from({ length: 48 }, (_, i) => 10 + (i % 3) * 5);

const HVAC_SCHEDULE = {
  appliance_id: 'hvac-1',
  appliance_type: 'hvac' as const,
  name: 'Living Room AC',
  schedule: {
    intervals: Array.from({ length: 48 }, (_, i) => i),
    high_temps: Array<number>(48).fill(74),
    low_temps: Array<number>(48).fill(70),
  },
  savings_pct: 18.5,
  source: 'optimization',
};

const EV_SCHEDULE = {
  appliance_id: 'ev-1',
  appliance_type: 'ev_charger' as const,
  name: 'Tesla Model 3',
  schedule: {
    intervals: Array<boolean>(48).fill(false).map((_, i) => i >= 20 && i < 28),
    value_trajectory: Array.from({ length: 48 }, (_, i) => 30 + i),
    unit: 'percent',
  },
  savings_pct: 32.1,
  source: 'optimization',
};

const SCHEDULES_RESPONSE = {
  date: '2025-11-18',
  appliances: [HVAC_SCHEDULE, EV_SCHEDULE],
};

const RATES_RESPONSE = {
  pricing_location: 3,
  intervals: Array.from({ length: 48 }, (_, i) => i),
  rates_cents_per_kwh: RATES,
  unit: 'cents/kWh',
};

function setAuthState(partial: Partial<AuthState>): void {
  authStore.state = {
    access: null,
    refresh: null,
    user: null,
    status: 'unauthed',
    error: null,
    ...partial,
  };
}

function mountPanel(): PanelEl {
  const el = document.createElement('hungry-machines-panel') as PanelEl;
  document.body.appendChild(el);
  return el;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function installFetchStub(routes: Record<string, unknown>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      for (const [path, body] of Object.entries(routes)) {
        if (url.includes(path)) return jsonResponse(body);
      }
      return new Response('{"detail":"not found"}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

const PREFS_DEFAULT = {
  base_temperature: 72,
  savings_level: 50,
  time_away: '09:00',
  time_home: '17:00',
  optimization_mode: 'balanced',
  hourly_high_temps_f: null,
  hourly_low_temps_f: null,
};

async function flush(el: PanelEl): Promise<void> {
  // Allow the in-flight fetch + resulting state updates to settle.
  for (let i = 0; i < 5; i++) {
    await el.updateComplete;
    await Promise.resolve();
  }
}

describe('hungry-machines-panel dashboard (US-FE-07)', () => {
  beforeEach(() => {
    setApiBase('https://api.example.test');
    localStorage.clear();
    clearTokens();
    setAuthState({});
    vi.spyOn(authStore, 'hydrate').mockImplementation(async () => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    localStorage.clear();
    clearTokens();
    setAuthState({});
  });

  it('renders one schedule chart per appliance with name + savings', async () => {
    installFetchStub({
      '/api/v1/schedules': SCHEDULES_RESPONSE,
      '/api/v1/rates': RATES_RESPONSE,
    });
    setAuthState({
      access: 'ACCESS',
      refresh: 'REFRESH',
      status: 'authed',
      user: SAMPLE_USER,
    });

    const el = mountPanel();
    el._view = 'dashboard';
    await flush(el);

    const root = el.shadowRoot!;
    const charts = root.querySelectorAll('hm-schedule-chart');
    expect(charts.length).toBe(2);

    const content = root.querySelector('section.content')!;
    expect(content.textContent).toContain('Living Room AC');
    expect(content.textContent).toContain('Tesla Model 3');
    expect(content.textContent).toMatch(/19%\s+savings today/);
    expect(content.textContent).toMatch(/32%\s+savings today/);
  });

  it('renders the empty state when no appliances are registered', async () => {
    installFetchStub({
      '/api/v1/schedules': { date: '2025-11-18', appliances: [] },
      '/api/v1/rates': RATES_RESPONSE,
    });
    setAuthState({
      access: 'ACCESS',
      refresh: 'REFRESH',
      status: 'authed',
      user: SAMPLE_USER,
    });

    const el = mountPanel();
    el._view = 'dashboard';
    await flush(el);

    const content = el.shadowRoot!.querySelector('section.content')!;
    expect(content.textContent).toContain('No appliances registered yet');
    expect(el.shadowRoot!.querySelectorAll('hm-schedule-chart').length).toBe(0);
  });

  it('renders an error with a Retry button when /schedules fails and retry re-fetches', async () => {
    // First call: 500 for schedules. Second call (after retry): success.
    let callCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        callCount += 1;
        if (url.includes('/api/v1/schedules')) {
          if (callCount <= 2) {
            return new Response('{"detail":"boom"}', {
              status: 500,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          return jsonResponse(SCHEDULES_RESPONSE);
        }
        if (url.includes('/api/v1/rates')) return jsonResponse(RATES_RESPONSE);
        return new Response('{}', { status: 404 });
      }),
    );

    setAuthState({
      access: 'ACCESS',
      refresh: 'REFRESH',
      status: 'authed',
      user: SAMPLE_USER,
    });

    const el = mountPanel();
    el._view = 'dashboard';
    await flush(el);

    const root = el.shadowRoot!;
    expect(root.querySelector('.error')!.textContent).toContain(
      'Could not load schedules',
    );

    const retry = Array.from(
      root.querySelectorAll<HTMLButtonElement>('button'),
    ).find((b) => b.textContent?.trim() === 'Retry');
    expect(retry).toBeDefined();

    retry!.click();
    await flush(el);

    expect(root.querySelector('.error')).toBeNull();
    expect(root.querySelectorAll('hm-schedule-chart').length).toBe(2);
  });
});

describe('hungry-machines-panel comfort overlay (US-FE-CHART-OVERLAY-01)', () => {
  beforeEach(() => {
    setApiBase('https://api.example.test');
    localStorage.clear();
    clearTokens();
    setAuthState({});
    vi.spyOn(authStore, 'hydrate').mockImplementation(async () => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    localStorage.clear();
    clearTokens();
    setAuthState({});
  });

  it('expands hourly comfort bands to length 48 and passes them to the HVAC chart', async () => {
    const prefs = {
      ...PREFS_DEFAULT,
      hourly_high_temps_f: Array<number>(24).fill(74),
      hourly_low_temps_f: Array<number>(24).fill(70),
    };
    installFetchStub({
      '/api/v1/schedules': SCHEDULES_RESPONSE,
      '/api/v1/rates': RATES_RESPONSE,
      '/api/v1/preferences': prefs,
    });
    setAuthState({
      access: 'ACCESS',
      refresh: 'REFRESH',
      status: 'authed',
      user: SAMPLE_USER,
    });

    const el = mountPanel();
    el._view = 'dashboard';
    await flush(el);

    const root = el.shadowRoot!;
    const charts = Array.from(
      root.querySelectorAll<HTMLElement & { comfortHighs?: number[]; comfortLows?: number[] }>('hm-schedule-chart'),
    );
    expect(charts.length).toBe(2);
    const hvacCard = root.querySelector('.card[data-appliance-type="hvac"]')!;
    const hvacChart = hvacCard.querySelector<
      HTMLElement & { comfortHighs?: number[]; comfortLows?: number[] }
    >('hm-schedule-chart')!;
    expect(Array.isArray(hvacChart.comfortHighs)).toBe(true);
    expect(hvacChart.comfortHighs!.length).toBe(48);
    expect(hvacChart.comfortHighs!.every((v) => v === 74)).toBe(true);
    expect(Array.isArray(hvacChart.comfortLows)).toBe(true);
    expect(hvacChart.comfortLows!.length).toBe(48);
    expect(hvacChart.comfortLows!.every((v) => v === 70)).toBe(true);

    const evCard = root.querySelector('.card[data-appliance-type="ev_charger"]')!;
    const evChart = evCard.querySelector<
      HTMLElement & { comfortHighs?: number[] }
    >('hm-schedule-chart')!;
    expect(evChart.comfortHighs).toBeUndefined();

    expect(hvacCard.textContent).toContain('Your comfort range');
    expect(evCard.textContent).not.toContain('Your comfort range');
  });

  it('omits the comfort overlay when hourly bands are not set in preferences', async () => {
    installFetchStub({
      '/api/v1/schedules': SCHEDULES_RESPONSE,
      '/api/v1/rates': RATES_RESPONSE,
      '/api/v1/preferences': PREFS_DEFAULT,
    });
    setAuthState({
      access: 'ACCESS',
      refresh: 'REFRESH',
      status: 'authed',
      user: SAMPLE_USER,
    });

    const el = mountPanel();
    el._view = 'dashboard';
    await flush(el);

    const root = el.shadowRoot!;
    const hvacCard = root.querySelector('.card[data-appliance-type="hvac"]')!;
    const hvacChart = hvacCard.querySelector<
      HTMLElement & { comfortHighs?: number[]; comfortLows?: number[] }
    >('hm-schedule-chart')!;
    expect(hvacChart.comfortHighs).toBeUndefined();
    expect(hvacChart.comfortLows).toBeUndefined();
    expect(hvacCard.textContent).not.toContain('Your comfort range');
  });

  it('_openEditor for hvac seeds from _preferences, not appliance.config (US-FE-HVAC-EDITOR-PREFS-01)', async () => {
    const prefs = {
      ...PREFS_DEFAULT,
      base_temperature: 71,
      savings_level: 2,
      time_away: '07:30',
      time_home: '18:00',
    };
    const APPLIANCES = [
      {
        id: 'hvac-1',
        user_id: 'user-123',
        appliance_type: 'hvac',
        name: 'Living Room AC',
        config: { hvac_type: 'central', home_size_sqft: 1800 },
        is_active: true,
        created_at: '2026-01-01T00:00:00Z',
      },
      {
        id: 'ev-1',
        user_id: 'user-123',
        appliance_type: 'ev_charger',
        name: 'Tesla Model 3',
        config: { battery_capacity_kwh: 75, max_charge_rate_kw: 11 },
        is_active: true,
        created_at: '2026-01-01T00:00:00Z',
      },
    ];
    installFetchStub({
      '/api/v1/schedules': SCHEDULES_RESPONSE,
      '/api/v1/rates': RATES_RESPONSE,
      '/api/v1/preferences': prefs,
      '/api/v1/appliances': APPLIANCES,
    });
    setAuthState({
      access: 'ACCESS',
      refresh: 'REFRESH',
      status: 'authed',
      user: SAMPLE_USER,
    });

    const el = mountPanel();
    el._view = 'dashboard';
    await flush(el);

    // HVAC: editor is seeded from _preferences (which includes time_away/time_home),
    // not from appliance.config (which only has hvac_type/home_size_sqft).
    (el as unknown as { _openEditor: (id: string, t: string) => void })._openEditor(
      'hvac-1',
      'hvac',
    );
    await flush(el);
    const constraintsHvac = (el as unknown as { _editorConstraints: Record<string, unknown> })
      ._editorConstraints;
    expect(constraintsHvac['base_temperature']).toBe(71);
    expect(constraintsHvac['savings_level']).toBe(2);
    expect(constraintsHvac['time_away']).toBe('07:30');
    expect(constraintsHvac['time_home']).toBe('18:00');
    expect('hvac_type' in constraintsHvac).toBe(false);
    expect('home_size_sqft' in constraintsHvac).toBe(false);

    // Non-HVAC: editor is still seeded from appliance.config.
    (el as unknown as { _openEditor: (id: string, t: string) => void })._openEditor(
      'ev-1',
      'ev_charger',
    );
    await flush(el);
    const constraintsEv = (el as unknown as { _editorConstraints: Record<string, unknown> })
      ._editorConstraints;
    expect(constraintsEv['battery_capacity_kwh']).toBe(75);
    expect(constraintsEv['max_charge_rate_kw']).toBe(11);
  });

  it('still renders the dashboard when /preferences fetch fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        if (url.includes('/api/v1/preferences')) {
          return new Response('{"detail":"boom"}', {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.includes('/api/v1/schedules')) return jsonResponse(SCHEDULES_RESPONSE);
        if (url.includes('/api/v1/rates')) return jsonResponse(RATES_RESPONSE);
        return new Response('{}', { status: 404 });
      }),
    );

    setAuthState({
      access: 'ACCESS',
      refresh: 'REFRESH',
      status: 'authed',
      user: SAMPLE_USER,
    });

    const el = mountPanel();
    el._view = 'dashboard';
    await flush(el);

    const root = el.shadowRoot!;
    expect(root.querySelector('.error')).toBeNull();
    const charts = root.querySelectorAll<
      HTMLElement & { comfortHighs?: number[]; comfortLows?: number[] }
    >('hm-schedule-chart');
    expect(charts.length).toBe(2);
    for (const c of charts) {
      expect(c.comfortHighs).toBeUndefined();
      expect(c.comfortLows).toBeUndefined();
    }
    expect(root.textContent).not.toContain('Your comfort range');
  });
});
