import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HungryMachinesPanel } from '../src/panel/hungry-machines-panel.js';
import { HmLoginForm } from '../src/ui/login-form.js';
import { HmConstraintEditor } from '../src/ui/constraint-editor.js';
import { HmScheduleChart } from '../src/ui/schedule-chart.js';
import { authStore, type AuthState } from '../src/store.js';
import { clearTokens, setApiBase, setTokens } from '../src/api/client.js';

if (!customElements.get('hm-login-form')) {
  customElements.define('hm-login-form', HmLoginForm);
}
if (!customElements.get('hm-schedule-chart')) {
  customElements.define('hm-schedule-chart', HmScheduleChart);
}
if (!customElements.get('hm-constraint-editor')) {
  customElements.define('hm-constraint-editor', HmConstraintEditor);
}
if (!customElements.get('hungry-machines-panel')) {
  customElements.define('hungry-machines-panel', HungryMachinesPanel);
}

type PanelEl = HungryMachinesPanel & { updateComplete: Promise<boolean> };

const SAMPLE_USER = {
  user_id: 'user-123',
  email: 'jane@example.com',
  location_zip: '60601',
  home_size_sqft: 1800,
  pricing_location: 3,
  timezone: 'America/Chicago',
  subscription_tier: 'free',
  weather_entity_id: '',
};

const SCHEDULES_EMPTY = { date: '2026-09-05', appliances: [] };

function ratesResponse(overrides: Record<string, unknown> = {}): unknown {
  return {
    pricing_location: 3,
    intervals: Array.from({ length: 48 }, (_, i) => i),
    rates_cents_per_kwh: Array<number>(48).fill(36.8),
    unit: 'cents/kWh',
    source: 'zone',
    hourly_rates_cents_per_kwh: null,
    pricing_source: 'zone',
    dynamic_zone: null,
    pricing_adder_cents_per_kwh: null,
    adder_grid_ruleset_id: null,
    delivery_tod_cents: null,
    available_dynamic_zones: [],
    available_delivery_tariffs: [],
    export_rates_cents_per_kwh: null,
    ...overrides,
  };
}

function preferencesResponse(overrides: Record<string, unknown> = {}): unknown {
  return {
    base_temperature: 72,
    savings_level: 1,
    time_away: '08:00',
    time_home: '17:00',
    optimization_mode: 'cool',
    max_concurrent_appliances: null,
    power_cap_kw: null,
    base_load_reserve_kw: 0,
    demand_charge_usd_per_kw: null,
    demand_window_start: null,
    demand_window_end: null,
    ...overrides,
  };
}

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

async function flush(el: PanelEl): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await el.updateComplete;
    await Promise.resolve();
  }
}

function clickSettings(root: ShadowRoot): void {
  const btn = Array.from(
    root.querySelectorAll<HTMLButtonElement>('nav.tabs button'),
  ).find((b) => b.textContent?.trim() === 'Settings');
  if (!btn) throw new Error('Settings tab not found');
  btn.click();
}

function powerLimitsSection(root: ShadowRoot): HTMLElement {
  const section = root.querySelector<HTMLElement>(
    '.settings-section[data-section="power-limits"]',
  );
  if (!section) throw new Error('power-limits section not found');
  return section;
}

interface FetchCall {
  url: string;
  method: string | undefined;
  body: string | undefined;
}

function installFetchStub(
  handler: (url: string, init?: RequestInit) => unknown,
): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      calls.push({
        url,
        method: init?.method,
        body: init?.body === undefined ? undefined : String(init.body),
      });
      const result = handler(url, init);
      if (result instanceof Response) return result;
      return jsonResponse(result ?? null);
    }),
  );
  return { calls };
}

function fieldInput(section: HTMLElement, name: string): HTMLInputElement {
  const input = section.querySelector<HTMLInputElement>(`input[name="${name}"]`);
  if (!input) throw new Error(`input[name="${name}"] not found`);
  return input;
}

