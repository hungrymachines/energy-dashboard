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
      { slug: 'comed', iso: 'PJM', label: 'ComEd (Northern Illinois)' },
    ],
    export_rates_cents_per_kwh: null,
    ...overrides,
  };
}

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
        return ratesResponse({ export_rates_cents_per_kwh: EXPORT_RATES_48 });
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

    // slot 0 = 10 cents -> "0.100"; slot 1 = 11 cents -> "0.110".
    const input0 = section.querySelector<HTMLInputElement>('input[name="export_rate_0"]');
    const input1 = section.querySelector<HTMLInputElement>('input[name="export_rate_1"]');
    expect(input0!.value).toBe('0.100');
    expect(input1!.value).toBe('0.110');
  });

  it('PUT body has 48 cents values, slot 1 = 36.8 for input 0.368', async () => {
    const { calls } = installFetchStub((url, init) => {
      if (url.includes('/api/v1/schedules')) return SCHEDULES_EMPTY;
      if (url.includes('/api/v1/appliances')) return [];
      if (url.includes('/api/v1/rates')) {
        if (init?.method === 'PUT') {
          const body = JSON.parse(String(init.body)) as {
            export_rates_cents_per_kwh: number[] | null;
          };
          return ratesResponse({ export_rates_cents_per_kwh: body.export_rates_cents_per_kwh });
        }
        return ratesResponse({ export_rates_cents_per_kwh: EXPORT_RATES_48 });
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
    expect(body.export_rates_cents_per_kwh[1]).toBe(36.8);
    // Untouched slots keep their imported seed values.
    expect(body.export_rates_cents_per_kwh[0]).toBe(10);
    expect(body.export_rates_cents_per_kwh[47]).toBe(57);
  });

  it('an invalid row disables Save', async () => {
    installFetchStub((url) => {
      if (url.includes('/api/v1/schedules')) return SCHEDULES_EMPTY;
      if (url.includes('/api/v1/appliances')) return [];
      if (url.includes('/api/v1/rates')) {
        return ratesResponse({ export_rates_cents_per_kwh: EXPORT_RATES_48 });
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
        return ratesResponse({ export_rates_cents_per_kwh: EXPORT_RATES_48 });
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
    expect(findButtonByText(section, 'Edit export rates')).toBeDefined();
  });
});
