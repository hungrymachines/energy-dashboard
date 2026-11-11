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
  posts?: Array<{ url: string; body: unknown }>;
  /** Mutates scheduleEntries after a POST so the refetch shows the new state. */
  onPost?: (url: string, body: unknown) => void;
  postStatus?: number;
}): void {
  vi.stubGlobal('fetch', vi.fn(async (input: string | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = init?.method ?? (typeof input === 'string' ? 'GET' : input.method) ?? 'GET';

    if (method === 'POST' && /\/(pause|resume)$/.test(url)) {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      opts.posts?.push({ url, body });
      if (opts.postStatus && opts.postStatus >= 400) {
        return new Response('{"detail":"boom"}', {
          status: opts.postStatus, headers: { 'Content-Type': 'application/json' },
        });
      }
      opts.onPost?.(url, body);
      return jsonResponse({
        appliance_id: 'hvac-1', paused_until: null, optimization_enabled: true, pause_state: 'active',
      });
    }
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

    // Wrote to the appliance row, NOT the user-level prefs.
    const put = puts.find((p) => /\/api\/v1\/appliances\/ev-1$/.test(p.url));
    expect(put).toBeTruthy();
    expect(put!.body).toEqual({ optimization_enabled: false });

    const after = root.querySelector('.device-opt-toggle') as HTMLButtonElement;
    expect(after.textContent?.trim()).toBe('Paused');
    expect(after.getAttribute('aria-checked')).toBe('false');
  });

  it('robot card shows an On toggle and PUTs the appliance row on pause', async () => {
    const puts: Array<{ url: string; body: unknown }> = [];
    installFetch({
      scheduleEntries: [scheduleEntry({
        appliance_id: 'robot-1', appliance_type: 'robot', name: 'Vacuum',
        schedule: { intervals: Array(48).fill(false), value_trajectory: Array(48).fill(60), unit: 'percent' },
        entities: { entity_id: 'vacuum.living_room' },
      })],
      applianceRows: [applianceRow({
        id: 'robot-1', appliance_type: 'robot', name: 'Vacuum',
        config: { entity_id: 'vacuum.living_room' },
      })],
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

    // Robot is a controllable type — pausing it writes the
    // appliance row exactly like ev_charger/home_battery/water_heater do.
    const put = puts.find((p) => /\/api\/v1\/appliances\/robot-1$/.test(p.url));
    expect(put).toBeTruthy();
    expect(put!.body).toEqual({ optimization_enabled: false });
  });

  it('pool pump card shows an On toggle and PUTs the appliance row on pause', async () => {
    const puts: Array<{ url: string; body: unknown }> = [];
    installFetch({
      scheduleEntries: [scheduleEntry({
        appliance_id: 'pool-1', appliance_type: 'pool_pump', name: 'Pool Pump',
        schedule: { intervals: Array(48).fill(false), value_trajectory: Array(48).fill(0), unit: 'percent' },
        entities: { entity_id: 'switch.pool_pump' },
      })],
      applianceRows: [applianceRow({
        id: 'pool-1', appliance_type: 'pool_pump', name: 'Pool Pump',
        config: { entity_id: 'switch.pool_pump' },
      })],
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

    // Pool pump is a controllable type — pausing it writes
    // the appliance row exactly like robot/ev_charger/home_battery do.
    const put = puts.find((p) => /\/api\/v1\/appliances\/pool-1$/.test(p.url));
    expect(put).toBeTruthy();
    expect(put!.body).toEqual({ optimization_enabled: false });
  });

  it('hot tub card shows an On toggle and PUTs the appliance row on pause', async () => {
    const puts: Array<{ url: string; body: unknown }> = [];
    installFetch({
      scheduleEntries: [scheduleEntry({
        appliance_id: 'tub-1', appliance_type: 'hot_tub', name: 'Backyard Spa',
        schedule: {
          intervals: Array(48).fill(false),
          temp_trajectory: Array(48).fill(90),
          high_temps: Array(48).fill(112),
          low_temps: Array(48).fill(90),
          unit: 'fahrenheit',
        },
        entities: { entity_id: 'climate.hot_tub' },
      })],
      applianceRows: [applianceRow({
        id: 'tub-1', appliance_type: 'hot_tub', name: 'Backyard Spa',
        config: { entity_id: 'climate.hot_tub' },
      })],
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

    // Hot tub is a controllable type — pausing it writes
    // the appliance row exactly like water_heater/robot do.
    const put = puts.find((p) => /\/api\/v1\/appliances\/tub-1$/.test(p.url));
    expect(put).toBeTruthy();
    expect(put!.body).toEqual({ optimization_enabled: false });
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

  describe('timed pause row', () => {
    const UNTIL = '2026-07-05T20:45:00Z';
    function hvacEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
      return scheduleEntry({
        appliance_id: 'hvac-1', appliance_type: 'hvac', name: 'Front AC',
        entities: { entity_id: 'climate.front' },
        pause_state: 'active', paused_until: null, ...over,
      });
    }
    function applyCalls(el: PanelEl) {
      const callService = vi.fn(async () => {});
      (el as unknown as { hass: unknown }).hass = { callService };
      return callService;
    }

    it('each button POSTs its minutes, refetches schedules and applies now', async () => {
      for (const [name, minutes] of [['pause_2h', 120], ['pause_4h', 240], ['pause_6h', 360]] as const) {
        const posts: Array<{ url: string; body: unknown }> = [];
        const entries = [hvacEntry()];
        installFetch({
          scheduleEntries: entries, applianceRows: [], puts: [], posts,
          onPost: () => { entries[0] = hvacEntry({ pause_state: 'timed', paused_until: UNTIL }); },
        });
        const el = mountAuthedPanel();
        const callService = applyCalls(el);
        await flush(el);
        const root = el.shadowRoot!;
        const btn = root.querySelector(`.pause-row button[name="${name}"]`) as HTMLButtonElement;
        expect(btn).toBeTruthy();
        btn.click();
        await flush(el);
        expect(posts).toEqual([{ url: 'https://api.example.test/api/v1/appliances/hvac-1/pause', body: { minutes } }]);
        expect(callService).toHaveBeenCalledWith('hungry_machines', 'apply_now', {});
        expect(root.querySelector('.pause-row .paused-until')).toBeTruthy();
        el.remove();
        vi.unstubAllGlobals();
      }
    });

    it('timed state shows the local-time label and Resume posts /resume', async () => {
      const posts: Array<{ url: string; body: unknown }> = [];
      const entries = [hvacEntry({ pause_state: 'timed', paused_until: UNTIL })];
      installFetch({
        scheduleEntries: entries, applianceRows: [], puts: [], posts,
        onPost: () => { entries[0] = hvacEntry(); },
      });
      const el = mountAuthedPanel();
      const callService = applyCalls(el);
      await flush(el);
      const root = el.shadowRoot!;
      const expected = new Date(UNTIL).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      expect(root.querySelector('.paused-until')!.textContent).toBe(`Paused until ${expected}`);
      expect(root.querySelector('button[name="pause_2h"]')).toBeNull();
      (root.querySelector('button[name="resume_now"]') as HTMLButtonElement).click();
      await flush(el);
      expect(posts[0].url).toMatch(/\/api\/v1\/appliances\/hvac-1\/resume$/);
      expect(callService).toHaveBeenCalledWith('hungry_machines', 'apply_now', {});
      expect(root.querySelector('button[name="pause_2h"]')).toBeTruthy();
    });

    it('shows nothing for manual, master, missing state, and non-HVAC cards', async () => {
      for (const entry of [
        hvacEntry({ pause_state: 'manual' }),
        hvacEntry({ pause_state: 'master' }),
        hvacEntry({ pause_state: undefined }),
        scheduleEntry({ pause_state: 'active' }),
      ]) {
        installFetch({ scheduleEntries: [entry], applianceRows: [], puts: [] });
        const el = mountAuthedPanel();
        await flush(el);
        expect(el.shadowRoot!.querySelector('.pause-row')).toBeNull();
        el.remove();
        vi.unstubAllGlobals();
      }
    });

    it('shows an error and no apply when the POST fails', async () => {
      installFetch({
        scheduleEntries: [hvacEntry()], applianceRows: [], puts: [], posts: [], postStatus: 500,
      });
      const el = mountAuthedPanel();
      const callService = applyCalls(el);
      await flush(el);
      (el.shadowRoot!.querySelector('button[name="pause_2h"]') as HTMLButtonElement).click();
      await flush(el);
      expect(el.shadowRoot!.querySelector('.pause-error')!.textContent).toBe('Could not pause. Try again.');
      expect(callService).not.toHaveBeenCalled();
    });
  });
});
