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
  location_zip: '94107',
  home_size_sqft: 1800,
  pricing_location: 3,
  timezone: 'America/Los_Angeles',
  subscription_tier: 'free',
  weather_entity_id: '',
};

const ZONE_RATES_48 = Array<number>(48).fill(36.8);
const EXPORT_RATES_48 = Array.from({ length: 48 }, (_, i) => 10 + i);

function ratesResponse(overrides: Record<string, unknown> = {}): unknown {
  return {
    pricing_location: 3,
    intervals: Array.from({ length: 48 }, (_, i) => i),
    rates_cents_per_kwh: ZONE_RATES_48,
    unit: 'cents/kWh',
    source: 'zone',
    hourly_rates_cents_per_kwh: null,
    pricing_source: 'zone',
    dynamic_zone: null,
    pricing_adder_cents_per_kwh: null,
    available_dynamic_zones: [
      { slug: 'comed', label: 'ComEd (Northern Illinois)' },
    ],
    export_rates_cents_per_kwh: null,
    export_rate_mode: 'retail',
    export_supply_available: false,
    export_supply_basis: null,
    effective_export_rates_cents_per_kwh: ZONE_RATES_48,
    ...overrides,
  };
}

const STORED_CURVE = {
  export_rates_cents_per_kwh: EXPORT_RATES_48,
  export_rate_mode: 'custom',
  effective_export_rates_cents_per_kwh: EXPORT_RATES_48,
};

