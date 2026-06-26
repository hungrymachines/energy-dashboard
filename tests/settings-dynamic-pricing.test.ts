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

const ZONE_RATES_48 = Array<number>(48).fill(36.8);

const SCHEDULES_EMPTY = {
  date: '2026-06-23',
  appliances: [],
};

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
      { slug: 'ameren', iso: 'MISO', label: 'Ameren Illinois (Power Smart Pricing)' },
    ],
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

function customRatesSection(root: ShadowRoot): HTMLElement {
  const section = root.querySelector<HTMLElement>(
    '.settings-section[data-section="custom-rates"]',
  );
  if (!section) throw new Error('custom-rates section not found');
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

describe('settings dynamic pricing (US-DYNPRICE-009)', () => {
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

  it('renders pricing-source selector with Zone/Custom/Dynamic options and current source preselected', async () => {
    installFetchStub((url) => {
      if (url.includes('/api/v1/schedules')) return SCHEDULES_EMPTY;
      if (url.includes('/api/v1/appliances')) return [];
      if (url.includes('/api/v1/rates')) return ratesResponse();
      return null;
    });

    const el = mountPanel();
    await flush(el);
    clickSettings(el.shadowRoot!);
    await flush(el);

    const section = pricingSection(el.shadowRoot!);
    const select = section.querySelector<HTMLSelectElement>('select[name="pricing_source"]');
    expect(select).not.toBeNull();
    const optionValues = Array.from(select!.options).map((o) => o.value);
    expect(optionValues).toEqual(['zone', 'custom', 'dynamic']);
    expect(select!.value).toBe('zone');
  });

  it('selecting Dynamic reveals the region dropdown (ComEd preselected) and the flat-adder input', async () => {
    installFetchStub((url) => {
      if (url.includes('/api/v1/schedules')) return SCHEDULES_EMPTY;
      if (url.includes('/api/v1/appliances')) return [];
      if (url.includes('/api/v1/rates')) return ratesResponse();
      return null;
    });

    const el = mountPanel();
    await flush(el);
    clickSettings(el.shadowRoot!);
    await flush(el);

    const section = pricingSection(el.shadowRoot!);
    const sourceSelect = section.querySelector<HTMLSelectElement>('select[name="pricing_source"]')!;

    // Before selecting Dynamic, the dynamic-fields container is hidden.
    const dynamicFields = section.querySelector<HTMLElement>('.dynamic-fields')!;
    expect(dynamicFields.hasAttribute('hidden')).toBe(true);

    sourceSelect.value = 'dynamic';
    sourceSelect.dispatchEvent(new Event('change', { bubbles: true }));
    await flush(el);

    expect(dynamicFields.hasAttribute('hidden')).toBe(false);

    const zoneSelect = section.querySelector<HTMLSelectElement>('select[name="dynamic_zone"]');
    expect(zoneSelect).not.toBeNull();
    const slugs = Array.from(zoneSelect!.options).map((o) => o.value);
    // Only utilities that bill residential customers on daily day-ahead
    // prices: ComEd (PJM) + Ameren Illinois (MISO).
    expect(slugs).toEqual(['comed', 'ameren']);
    expect(zoneSelect!.value).toBe('comed');

    const adderInput = section.querySelector<HTMLInputElement>(
      'input[name="pricing_adder_cents_per_kwh"]',
    );
    expect(adderInput).not.toBeNull();
    expect(adderInput!.type).toBe('number');
  });

  it('clicking Save with Dynamic + adder fires PUT /api/v1/rates with dynamic_zone body and the custom-rates editor is hidden', async () => {
    const { calls } = installFetchStub((url, init) => {
      if (url.includes('/api/v1/schedules')) return SCHEDULES_EMPTY;
      if (url.includes('/api/v1/appliances')) return [];
      if (url.includes('/api/v1/rates')) {
        if (init?.method === 'PUT') {
          const body = JSON.parse(String(init.body)) as {
            pricing_source: string;
            dynamic_zone?: string | null;
            pricing_adder_cents_per_kwh?: number | null;
          };
          return ratesResponse({
            source: 'dynamic',
            pricing_source: body.pricing_source,
            dynamic_zone: body.dynamic_zone ?? null,
            pricing_adder_cents_per_kwh:
              body.pricing_adder_cents_per_kwh ?? null,
          });
        }
        return ratesResponse();
      }
      return null;
    });

    const el = mountPanel();
    await flush(el);
    clickSettings(el.shadowRoot!);
    await flush(el);

    const section = pricingSection(el.shadowRoot!);

    const sourceSelect = section.querySelector<HTMLSelectElement>('select[name="pricing_source"]')!;
    sourceSelect.value = 'dynamic';
    sourceSelect.dispatchEvent(new Event('change', { bubbles: true }));
    await flush(el);

    const adder = section.querySelector<HTMLInputElement>(
      'input[name="pricing_adder_cents_per_kwh"]',
    )!;
    adder.value = '8.5';
    adder.dispatchEvent(new Event('input', { bubbles: true }));
    await flush(el);

    const save = section.querySelector<HTMLButtonElement>('button[name="save_pricing_source"]')!;
    expect(save.disabled).toBe(false);
    save.click();
    await flush(el);

    const put = calls.find((c) => c.url.includes('/api/v1/rates') && c.method === 'PUT');
    expect(put).toBeDefined();
    const body = JSON.parse(put!.body!) as {
      pricing_source: string;
      dynamic_zone: string;
      pricing_adder_cents_per_kwh: number;
    };
    expect(body.pricing_source).toBe('dynamic');
    expect(body.dynamic_zone).toBe('comed');
    // The legacy pjm_node field is NOT sent — the dropdown now drives
    // dynamic_zone exclusively (US-GS-006).
    expect((body as Record<string, unknown>).pjm_node).toBeUndefined();
    expect(body.pricing_adder_cents_per_kwh).toBe(8.5);

    // After save, the custom-rates section is hidden.
    const customRates = customRatesSection(el.shadowRoot!);
    expect(customRates.hasAttribute('hidden')).toBe(true);

    // Summary line in the pricing-source section reflects the dynamic active state.
    expect(section.textContent).toContain('day-ahead pricing');
  });

  it('selecting a MISO region (Ameren Illinois) and saving sends dynamic_zone=ameren', async () => {
    const { calls } = installFetchStub((url, init) => {
      if (url.includes('/api/v1/schedules')) return SCHEDULES_EMPTY;
      if (url.includes('/api/v1/appliances')) return [];
      if (url.includes('/api/v1/rates')) {
        if (init?.method === 'PUT') {
          const body = JSON.parse(String(init.body)) as {
            pricing_source: string;
            dynamic_zone?: string | null;
          };
          return ratesResponse({
            source: 'dynamic',
            pricing_source: body.pricing_source,
            dynamic_zone: body.dynamic_zone ?? null,
          });
        }
        return ratesResponse();
      }
      return null;
    });

    const el = mountPanel();
    await flush(el);
    clickSettings(el.shadowRoot!);
    await flush(el);

    const section = pricingSection(el.shadowRoot!);
    const sourceSelect = section.querySelector<HTMLSelectElement>('select[name="pricing_source"]')!;
    sourceSelect.value = 'dynamic';
    sourceSelect.dispatchEvent(new Event('change', { bubbles: true }));
    await flush(el);

    const zoneSelect = section.querySelector<HTMLSelectElement>('select[name="dynamic_zone"]')!;
    zoneSelect.value = 'ameren';
    zoneSelect.dispatchEvent(new Event('change', { bubbles: true }));
    await flush(el);

    const save = section.querySelector<HTMLButtonElement>('button[name="save_pricing_source"]')!;
    save.click();
    await flush(el);

    const put = calls.find((c) => c.url.includes('/api/v1/rates') && c.method === 'PUT');
    expect(put).toBeDefined();
    const body = JSON.parse(put!.body!) as {
      pricing_source: string;
      dynamic_zone: string;
    };
    expect(body.pricing_source).toBe('dynamic');
    expect(body.dynamic_zone).toBe('ameren');
  });

  it('Save is disabled when no changes have been drafted', async () => {
    installFetchStub((url) => {
      if (url.includes('/api/v1/schedules')) return SCHEDULES_EMPTY;
      if (url.includes('/api/v1/appliances')) return [];
      if (url.includes('/api/v1/rates')) return ratesResponse();
      return null;
    });

    const el = mountPanel();
    await flush(el);
    clickSettings(el.shadowRoot!);
    await flush(el);

    const section = pricingSection(el.shadowRoot!);
    const save = section.querySelector<HTMLButtonElement>('button[name="save_pricing_source"]')!;
    expect(save.disabled).toBe(true);
  });

  it('Dynamic with adder outside [0, 50] surfaces an inline error and does not PUT', async () => {
    const { calls } = installFetchStub((url, init) => {
      if (url.includes('/api/v1/schedules')) return SCHEDULES_EMPTY;
      if (url.includes('/api/v1/appliances')) return [];
      if (url.includes('/api/v1/rates')) {
        if (init?.method === 'PUT') {
          throw new Error('should not PUT when adder is out of range');
        }
        return ratesResponse();
      }
      return null;
    });

    const el = mountPanel();
    await flush(el);
    clickSettings(el.shadowRoot!);
    await flush(el);

    const section = pricingSection(el.shadowRoot!);
    const sourceSelect = section.querySelector<HTMLSelectElement>('select[name="pricing_source"]')!;
    sourceSelect.value = 'dynamic';
    sourceSelect.dispatchEvent(new Event('change', { bubbles: true }));
    await flush(el);

    const adder = section.querySelector<HTMLInputElement>(
      'input[name="pricing_adder_cents_per_kwh"]',
    )!;
    adder.value = '99';
    adder.dispatchEvent(new Event('input', { bubbles: true }));
    await flush(el);

    const save = section.querySelector<HTMLButtonElement>('button[name="save_pricing_source"]')!;
    save.click();
    await flush(el);

    const err = section.querySelector<HTMLElement>('.rates-api-error');
    expect(err).not.toBeNull();
    expect(err!.hasAttribute('hidden')).toBe(false);
    expect(err!.textContent).toMatch(/between 0 and 50/i);

    const put = calls.find((c) => c.url.includes('/api/v1/rates') && c.method === 'PUT');
    expect(put).toBeUndefined();
  });

  it('loading rates with stored pricing_source=dynamic preselects Dynamic and hides the custom-rates section on first paint', async () => {
    installFetchStub((url) => {
      if (url.includes('/api/v1/schedules')) return SCHEDULES_EMPTY;
      if (url.includes('/api/v1/appliances')) return [];
      if (url.includes('/api/v1/rates')) {
        return ratesResponse({
          source: 'dynamic',
          pricing_source: 'dynamic',
          dynamic_zone: 'ameren',
          pricing_adder_cents_per_kwh: 7.25,
        });
      }
      return null;
    });

    const el = mountPanel();
    await flush(el);
    clickSettings(el.shadowRoot!);
    await flush(el);

    const section = pricingSection(el.shadowRoot!);
    const sourceSelect = section.querySelector<HTMLSelectElement>('select[name="pricing_source"]')!;
    expect(sourceSelect.value).toBe('dynamic');

    // The region dropdown reflects the stored slug (not the default
    // ComEd fallback) so the user sees their saved choice on first
    // paint.
    const zoneSelect = section.querySelector<HTMLSelectElement>('select[name="dynamic_zone"]')!;
    expect(zoneSelect.value).toBe('ameren');

    const adder = section.querySelector<HTMLInputElement>(
      'input[name="pricing_adder_cents_per_kwh"]',
    )!;
    expect(adder.value).toBe('7.25');

    const customRates = customRatesSection(el.shadowRoot!);
    expect(customRates.hasAttribute('hidden')).toBe(true);
  });
});
