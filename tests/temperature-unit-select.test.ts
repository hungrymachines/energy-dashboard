import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HungryMachinesPanel } from '../src/panel/hungry-machines-panel.js';
import { HmLoginForm } from '../src/ui/login-form.js';
import { HmConstraintEditor } from '../src/ui/constraint-editor.js';
import { HmScheduleChart } from '../src/ui/schedule-chart.js';
import { authStore, type AuthState } from '../src/store.js';
import { temperatureUnitStore } from '../src/utils/temperature.js';
import { chartScaleStore } from '../src/utils/chart-scale.js';
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
    available_dynamic_zones: [
      { slug: 'comed', label: 'ComEd (Northern Illinois)' },
      { slug: 'ameren', label: 'Ameren Illinois (Power Smart Pricing)' },
    ],
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

function pricingSection(root: ShadowRoot): HTMLElement {
  const section = root.querySelector<HTMLElement>(
    '.settings-section[data-section="pricing-source"]',
  );
  if (!section) throw new Error('pricing-source section not found');
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


function unitSelect(el: PanelEl): HTMLSelectElement {
  const s = el.shadowRoot!.querySelector<HTMLSelectElement>('select[name="temperature_unit"]');
  if (!s) throw new Error('unit select not found');
  return s;
}

describe('temperature unit selector', () => {
  beforeEach(() => {
    setApiBase('https://api.example.test');
    localStorage.clear();
    clearTokens();
    setTokens({ access: 'ACCESS', refresh: 'REFRESH' });
    setAuthState({ access: 'ACCESS', refresh: 'REFRESH', status: 'authed', user: { ...SAMPLE_USER } });
    vi.spyOn(authStore, 'hydrate').mockImplementation(async () => {});
    temperatureUnitStore.setPreference(null);
    temperatureUnitStore.setHaUnit(null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    localStorage.clear();
    clearTokens();
    setAuthState({});
  });

  async function open(prefs: Record<string, unknown>, putStatus = 200) {
    const stub = installFetchStub((url, init) => {
      if (url.includes('/api/v1/schedules')) return SCHEDULES_EMPTY;
      if (url.includes('/api/v1/appliances')) return [];
      if (url.includes('/api/v1/preferences')) {
        if (init?.method === 'PUT') {
          if (putStatus !== 200) return jsonResponse({ detail: 'no' }, putStatus);
          return preferencesResponse({ ...prefs, ...JSON.parse(String(init.body)) });
        }
        return preferencesResponse(prefs);
      }
      if (url.includes('/api/v1/rates')) return ratesResponse();
      return null;
    });
    const el = mountPanel();
    el.hass = { config: { unit_system: { temperature: '°C' } } };
    await flush(el);
    clickSettings(el.shadowRoot!);
    await flush(el);
    return { el, stub };
  }

  const puts = (calls: FetchCall[]) =>
    calls.filter((c) => c.method === 'PUT' && c.url.includes('/preferences')).map((c) => JSON.parse(c.body!));

  it('renders the live HA unit in the first option', async () => {
    const { el } = await open({});
    expect(unitSelect(el).options[0]!.textContent).toBe("Use Home Assistant's setting (°C)");
    expect(el.shadowRoot!.querySelector('.settings-section')!.getAttribute('data-section')).toBe('temperature-units');
  });

  it('sends C, then null for the HA option', async () => {
    const { el, stub } = await open({});
    const s = unitSelect(el);
    s.value = 'C';
    s.dispatchEvent(new Event('change'));
    await flush(el);
    s.value = '';
    s.dispatchEvent(new Event('change'));
    await flush(el);
    expect(puts(stub.calls)).toEqual([{ temperature_unit: 'C' }, { temperature_unit: null }]);
  });

  it('reverts and shows an error when the save fails', async () => {
    const { el } = await open({ temperature_unit: 'F' }, 500);
    const s = unitSelect(el);
    s.value = 'C';
    s.dispatchEvent(new Event('change'));
    await flush(el);
    expect(unitSelect(el).value).toBe('F');
    expect(el.shadowRoot!.textContent).toContain('Could not save the unit');
  });

  it('resolves a preference of F on a Celsius HA to F', async () => {
    const { el } = await open({ temperature_unit: 'F' });
    expect(temperatureUnitStore.state.haUnit).toBe('C');
    expect(temperatureUnitStore.state.unit).toBe('F');
    expect(unitSelect(el).value).toBe('F');
  });
});

describe('chart scale selectors', () => {
  beforeEach(() => {
    setApiBase('https://api.example.test');
    localStorage.clear();
    chartScaleStore.reset();
    clearTokens();
    setTokens({ access: 'ACCESS', refresh: 'REFRESH' });
    setAuthState({ access: 'ACCESS', refresh: 'REFRESH', status: 'authed', user: { ...SAMPLE_USER } });
    vi.spyOn(authStore, 'hydrate').mockImplementation(async () => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    localStorage.clear();
    chartScaleStore.reset();
    clearTokens();
    setAuthState({});
  });

  async function openSettings(prefs: Record<string, unknown> = {}, putStatus = 200) {
    const stub = installFetchStub((url, init) => {
      if (url.includes('/api/v1/schedules')) return SCHEDULES_EMPTY;
      if (url.includes('/api/v1/appliances')) return [];
      if (url.includes('/api/v1/preferences')) {
        if (init?.method === 'PUT') {
          if (putStatus !== 200) return jsonResponse({ detail: 'no' }, putStatus);
          return preferencesResponse({ ...prefs, ...JSON.parse(String(init.body)) });
        }
        return preferencesResponse(prefs);
      }
      if (url.includes('/api/v1/rates')) return ratesResponse();
      return null;
    });
    const el = mountPanel();
    await flush(el);
    clickSettings(el.shadowRoot!);
    await flush(el);
    return { el, stub };
  }

  const select = (el: PanelEl, name: string): HTMLSelectElement => {
    const s = el.shadowRoot!.querySelector<HTMLSelectElement>(`select[name="${name}"]`);
    if (!s) throw new Error(`${name} select not found`);
    return s;
  };

  async function choose(el: PanelEl, name: string, value: string): Promise<void> {
    const s = select(el, name);
    s.value = value;
    s.dispatchEvent(new Event('change'));
    await flush(el);
  }

  it('defaults to Standard and Max when the account has no choice', async () => {
    const { el } = await openSettings({ chart_scale: null, solar_chart_scale: null });
    expect(select(el, 'chart_scale').value).toBe('standard');
    expect(select(el, 'solar_chart_scale').value).toBe('max');
  });

  it("shows the account's saved choices", async () => {
    const { el } = await openSettings({ chart_scale: 'dynamic', solar_chart_scale: 'dynamic' });
    expect(select(el, 'chart_scale').value).toBe('dynamic');
    expect(select(el, 'solar_chart_scale').value).toBe('dynamic');
    expect(chartScaleStore.state).toEqual({ temperature: 'dynamic', solar: 'dynamic' });
  });

  it.each([
    ['chart_scale', 'dynamic', { temperature: 'dynamic', solar: 'max' }],
    ['solar_chart_scale', 'dynamic', { temperature: 'standard', solar: 'dynamic' }],
  ] as const)('saves %s to the account', async (name, value, state) => {
    const { el, stub } = await openSettings();
    await choose(el, name, value);
    const puts = stub.calls.filter((c) => c.method === 'PUT' && c.url.includes('/api/v1/preferences'));
    expect(puts).toHaveLength(1);
    expect(JSON.parse(puts[0].body!)).toEqual({ [name]: value });
    expect(chartScaleStore.state).toEqual(state);
    expect(select(el, name).value).toBe(value);
  });

  it('reverts and shows an error when the save fails', async () => {
    const { el } = await openSettings({}, 500);
    await choose(el, 'chart_scale', 'dynamic');
    expect(chartScaleStore.state.temperature).toBe('standard');
    expect(el.shadowRoot!.querySelector('[data-section="chart-scale"] .zone-error')?.textContent).toContain(
      'Could not save the chart scale',
    );
  });
});