describe('home power limits settings section (US-WHC-009)', () => {
  beforeEach(() => {
    setApiBase('https://api.example.test');
    localStorage.clear();
    clearTokens();
    setTokens({ access: 'ACCESS', refresh: 'REFRESH' });
    setAuthState({
      access: 'ACCESS',
      refresh: 'REFRESH',
      status: 'authed',
      user: { ...SAMPLE_USER },
    });
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

  it('renders the stored values', async () => {
    installFetchStub((url) => {
      if (url.includes('/api/v1/schedules')) return SCHEDULES_EMPTY;
      if (url.includes('/api/v1/appliances')) return [];
      if (url.includes('/api/v1/preferences')) {
        return preferencesResponse({
          max_concurrent_appliances: 2,
          power_cap_kw: 9,
          base_load_reserve_kw: 2,
          demand_charge_usd_per_kw: 12,
          demand_window_start: '17:00',
          demand_window_end: '21:00',
        });
      }
      if (url.includes('/api/v1/rates')) return ratesResponse();
      return null;
    });

    const el = mountPanel();
    await flush(el);
    clickSettings(el.shadowRoot!);
    await flush(el);

    const section = powerLimitsSection(el.shadowRoot!);
    expect(section.textContent).toContain('Home power limits');
    expect(fieldInput(section, 'max_concurrent_appliances').value).toBe('2');
    expect(fieldInput(section, 'power_cap_kw').value).toBe('9');
    expect(fieldInput(section, 'base_load_reserve_kw').value).toBe('2');
    expect(fieldInput(section, 'demand_charge_usd_per_kw').value).toBe('12');
    expect(fieldInput(section, 'demand_window_start').value).toBe('17:00');
    expect(fieldInput(section, 'demand_window_end').value).toBe('21:00');
  });

  it('renders blanks and a 0 reserve default when every limit is unset', async () => {
    installFetchStub((url) => {
      if (url.includes('/api/v1/schedules')) return SCHEDULES_EMPTY;
      if (url.includes('/api/v1/appliances')) return [];
      if (url.includes('/api/v1/preferences')) return preferencesResponse();
      if (url.includes('/api/v1/rates')) return ratesResponse();
      return null;
    });

    const el = mountPanel();
    await flush(el);
    clickSettings(el.shadowRoot!);
    await flush(el);

    const section = powerLimitsSection(el.shadowRoot!);
    expect(fieldInput(section, 'max_concurrent_appliances').value).toBe('');
    expect(fieldInput(section, 'power_cap_kw').value).toBe('');
    expect(fieldInput(section, 'base_load_reserve_kw').value).toBe('0');
    expect(fieldInput(section, 'demand_charge_usd_per_kw').value).toBe('');
    expect(fieldInput(section, 'demand_window_start').value).toBe('');
    expect(fieldInput(section, 'demand_window_end').value).toBe('');
  });

  it('an input change calls updatePreferences with the right numeric body', async () => {
    const putBodies: unknown[] = [];
    installFetchStub((url, init) => {
      if (url.includes('/api/v1/schedules')) return SCHEDULES_EMPTY;
      if (url.includes('/api/v1/appliances')) return [];
      if (url.includes('/api/v1/preferences')) {
        if (init?.method === 'PUT') {
          const body = JSON.parse(String(init.body));
          putBodies.push(body);
          return preferencesResponse(body);
        }
        return preferencesResponse();
      }
      if (url.includes('/api/v1/rates')) return ratesResponse();
      return null;
    });

    const el = mountPanel();
    await flush(el);
    clickSettings(el.shadowRoot!);
    await flush(el);

    const section = powerLimitsSection(el.shadowRoot!);
    const capInput = fieldInput(section, 'power_cap_kw');
    capInput.value = '9';
    capInput.dispatchEvent(new Event('change', { bubbles: true }));
    await flush(el);

    expect(putBodies).toEqual([{ power_cap_kw: 9 }]);
    expect(typeof (putBodies[0] as { power_cap_kw: unknown }).power_cap_kw).toBe('number');
  });

  it('clearing a field to empty sends null, except the reserve which sends 0', async () => {
    const putBodies: unknown[] = [];
    installFetchStub((url, init) => {
      if (url.includes('/api/v1/schedules')) return SCHEDULES_EMPTY;
      if (url.includes('/api/v1/appliances')) return [];
      if (url.includes('/api/v1/preferences')) {
        if (init?.method === 'PUT') {
          const body = JSON.parse(String(init.body));
          putBodies.push(body);
          return preferencesResponse({
            max_concurrent_appliances: 2,
            power_cap_kw: 9,
            base_load_reserve_kw: 2,
            ...body,
          });
        }
        return preferencesResponse({
          max_concurrent_appliances: 2,
          power_cap_kw: 9,
          base_load_reserve_kw: 2,
        });
      }
      if (url.includes('/api/v1/rates')) return ratesResponse();
      return null;
    });

    const el = mountPanel();
    await flush(el);
    clickSettings(el.shadowRoot!);
    await flush(el);

    const section = powerLimitsSection(el.shadowRoot!);

    const capInput = fieldInput(section, 'power_cap_kw');
    capInput.value = '';
    capInput.dispatchEvent(new Event('change', { bubbles: true }));
    await flush(el);

    const reserveInput = fieldInput(section, 'base_load_reserve_kw');
    reserveInput.value = '';
    reserveInput.dispatchEvent(new Event('change', { bubbles: true }));
    await flush(el);

    expect(putBodies).toEqual([
      { power_cap_kw: null },
      { base_load_reserve_kw: 0 },
    ]);
  });

  it('a failed PUT leaves the displayed value at the server state', async () => {
    installFetchStub((url, init) => {
      if (url.includes('/api/v1/schedules')) return SCHEDULES_EMPTY;
      if (url.includes('/api/v1/appliances')) return [];
      if (url.includes('/api/v1/preferences')) {
        if (init?.method === 'PUT') return jsonResponse({ detail: 'nope' }, 422);
        return preferencesResponse({ power_cap_kw: 9 });
      }
      if (url.includes('/api/v1/rates')) return ratesResponse();
      return null;
    });

    const el = mountPanel();
    await flush(el);
    clickSettings(el.shadowRoot!);
    await flush(el);

    const section = powerLimitsSection(el.shadowRoot!);
    const capInput = fieldInput(section, 'power_cap_kw');
    expect(capInput.value).toBe('9');

    capInput.value = '20';
    capInput.dispatchEvent(new Event('change', { bubbles: true }));
    await flush(el);

    const after = fieldInput(powerLimitsSection(el.shadowRoot!), 'power_cap_kw');
    expect(after.value).toBe('9');
  });
});
