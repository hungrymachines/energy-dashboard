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
    'sensor.living_room_temp': {
      entity_id: 'sensor.living_room_temp',
      state: '72',
    },
    'sensor.outside_temp': {
      entity_id: 'sensor.outside_temp',
      state: '58',
    },
    'sensor.home_power': {
      entity_id: 'sensor.home_power',
      state: '1200',
    },
    'weather.home': {
      entity_id: 'weather.home',
      state: 'sunny',
    },
    // Non-matching entity to ensure filtering works.
    'light.kitchen': {
      entity_id: 'light.kitchen',
      state: 'off',
    },
  },
};

describe('hungry-machines-panel settings', () => {
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
    // Default stub for the dashboard fetches fired on mount (schedules, rates, appliances).
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

  it('populates sensor dropdowns with sensor entities and the weather dropdown with weather entities', async () => {
    const el = mountPanel({ hass: HASS });
    await flush(el);
    const root = el.shadowRoot!;
    clickSettings(root);
    await flush(el);

    const expectedSensors = [
      'sensor.home_power',
      'sensor.living_room_temp',
      'sensor.outside_temp',
    ];
    const expectedWeather = ['weather.home'];

    for (const field of ['indoor_temp', 'outdoor_temp', 'power']) {
      const sel = selectByName(root, `entity_${field}`);
      const values = Array.from(sel.options)
        .map((o) => o.value)
        .filter((v) => v !== '');
      expect(values.sort()).toEqual([...expectedSensors].sort());
      expect(sel.disabled).toBe(false);
    }

    const weatherSel = selectByName(root, 'entity_weather');
    const weatherValues = Array.from(weatherSel.options)
      .map((o) => o.value)
      .filter((v) => v !== '');
    expect(weatherValues).toEqual(expectedWeather);
  });

  it('changing an entity dropdown writes to localStorage under hm_entity_map', async () => {
    const el = mountPanel({ hass: HASS });
    await flush(el);
    clickSettings(el.shadowRoot!);
    await flush(el);

    const root = el.shadowRoot!;
    const indoor = selectByName(root, 'entity_indoor_temp');
    indoor.value = 'sensor.living_room_temp';
    indoor.dispatchEvent(new Event('change', { bubbles: true }));
    await flush(el);

    const raw = localStorage.getItem('hm_entity_map');
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed).toEqual({ indoor_temp: 'sensor.living_room_temp' });

    // Changing a second field merges into the stored map.
    const power = selectByName(root, 'entity_power');
    power.value = 'sensor.home_power';
    power.dispatchEvent(new Event('change', { bubbles: true }));
    await flush(el);

    const raw2 = localStorage.getItem('hm_entity_map');
    const parsed2 = JSON.parse(raw2!);
    expect(parsed2).toEqual({
      indoor_temp: 'sensor.living_room_temp',
      power: 'sensor.home_power',
    });
  });

  it('changing the pricing zone triggers a PATCH /auth/me fetch and updates the store', async () => {
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
        return jsonResponse({ ...SAMPLE_USER, pricing_location: 5 });
      }
      // All dashboard fetches return empty/no-op payloads.
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
    await flush(el);

    const patchCall = calls.find(
      (c) => c.url.endsWith('/auth/me') && c.init?.method === 'PATCH',
    );
    expect(patchCall).toBeDefined();
    expect(JSON.parse(String(patchCall!.init!.body))).toEqual({ pricing_location: 5 });
    expect(authStore.state.user?.pricing_location).toBe(5);
  });

  it('disables the entity dropdowns with a helper message when hass is not set', async () => {
    const el = mountPanel();
    await flush(el);
    clickSettings(el.shadowRoot!);
    await flush(el);

    const root = el.shadowRoot!;
    for (const field of ['indoor_temp', 'outdoor_temp', 'power', 'weather']) {
      const sel = selectByName(root, `entity_${field}`);
      expect(sel.disabled).toBe(true);
    }
    const section = root.querySelector('.settings-section');
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
