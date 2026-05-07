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

function mountPanel(init: Partial<HungryMachinesPanel> = {}): PanelEl {
  const el = document.createElement('hungry-machines-panel') as PanelEl;
  Object.assign(el, init);
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
  for (let i = 0; i < 5; i++) {
    await el.updateComplete;
    await Promise.resolve();
  }
}

function selectByName(root: ShadowRoot, name: string): HTMLSelectElement {
  const el = root.querySelector<HTMLSelectElement>(`select[name="${name}"]`);
  if (!el) throw new Error(`select[name="${name}"] not found`);
  return el;
}

function clickSettings(root: ShadowRoot): void {
  const settings = Array.from(
    root.querySelectorAll<HTMLButtonElement>('nav.tabs button'),
  ).find((b) => b.textContent?.trim() === 'Settings');
  if (!settings) throw new Error('Settings tab not found');
  settings.click();
}

const HASS = {
  states: {
    'climate.living_room': {
      entity_id: 'climate.living_room',
      state: 'cool',
      attributes: { current_temperature: 72, temperature: 70 },
    },
    'climate.bedroom': {
      entity_id: 'climate.bedroom',
      state: 'heat',
      attributes: { current_temperature: 68, temperature: 72 },
    },
    'weather.home': {
      entity_id: 'weather.home',
      state: 'sunny',
      attributes: { temperature: 58 },
    },
    'weather.met_no': {
      entity_id: 'weather.met_no',
      state: 'cloudy',
      attributes: { temperature: 60 },
    },
    'sensor.living_room_temp': {
      entity_id: 'sensor.living_room_temp',
      state: '72',
    },
    'light.kitchen': {
      entity_id: 'light.kitchen',
      state: 'off',
    },
  },
};

