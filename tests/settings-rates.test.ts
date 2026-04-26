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
};

const ZONE_RATES_48 = Array<number>(48).fill(36.8);
const CUSTOM_RATES_24 = Array.from({ length: 24 }, (_, i) => 10 + i);
const CUSTOM_RATES_48 = CUSTOM_RATES_24.flatMap((v) => [v, v]);

function ratesResponse(overrides: Record<string, unknown> = {}): unknown {
  return {
    pricing_location: 3,
    intervals: Array.from({ length: 48 }, (_, i) => i),
    rates_cents_per_kwh: ZONE_RATES_48,
    unit: 'cents/kWh',
    source: 'zone',
    hourly_rates_cents_per_kwh: null,
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

function ratesSection(root: ShadowRoot): HTMLElement {
  const section = root.querySelector<HTMLElement>('.settings-section[data-section="custom-rates"]');
  if (!section) throw new Error('custom rates section not found');
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

describe('settings custom electricity rates (US-FE-OVR-01)', () => {
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

  it('(a) renders Currently using: Zone N rates when source is zone', async () => {
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

    const section = ratesSection(el.shadowRoot!);
    expect(section.textContent).toContain('Custom electricity rates');
    expect(section.textContent).toContain('Currently using: Zone 3 rates');
    // With zone source, the toggle reads "Edit custom rates".
    const toggle = findButtonByText(section, 'Edit custom rates');
    expect(toggle).toBeDefined();
  });

  it('(b) Edit custom rates + Import from Zone N pre-fills first input with exact string "0.368"', async () => {
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

    const section = ratesSection(el.shadowRoot!);

    // Open the editor.
    findButtonByText(section, 'Edit custom rates').click();
    await flush(el);

    // Before import, rows are empty.
    const input0 = section.querySelector<HTMLInputElement>('input[name="rate_0"]');
    expect(input0).not.toBeNull();
    expect(input0!.value).toBe('');

    // Click Import from Zone 3.
    findButtonByText(section, 'Import from Zone 3').click();
    await flush(el);

    const filled = section.querySelector<HTMLInputElement>('input[name="rate_0"]');
    expect(filled).not.toBeNull();
    // Exact string match guards cents -> dollars conversion (36.8 / 100 = 0.368).
    expect(filled!.value).toBe('0.368');
  });

  it('(c) typing 0.40 in row 0 then Save fires PUT with hourly_rates_cents_per_kwh[0] === 40', async () => {
    const { calls } = installFetchStub((url, init) => {
      if (url.includes('/api/v1/schedules')) return SCHEDULES_EMPTY;
      if (url.includes('/api/v1/appliances')) return [];
      if (url.includes('/api/v1/rates')) {
        if (init?.method === 'PUT') {
          const body = JSON.parse(String(init.body)) as {
            hourly_rates_cents_per_kwh: number[] | null;
          };
          return ratesResponse({
            source: 'custom',
            hourly_rates_cents_per_kwh: body.hourly_rates_cents_per_kwh,
            rates_cents_per_kwh:
              body.hourly_rates_cents_per_kwh !== null
                ? body.hourly_rates_cents_per_kwh.flatMap((v) => [v, v])
                : ZONE_RATES_48,
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

    const section = ratesSection(el.shadowRoot!);

    // Open editor, import zone values (fills all 24 rows with "0.368").
    findButtonByText(section, 'Edit custom rates').click();
    await flush(el);
    findButtonByText(section, 'Import from Zone 3').click();
    await flush(el);

    // Type 0.40 in row 0.
    const input0 = section.querySelector<HTMLInputElement>('input[name="rate_0"]')!;
    input0.value = '0.40';
    input0.dispatchEvent(new Event('input', { bubbles: true }));
    await flush(el);

    // Click Save.
    const save = findButtonByText(section, 'Save');
    expect(save.disabled).toBe(false);
    save.click();
    await flush(el);

    const put = calls.find((c) => c.url.includes('/api/v1/rates') && c.method === 'PUT');
    expect(put).toBeDefined();
    expect(put!.body).toBeDefined();
    const body = JSON.parse(put!.body!) as { hourly_rates_cents_per_kwh: number[] };
    expect(Array.isArray(body.hourly_rates_cents_per_kwh)).toBe(true);
    expect(body.hourly_rates_cents_per_kwh.length).toBe(24);
    // Numerical equality, not 0.4 or 4000 — guards dollars -> cents conversion.
    expect(body.hourly_rates_cents_per_kwh[0]).toBe(40);
    // Remaining rows stayed at the imported zone value of 36.8 cents.
    expect(body.hourly_rates_cents_per_kwh[1]).toBe(36.8);
    expect(body.hourly_rates_cents_per_kwh[23]).toBe(36.8);
  });

  it('(d) when source=custom, Clear override is visible and clicking it PUTs null', async () => {
    let getCalls = 0;
    const { calls } = installFetchStub((url, init) => {
      if (url.includes('/api/v1/schedules')) return SCHEDULES_EMPTY;
      if (url.includes('/api/v1/appliances')) return [];
      if (url.includes('/api/v1/rates')) {
        if (init?.method === 'PUT') {
          const body = JSON.parse(String(init.body)) as {
            hourly_rates_cents_per_kwh: number[] | null;
          };
          if (body.hourly_rates_cents_per_kwh === null) {
            return ratesResponse({ source: 'zone', hourly_rates_cents_per_kwh: null });
          }
          return ratesResponse({
            source: 'custom',
            hourly_rates_cents_per_kwh: body.hourly_rates_cents_per_kwh,
          });
        }
        getCalls += 1;
        return ratesResponse({
          source: 'custom',
          hourly_rates_cents_per_kwh: CUSTOM_RATES_24,
          rates_cents_per_kwh: CUSTOM_RATES_48,
        });
      }
      return null;
    });

    const el = mountPanel();
    await flush(el);
    clickSettings(el.shadowRoot!);
    await flush(el);

    expect(getCalls).toBeGreaterThanOrEqual(1);
    const section = ratesSection(el.shadowRoot!);
    expect(section.textContent).toContain('Currently using: your custom rates');

    // When source=custom, the toggle reads "Edit / Clear override".
    findButtonByText(section, 'Edit / Clear override').click();
    await flush(el);

    const clear = findButtonByText(section, 'Clear override');
    expect(clear).toBeDefined();
    clear.click();
    await flush(el);

    const put = calls.find((c) => c.url.includes('/api/v1/rates') && c.method === 'PUT');
    expect(put).toBeDefined();
    const body = JSON.parse(put!.body!) as { hourly_rates_cents_per_kwh: number[] | null };
    expect(body).toEqual({ hourly_rates_cents_per_kwh: null });
  });

  it('(e) entering a value of 3 (out of range) shows an inline validation error and Save is disabled', async () => {
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

    const section = ratesSection(el.shadowRoot!);
    findButtonByText(section, 'Edit custom rates').click();
    await flush(el);
    // Fill all rows with a valid value via Import first so only row 0 is the failing one.
    findButtonByText(section, 'Import from Zone 3').click();
    await flush(el);

    const input0 = section.querySelector<HTMLInputElement>('input[name="rate_0"]')!;
    input0.value = '3';
    input0.dispatchEvent(new Event('input', { bubbles: true }));
    await flush(el);

    const row0 = section.querySelector<HTMLElement>('tr[data-row="0"]')!;
    expect(row0.textContent).toMatch(/between 0 and 2/i);
    const save = findButtonByText(section, 'Save');
    expect(save.disabled).toBe(true);
  });
});
