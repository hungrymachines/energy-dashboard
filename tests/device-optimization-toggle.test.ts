import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HungryMachinesPanel } from '../src/panel/hungry-machines-panel.js';
import { authStore } from '../src/store.js';
import { clearTokens, setApiBase } from '../src/api/client.js';

if (!customElements.get('hungry-machines-panel')) {
  customElements.define('hungry-machines-panel', HungryMachinesPanel);
}

type PanelEl = HungryMachinesPanel & { updateComplete: Promise<boolean> };

const RATES = { rates_cents_per_kwh: Array(48).fill(10) };
const PREFS = {
  base_temperature: 72, savings_level: 1, time_away: '08:00',
  time_home: '17:00', optimization_mode: 'cool', optimization_enabled: true,
};

function scheduleEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    appliance_id: 'ev-1',
    appliance_type: 'ev_charger',
    name: 'Tesla',
    schedule: { intervals: Array(48).fill(false), value_trajectory: Array(48).fill(50), unit: 'percent' },
    savings_pct: 20,
    source: 'optimization',
    entities: { entity_id: 'switch.tesla_charger' },
    optimization_enabled: true,
    ...over,
  };
}

function applianceRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ev-1',
    user_id: 'u-1',
    appliance_type: 'ev_charger',
    name: 'Tesla',
    config: { entity_id: 'switch.tesla_charger' },
    is_active: true,
    created_at: '2026-01-01T00:00:00Z',
    optimization_enabled: true,
    ...over,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
}

async function flush(el: PanelEl): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await el.updateComplete;
    await Promise.resolve();
  }
}

function mountAuthedPanel(): PanelEl {
  authStore.state = {
    access: 'A', refresh: 'R', status: 'authed',
    user: { user_id: 'u-1' } as never, error: null,
  } as never;
  const el = document.createElement('hungry-machines-panel') as PanelEl;
  document.body.appendChild(el);
  (el as unknown as Record<string, unknown>)._view = 'dashboard';
  (el as unknown as Record<string, unknown>)._auth = authStore.state;
  return el;
}

/** Wire a fetch mock. `appliances`/`schedules` seed the two lists; `puts`
 * collects [url, body] for every PUT so tests can assert the write target. */
function installFetch(opts: {
  scheduleEntries: Record<string, unknown>[];
  applianceRows: Record<string, unknown>[];
  appliancePrefs?: Record<string, unknown>;
  puts: Array<{ url: string; body: unknown }>;
}): void {
  vi.stubGlobal('fetch', vi.fn(async (input: string | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = init?.method ?? (typeof input === 'string' ? 'GET' : input.method) ?? 'GET';

    if (method === 'PUT') {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      opts.puts.push({ url, body });
      // Echo the appliance row / prefs row back with the new flag applied.
      if (/\/api\/v1\/appliances\/[^/]+\/preferences$/.test(url)) {
        return jsonResponse({ ...(opts.appliancePrefs ?? {}), ...body });
      }
      return jsonResponse({ ...opts.applianceRows[0], ...body });
    }
    if (url.includes('/api/v1/schedule/recompute')) {
      return jsonResponse({ date: '2026-07-05', appliances: opts.scheduleEntries });
    }
    if (/\/api\/v1\/appliances\/[^/]+\/preferences$/.test(url)) {
      return jsonResponse(opts.appliancePrefs ?? PREFS);
    }
    if (url.endsWith('/api/v1/appliances')) return jsonResponse(opts.applianceRows);
    if (url.includes('/api/v1/schedules')) {
      return jsonResponse({ date: '2026-07-05', appliances: opts.scheduleEntries });
    }
    if (url.includes('/api/v1/preferences')) return jsonResponse(PREFS);
    if (url.includes('/api/v1/rates')) return jsonResponse(RATES);
    return new Response('{"detail":"nf"}', { status: 404, headers: { 'Content-Type': 'application/json' } });
  }));
}