describe('hungry-machines-panel settings (v2.0)', () => {
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
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('null', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    localStorage.clear();
    clearTokens();
    setAuthState({});
  });

  it('renders a single weather-entity picker (climate is now per-appliance)', async () => {
    const el = mountPanel({ hass: HASS });
    await flush(el);
    clickSettings(el.shadowRoot!);
    await flush(el);

    const root = el.shadowRoot!;
    const settingsSection = Array.from(root.querySelectorAll('.settings-section')).find(
      (s) => s.querySelector('h3')?.textContent?.includes('Weather'),
    );
    expect(settingsSection).toBeDefined();

    const weatherSel = selectByName(root, 'weather_entity_id');
    const values = Array.from(weatherSel.options)
      .map((o) => o.value)
      .filter((v) => v !== '');
    expect(values.sort()).toEqual(['weather.home', 'weather.met_no']);

    // The legacy "climate" entity picker is gone (climate lives on each appliance now).
    expect(root.querySelector('select[name="entity_climate"]')).toBeNull();
    // Legacy entity_map fields also gone.
    for (const legacy of ['indoor_temp', 'outdoor_temp', 'power']) {
      expect(root.querySelector(`select[name="entity_${legacy}"]`)).toBeNull();
    }
  });

  it('selecting a weather entity is a draft change — no PATCH until Save', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      calls.push({ url, init });
      if (url.endsWith('/auth/me') && init?.method === 'PATCH') {
        return jsonResponse({ ...SAMPLE_USER, weather_entity_id: 'weather.home' });
      }
      return jsonResponse(null);
    });
    vi.stubGlobal('fetch', fetchMock);

    const el = mountPanel({ hass: HASS });
    await flush(el);
    clickSettings(el.shadowRoot!);
    await flush(el);

    const root = el.shadowRoot!;
    const sel = selectByName(root, 'weather_entity_id');
    sel.value = 'weather.home';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await flush(el);

    expect(calls.find((c) => c.init?.method === 'PATCH')).toBeUndefined();

    root.querySelector<HTMLButtonElement>('button.save-btn')!.click();
    await flush(el);

    const patchCall = calls.find(
      (c) => c.url.endsWith('/auth/me') && c.init?.method === 'PATCH',
    );
    expect(patchCall).toBeDefined();
    expect(JSON.parse(String(patchCall!.init!.body))).toEqual({
      weather_entity_id: 'weather.home',
    });
    expect(authStore.state.user?.weather_entity_id).toBe('weather.home');
  });

  it('Save with both fields dirty sends both in one PATCH', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      calls.push({ url, init });
      if (url.endsWith('/auth/me') && init?.method === 'PATCH') {
        return jsonResponse({
          ...SAMPLE_USER,
          pricing_location: 5,
          weather_entity_id: 'weather.met_no',
        });
      }
      return jsonResponse(null);
    });
    vi.stubGlobal('fetch', fetchMock);

    const el = mountPanel({ hass: HASS });
    await flush(el);
    clickSettings(el.shadowRoot!);
    await flush(el);

    const root = el.shadowRoot!;
    const zone = selectByName(root, 'pricing_zone');
    zone.value = '5';
    zone.dispatchEvent(new Event('change', { bubbles: true }));
    const weather = selectByName(root, 'weather_entity_id');
    weather.value = 'weather.met_no';
    weather.dispatchEvent(new Event('change', { bubbles: true }));
    await flush(el);

    root.querySelector<HTMLButtonElement>('button.save-btn')!.click();
    await flush(el);

    const patchCall = calls.find(
      (c) => c.url.endsWith('/auth/me') && c.init?.method === 'PATCH',
    );
    expect(patchCall).toBeDefined();
    expect(JSON.parse(String(patchCall!.init!.body))).toEqual({
      pricing_location: 5,
      weather_entity_id: 'weather.met_no',
    });
    expect(root.textContent).toContain('Saved');
  });

  it('after Save with no further edits, both Save and Reset are disabled', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(null)));

    const el = mountPanel({ hass: HASS });
    await flush(el);
    clickSettings(el.shadowRoot!);
    await flush(el);

    const root = el.shadowRoot!;
    const saveInitial = root.querySelector<HTMLButtonElement>('button.save-btn')!;
    const resetInitial = root.querySelector<HTMLButtonElement>('button.reset-btn')!;
    expect(saveInitial.disabled).toBe(true);
    expect(resetInitial.disabled).toBe(true);

    const weather = selectByName(root, 'weather_entity_id');
    weather.value = 'weather.home';
    weather.dispatchEvent(new Event('change', { bubbles: true }));
    await flush(el);

    expect(root.querySelector<HTMLButtonElement>('button.save-btn')!.disabled).toBe(false);
    expect(root.querySelector<HTMLButtonElement>('button.reset-btn')!.disabled).toBe(false);
  });

  it('Reset reverts the draft to the saved auth-store state', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(null)));

    const el = mountPanel({ hass: HASS });
    await flush(el);
    clickSettings(el.shadowRoot!);
    await flush(el);

    const root = el.shadowRoot!;
    const weather = selectByName(root, 'weather_entity_id');
    weather.value = 'weather.met_no';
    weather.dispatchEvent(new Event('change', { bubbles: true }));
    await flush(el);
    expect(selectByName(root, 'weather_entity_id').value).toBe('weather.met_no');

    root.querySelector<HTMLButtonElement>('button.reset-btn')!.click();
    await flush(el);

    expect(selectByName(root, 'weather_entity_id').value).toBe('');
  });

  it('pricing zone select shows utility/region labels and the zone-hint reflects the current selection', async () => {
    const el = mountPanel({ hass: HASS });
    await flush(el);
    clickSettings(el.shadowRoot!);
    await flush(el);

    const root = el.shadowRoot!;
    const zone = selectByName(root, 'pricing_zone');
    expect(zone.options.length).toBe(8);

    const zone1 = Array.from(zone.options).find((o) => o.value === '1');
    expect(zone1).toBeDefined();
    expect(zone1!.textContent ?? '').toMatch(/SDG.?E.*San Diego/);

    const zoneSection = Array.from(root.querySelectorAll('.settings-section')).find((s) =>
      s.querySelector('h3')?.textContent?.includes('Pricing zone'),
    );
    expect(zoneSection).toBeDefined();
    const hint = zoneSection!.querySelector('.zone-hint');
    expect(hint).not.toBeNull();

    zone.value = '1';
    zone.dispatchEvent(new Event('change', { bubbles: true }));
    await flush(el);
    expect(zoneSection!.querySelector('.zone-hint')!.textContent ?? '').toMatch(
      /SDG.?E.*San Diego/,
    );
  });

  it('disables the weather select with a helper message when hass is not set', async () => {
    const el = mountPanel();
    await flush(el);
    clickSettings(el.shadowRoot!);
    await flush(el);

    const root = el.shadowRoot!;
    const sel = selectByName(root, 'weather_entity_id');
    expect(sel.disabled).toBe(true);
    const section = Array.from(root.querySelectorAll('.settings-section')).find((s) =>
      s.querySelector('h3')?.textContent?.includes('Weather'),
    );
    expect(section?.textContent).toContain('only available inside Home Assistant');
  });

  it('Account section renders the email, a Sign out button, and a disabled Delete account hint', async () => {
    const el = mountPanel({ hass: HASS });
    await flush(el);
    clickSettings(el.shadowRoot!);
    await flush(el);

    const root = el.shadowRoot!;
    const sections = Array.from(root.querySelectorAll('.settings-section'));
    const account = sections.find((s) => s.textContent?.includes('Account'));
    expect(account).toBeDefined();
    expect(account!.textContent).toContain('jane@example.com');
    const signOut = Array.from(
      account!.querySelectorAll<HTMLButtonElement>('button'),
    ).find((b) => b.textContent?.trim() === 'Sign out');
    expect(signOut).toBeDefined();
    const del = Array.from(
      account!.querySelectorAll<HTMLButtonElement>('button'),
    ).find((b) => b.textContent?.trim() === 'Delete account');
    expect(del).toBeDefined();
    expect(del!.disabled).toBe(true);
    expect(account!.textContent).toContain('info@hungrymachines.io');
  });
});