const SCHEDULES_EMPTY = {
  date: '2025-11-18',
  appliances: [],
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

// The export-rate editor lives inside the SAME `data-section="pricing-source"`
// section as the import-rate editor, but as its own `.export-fields` block —
// visible for every pricing source, not gated by Source = Custom.
function exportSection(root: ShadowRoot): HTMLElement {
  const section = root.querySelector<HTMLElement>(
    '.settings-section[data-section="pricing-source"] .export-fields',
  );
  if (!section) throw new Error('export-fields block not found');
  return section;
}

function findButtonByText(root: ShadowRoot | HTMLElement, text: string): HTMLButtonElement {
  const btn = Array.from(
    root.querySelectorAll<HTMLButtonElement>('button'),
  ).find((b) => b.textContent?.trim() === text);
  if (!btn) throw new Error(`button "${text}" not found`);
  return btn;
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

describe('settings export rates (US-SOL-022)', () => {
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

  it('opens with stored values converted to dollars', async () => {
    installFetchStub((url) => {
      if (url.includes('/api/v1/schedules')) return SCHEDULES_EMPTY;
      if (url.includes('/api/v1/appliances')) return [];
      if (url.includes('/api/v1/rates')) {
        return ratesResponse(STORED_CURVE);
      }
      return null;
    });

    const el = mountPanel();
    await flush(el);
    clickSettings(el.shadowRoot!);
    await flush(el);

    const section = exportSection(el.shadowRoot!);
    findButtonByText(section, 'Edit / Clear export rates').click();
    await flush(el);

    // Hour 0 = slot 0 = 10 cents; hour 1 = slot 2 = 12 cents.
    const input0 = section.querySelector<HTMLInputElement>('input[name="export_rate_0"]');
    const input1 = section.querySelector<HTMLInputElement>('input[name="export_rate_1"]');
    expect(input0!.value).toBe('0.100');
    expect(input1!.value).toBe('0.120');
    expect(section.querySelectorAll('input[name^="export_rate_"][type="number"]').length).toBe(24);
  });

  it('an edited hour sets both half-hours and the rest stay as stored', async () => {
    const { calls } = installFetchStub((url, init) => {
      if (url.includes('/api/v1/schedules')) return SCHEDULES_EMPTY;
      if (url.includes('/api/v1/appliances')) return [];
      if (url.includes('/api/v1/rates')) {
        if (init?.method === 'PUT') {
          const body = JSON.parse(String(init.body)) as {
            export_rates_cents_per_kwh: number[] | null;
          };
          return ratesResponse({ ...STORED_CURVE, export_rates_cents_per_kwh: body.export_rates_cents_per_kwh });
        }
        return ratesResponse(STORED_CURVE);
      }
      return null;
    });

    const el = mountPanel();
    await flush(el);
    clickSettings(el.shadowRoot!);
    await flush(el);

    const section = exportSection(el.shadowRoot!);
    findButtonByText(section, 'Edit / Clear export rates').click();
    await flush(el);

    const input1 = section.querySelector<HTMLInputElement>('input[name="export_rate_1"]')!;
    input1.value = '0.368';
    input1.dispatchEvent(new Event('input', { bubbles: true }));
    await flush(el);

    const save = findButtonByText(section, 'Save');
    expect(save.disabled).toBe(false);
    save.click();
    await flush(el);

    const put = calls.find((c) => c.url.includes('/api/v1/rates') && c.method === 'PUT');
    expect(put).toBeDefined();
    const body = JSON.parse(put!.body!) as { export_rates_cents_per_kwh: number[] };
    expect(Array.isArray(body.export_rates_cents_per_kwh)).toBe(true);
    expect(body.export_rates_cents_per_kwh.length).toBe(48);
    expect(body.export_rates_cents_per_kwh[2]).toBe(36.8);
    expect(body.export_rates_cents_per_kwh[3]).toBe(36.8);
    // Hours left alone keep their stored half-hour values.
    expect(body.export_rates_cents_per_kwh[0]).toBe(10);
    expect(body.export_rates_cents_per_kwh[1]).toBe(11);
    expect(body.export_rates_cents_per_kwh[47]).toBe(57);
    expect((JSON.parse(put!.body!) as { export_rate_mode: string }).export_rate_mode).toBe('custom');
  });

  it('an invalid row disables Save', async () => {
    installFetchStub((url) => {
      if (url.includes('/api/v1/schedules')) return SCHEDULES_EMPTY;
      if (url.includes('/api/v1/appliances')) return [];
      if (url.includes('/api/v1/rates')) {
        return ratesResponse(STORED_CURVE);
      }
      return null;
    });

    const el = mountPanel();
    await flush(el);
    clickSettings(el.shadowRoot!);
    await flush(el);

    const section = exportSection(el.shadowRoot!);
    findButtonByText(section, 'Edit / Clear export rates').click();
    await flush(el);

    const input0 = section.querySelector<HTMLInputElement>('input[name="export_rate_0"]')!;
    input0.value = '';
    input0.dispatchEvent(new Event('input', { bubbles: true }));
    await flush(el);

    expect(findButtonByText(section, 'Save').disabled).toBe(true);
    expect(input0.className).toBe('invalid');
  });

  it('Clear PUTs null', async () => {
    const { calls } = installFetchStub((url, init) => {
      if (url.includes('/api/v1/schedules')) return SCHEDULES_EMPTY;
      if (url.includes('/api/v1/appliances')) return [];
      if (url.includes('/api/v1/rates')) {
        if (init?.method === 'PUT') {
          const body = JSON.parse(String(init.body)) as {
            export_rates_cents_per_kwh: number[] | null;
          };
          if (body.export_rates_cents_per_kwh === null) {
            return ratesResponse({ export_rates_cents_per_kwh: null });
          }
        }
        return ratesResponse(STORED_CURVE);
      }
      return null;
    });

    const el = mountPanel();
    await flush(el);
    clickSettings(el.shadowRoot!);
    await flush(el);

    const section = exportSection(el.shadowRoot!);
    findButtonByText(section, 'Edit / Clear export rates').click();
    await flush(el);

    findButtonByText(section, 'Clear').click();
    await flush(el);

    const put = calls.find((c) => c.url.includes('/api/v1/rates') && c.method === 'PUT');
    expect(put).toBeDefined();
    const body = JSON.parse(put!.body!) as { export_rates_cents_per_kwh: number[] | null };
    expect(body.export_rates_cents_per_kwh).toBeNull();
  });

  function modeRadios(section: Element): Record<string, HTMLInputElement> {
    const out: Record<string, HTMLInputElement> = {};
    section
      .querySelectorAll<HTMLInputElement>('input[name="export_rate_mode"]')
      .forEach((r) => {
        out[r.value] = r;
      });
    return out;
  }

  async function settingsWith(el: PanelEl): Promise<HTMLElement> {
    await flush(el);
    clickSettings(el.shadowRoot!);
    await flush(el);
    return exportSection(el.shadowRoot!);
  }

  it('a fixed plan offers its regular rates, not a generation price', async () => {
    installFetchStub((url) => {
      if (url.includes('/api/v1/schedules')) return SCHEDULES_EMPTY;
      if (url.includes('/api/v1/appliances')) return [];
      if (url.includes('/api/v1/rates')) return ratesResponse();
      return null;
    });

    const section = await settingsWith(mountPanel());
    const radios = modeRadios(section);

    expect(Object.keys(radios)).toEqual(['retail', 'custom', 'none']);
    expect(radios['retail']!.checked).toBe(true);
    expect(section.textContent).toContain('Same as my regular rates');
  });

  it('a known Illinois plan offers the supply credit or full price, by start date', async () => {
    installFetchStub((url) => {
      if (url.includes('/api/v1/schedules')) return SCHEDULES_EMPTY;
      if (url.includes('/api/v1/appliances')) return [];
      if (url.includes('/api/v1/rates')) {
        return ratesResponse({
          pricing_source: 'dynamic',
          dynamic_zone: 'comed',
          export_rate_mode: 'supply',
          export_supply_available: true,
          export_supply_basis: 'tariff',
        });
      }
      return null;
    });

    const section = await settingsWith(mountPanel());
    const radios = modeRadios(section);

    expect(Object.keys(radios)).toEqual(['supply', 'retail', 'custom', 'none']);
    expect(radios['supply']!.checked).toBe(true);
    expect(section.textContent).toContain('Supply and transmission credit');
    expect(section.textContent).toContain('started in 2025 or later');
    expect(section.textContent).toContain('Full price, with delivery');
    expect(section.textContent).toContain('started before 2025 with no solar rebate');
  });

  it('a live price elsewhere offers the market price or full price', async () => {
    installFetchStub((url) => {
      if (url.includes('/api/v1/schedules')) return SCHEDULES_EMPTY;
      if (url.includes('/api/v1/appliances')) return [];
      if (url.includes('/api/v1/rates')) {
        return ratesResponse({
          pricing_source: 'dynamic',
          dynamic_zone: 'entsoe-nl',
          export_rate_mode: 'supply',
          export_supply_available: true,
          export_supply_basis: 'market',
        });
      }
      return null;
    });

    const section = await settingsWith(mountPanel());

    expect(Object.keys(modeRadios(section))).toEqual(['supply', 'retail', 'custom', 'none']);
    expect(section.textContent).toContain('Market price only');
    expect(section.textContent).not.toContain('started in 2025');
  });

  it('choosing a mode PUTs it and the preview follows the response', async () => {
    const { calls } = installFetchStub((url, init) => {
      if (url.includes('/api/v1/schedules')) return SCHEDULES_EMPTY;
      if (url.includes('/api/v1/appliances')) return [];
      if (url.includes('/api/v1/rates')) {
        return init?.method === 'PUT'
          ? ratesResponse({ export_rate_mode: 'none', effective_export_rates_cents_per_kwh: null })
          : ratesResponse();
      }
      return null;
    });

    const el = mountPanel();
    const section = await settingsWith(el);
    expect(section.querySelector('hm-export-rate-chart')).not.toBeNull();

    modeRadios(section)['none']!.click();
    await flush(el);

    const put = calls.find((c) => c.method === 'PUT' && c.url.includes('/api/v1/rates'));
    expect(JSON.parse(put!.body!)).toEqual({ export_rate_mode: 'none' });
    expect(section.querySelector('hm-export-rate-chart')).toBeNull();
  });

  it('own rates with none saved waits for Save and seeds from the current curve', async () => {
    const { calls } = installFetchStub((url) => {
      if (url.includes('/api/v1/schedules')) return SCHEDULES_EMPTY;
      if (url.includes('/api/v1/appliances')) return [];
      if (url.includes('/api/v1/rates')) return ratesResponse();
      return null;
    });

    const el = mountPanel();
    const section = await settingsWith(el);
    modeRadios(section)['custom']!.click();
    await flush(el);

    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    expect(modeRadios(section)['custom']!.checked).toBe(true);
    const input0 = section.querySelector<HTMLInputElement>('input[name="export_rate_0"]')!;
    expect(input0.value).toBe('0.368');

    findButtonByText(section, 'Cancel').click();
    await flush(el);
    expect(modeRadios(section)['retail']!.checked).toBe(true);
  });

  it('own rates with a curve saved reselects it without opening the editor', async () => {
    const { calls } = installFetchStub((url, init) => {
      if (url.includes('/api/v1/schedules')) return SCHEDULES_EMPTY;
      if (url.includes('/api/v1/appliances')) return [];
      if (url.includes('/api/v1/rates')) {
        return init?.method === 'PUT'
          ? ratesResponse(STORED_CURVE)
          : ratesResponse({ ...STORED_CURVE, export_rate_mode: 'retail' });
      }
      return null;
    });

    const el = mountPanel();
    const section = await settingsWith(el);
    modeRadios(section)['custom']!.click();
    await flush(el);

    const put = calls.find((c) => c.method === 'PUT');
    expect(JSON.parse(put!.body!)).toEqual({ export_rate_mode: 'custom' });
    expect(section.querySelector('input[name="export_rate_0"]')).toBeNull();
  });

  it('the export-fields block is present under the dynamic source too', async () => {
    installFetchStub((url) => {
      if (url.includes('/api/v1/schedules')) return SCHEDULES_EMPTY;
      if (url.includes('/api/v1/appliances')) return [];
      if (url.includes('/api/v1/rates')) {
        return ratesResponse({ pricing_source: 'dynamic', dynamic_zone: 'comed' });
      }
      return null;
    });

    const el = mountPanel();
    await flush(el);
    clickSettings(el.shadowRoot!);
    await flush(el);

    const pricingSourceSelect = el.shadowRoot!.querySelector<HTMLSelectElement>(
      'select[name="pricing_source"]',
    )!;
    expect(pricingSourceSelect.value).toBe('dynamic');
    const section = exportSection(el.shadowRoot!);
    expect(section.textContent).toContain('What your utility pays');
    expect(section.querySelector('input[name="export_rate_mode"]')).not.toBeNull();
  });
});
