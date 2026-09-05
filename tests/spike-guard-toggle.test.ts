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
    available_dynamic_zones: [
      { slug: 'comed', iso: 'PJM', label: 'ComEd (Northern Illinois)' },
      { slug: 'ameren', iso: 'MISO', label: 'Ameren Illinois (Power Smart Pricing)' },
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

describe('spike guard toggle (US-RTG-026)', () => {
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

  it('is absent when pricing source is zone (not dynamic)', async () => {
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

    const section = pricingSection(el.shadowRoot!);
    expect(section.querySelector('.spike-guard-field')).toBeNull();
  });

  it('is absent for a dynamic user on a non-ComEd region (ameren)', async () => {
    installFetchStub((url) => {
      if (url.includes('/api/v1/schedules')) return SCHEDULES_EMPTY;
      if (url.includes('/api/v1/appliances')) return [];
      if (url.includes('/api/v1/preferences')) return preferencesResponse();
      if (url.includes('/api/v1/rates')) {
        return ratesResponse({ source: 'dynamic', pricing_source: 'dynamic', dynamic_zone: 'ameren' });
      }
      return null;
    });

    const el = mountPanel();
    await flush(el);
    clickSettings(el.shadowRoot!);
    await flush(el);

    const section = pricingSection(el.shadowRoot!);
    expect(section.querySelector('.spike-guard-field')).toBeNull();
  });

  it('renders ON by default for a ComEd dynamic user when the field is absent, and PUTs spike_guard_enabled=false on click', async () => {
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
      if (url.includes('/api/v1/rates')) {
        return ratesResponse({ source: 'dynamic', pricing_source: 'dynamic', dynamic_zone: 'comed' });
      }
      return null;
    });

    const el = mountPanel();
    await flush(el);
    clickSettings(el.shadowRoot!);
    await flush(el);

    const section = pricingSection(el.shadowRoot!);
    const field = section.querySelector<HTMLElement>('.spike-guard-field');
    expect(field).not.toBeNull();
    expect(field!.textContent).toContain('Price spike guard');
    expect(field!.textContent).toContain('Turn off any time');

    const toggle = field!.querySelector<HTMLButtonElement>('.device-opt-toggle')!;
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(toggle.textContent).toContain('On');

    toggle.click();
    await flush(el);

    expect(putBodies).toEqual([{ spike_guard_enabled: false }]);
    const after = section.querySelector<HTMLButtonElement>('.spike-guard-field .device-opt-toggle')!;
    expect(after.getAttribute('aria-checked')).toBe('false');
    expect(after.textContent).toContain('Off');
  });

  it('renders Off when preferences load with spike_guard_enabled=false', async () => {
    installFetchStub((url) => {
      if (url.includes('/api/v1/schedules')) return SCHEDULES_EMPTY;
      if (url.includes('/api/v1/appliances')) return [];
      if (url.includes('/api/v1/preferences')) {
        return preferencesResponse({ spike_guard_enabled: false });
      }
      if (url.includes('/api/v1/rates')) {
        return ratesResponse({ source: 'dynamic', pricing_source: 'dynamic', dynamic_zone: 'comed' });
      }
      return null;
    });

    const el = mountPanel();
    await flush(el);
    clickSettings(el.shadowRoot!);
    await flush(el);

    const section = pricingSection(el.shadowRoot!);
    const toggle = section.querySelector<HTMLButtonElement>('.spike-guard-field .device-opt-toggle')!;
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(toggle.textContent).toContain('Off');
  });
});