describe('per-device optimization toggle', () => {
  beforeEach(() => {
    setApiBase('https://api.example.test');
    localStorage.clear();
    clearTokens();
    vi.spyOn(authStore, 'hydrate').mockImplementation(async () => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    localStorage.clear();
    clearTokens();
  });

  it('non-HVAC card shows an On toggle and PUTs the appliance row on pause', async () => {
    const puts: Array<{ url: string; body: unknown }> = [];
    installFetch({
      scheduleEntries: [scheduleEntry()],
      applianceRows: [applianceRow()],
      puts,
    });

    const el = mountAuthedPanel();
    await flush(el);
    const root = el.shadowRoot!;

    const toggle = root.querySelector('.device-opt-toggle') as HTMLButtonElement;
    expect(toggle).toBeTruthy();
    expect(toggle.textContent?.trim()).toBe('On');
    expect(toggle.getAttribute('aria-checked')).toBe('true');

    toggle.click();
    await flush(el);

    // Wrote to the appliance row (migration 038), NOT the user-level prefs.
    const put = puts.find((p) => /\/api\/v1\/appliances\/ev-1$/.test(p.url));
    expect(put).toBeTruthy();
    expect(put!.body).toEqual({ optimization_enabled: false });

    const after = root.querySelector('.device-opt-toggle') as HTMLButtonElement;
    expect(after.textContent?.trim()).toBe('Paused');
    expect(after.getAttribute('aria-checked')).toBe('false');
  });

  it('HVAC card toggle writes the per-appliance preferences row, not the appliance row', async () => {
    const puts: Array<{ url: string; body: unknown }> = [];
    installFetch({
      scheduleEntries: [scheduleEntry({
        appliance_id: 'hvac-1', appliance_type: 'hvac', name: 'AC',
        schedule: { high_temps: Array(48).fill(74), low_temps: Array(48).fill(70), mode: 'cool' },
        entities: { entity_id: 'climate.lr' },
      })],
      applianceRows: [applianceRow({
        id: 'hvac-1', appliance_type: 'hvac', name: 'AC',
        config: { entity_id: 'climate.lr' },
      })],
      appliancePrefs: { ...PREFS, optimization_enabled: true },
      puts,
    });

    const el = mountAuthedPanel();
    await flush(el);
    const root = el.shadowRoot!;

    const toggle = root.querySelector('.device-opt-toggle') as HTMLButtonElement;
    expect(toggle).toBeTruthy();
    expect(toggle.textContent?.trim()).toBe('On');

    toggle.click();
    await flush(el);

    const prefsPut = puts.find((p) => /\/api\/v1\/appliances\/hvac-1\/preferences$/.test(p.url));
    expect(prefsPut).toBeTruthy();
    expect(prefsPut!.body).toEqual({ optimization_enabled: false });
    // Must NOT have written the bare appliance row for HVAC.
    expect(puts.some((p) => /\/api\/v1\/appliances\/hvac-1$/.test(p.url))).toBe(false);
  });

  it('a device that loads paused renders the Paused toggle', async () => {
    const puts: Array<{ url: string; body: unknown }> = [];
    installFetch({
      scheduleEntries: [scheduleEntry({ optimization_enabled: false })],
      applianceRows: [applianceRow({ optimization_enabled: false })],
      puts,
    });

    const el = mountAuthedPanel();
    await flush(el);
    const toggle = el.shadowRoot!.querySelector('.device-opt-toggle') as HTMLButtonElement;
    expect(toggle.textContent?.trim()).toBe('Paused');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  it('solar cards have no per-device toggle (nothing to control)', async () => {
    const puts: Array<{ url: string; body: unknown }> = [];
    installFetch({
      scheduleEntries: [scheduleEntry({
        appliance_id: 'sol-1', appliance_type: 'solar', name: 'Roof', entities: {},
      })],
      applianceRows: [applianceRow({
        id: 'sol-1', appliance_type: 'solar', name: 'Roof', config: { system_size_kw: 8 },
      })],
      puts,
    });

    const el = mountAuthedPanel();
    await flush(el);
    const root = el.shadowRoot!;
    // The solar card renders, but with no device toggle.
    expect(root.querySelector('[data-appliance-type="solar"]')).toBeTruthy();
    expect(root.querySelector('.device-opt-toggle')).toBeNull();
  });

  it('keeps the master toggle alongside the per-device ones', async () => {
    const puts: Array<{ url: string; body: unknown }> = [];
    installFetch({
      scheduleEntries: [scheduleEntry()],
      applianceRows: [applianceRow()],
      puts,
    });

    const el = mountAuthedPanel();
    await flush(el);
    const root = el.shadowRoot!;
    // Master header toggle still present…
    expect(root.querySelector('.opt-toggle')).toBeTruthy();
    // …and the per-device one too.
    expect(root.querySelector('.device-opt-toggle')).toBeTruthy();
  });
});
