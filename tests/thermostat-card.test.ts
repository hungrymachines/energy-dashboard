import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HmThermostatCard } from '../src/cards/thermostat-card.js';
import { HmOptimizationChart } from '../src/ui/optimization-chart.js';
import { authStore, type AuthState } from '../src/store.js';
import { clearTokens, setApiBase, setTokens } from '../src/api/client.js';

if (!customElements.get('hm-optimization-chart')) {
  customElements.define('hm-optimization-chart', HmOptimizationChart);
}
if (!customElements.get('hm-thermostat-card')) {
  customElements.define('hm-thermostat-card', HmThermostatCard);
}

type CardEl = HmThermostatCard & { updateComplete: Promise<boolean> };

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

function makeHvacAppliance(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    appliance_id: 'hvac-1',
    appliance_type: 'hvac',
    name: 'Thermostat',
    schedule: {
      intervals: Array.from({ length: 48 }, (_, i) => i),
      high_temps: Array<number>(48).fill(74),
      low_temps: Array<number>(48).fill(70),
      mode: 'cool',
    },
    savings_pct: 18.5,
    source: 'optimization',
    optimization_enabled: true,
    ...overrides,
  };
}

function makeSchedules(appliances: Record<string, unknown>[]): Record<string, unknown> {
  return { date: '2025-11-18', appliances };
}

const PREFERENCES_RESPONSE = {
  base_temperature: 72,
  savings_level: 2,
  time_away: '08:00',
  time_home: '18:00',
  optimization_mode: 'balanced',
};

const RATES_RESPONSE = {
  pricing_location: 3,
  intervals: Array.from({ length: 48 }, (_, i) => i),
  rates_cents_per_kwh: Array<number>(48).fill(12),
  unit: 'cents/kWh',
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type FetchCall = { url: string; init: RequestInit | undefined };

function installFetchStub(
  schedules: Record<string, unknown> = makeSchedules([makeHvacAppliance()]),
): FetchCall[] {
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
      calls.push({ url, init });
      if (url.endsWith('/api/v1/schedules')) return jsonResponse(schedules);
      if (url.endsWith('/api/v1/preferences')) return jsonResponse(PREFERENCES_RESPONSE);
      if (url.endsWith('/api/v1/rates')) return jsonResponse(RATES_RESPONSE);
      return new Response('{}', {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  return calls;
}

function mountCard(init: Partial<HmThermostatCard> = {}): CardEl {
  const el = document.createElement('hm-thermostat-card') as CardEl;
  Object.assign(el, init);
  document.body.appendChild(el);
  return el;
}

async function flush(el: CardEl): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await el.updateComplete;
    await Promise.resolve();
  }
}

describe('hm-thermostat-card', () => {
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
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    localStorage.clear();
    clearTokens();
    setAuthState({});
  });

  it('renders the configured indoor temperature entity value', async () => {
    installFetchStub();
    const hass = {
      states: {
        'sensor.living_room_temp': {
          entity_id: 'sensor.living_room_temp',
          state: '71.4',
        },
        'sensor.outside_temp': {
          entity_id: 'sensor.outside_temp',
          state: '55',
        },
      },
    };
    const el = mountCard({ hass });
    el.setConfig({
      type: 'custom:hm-thermostat-card',
      entities: {
        indoor_temp: 'sensor.living_room_temp',
        outdoor_temp: 'sensor.outside_temp',
      },
    });
    await flush(el);

    const root = el.shadowRoot!;
    const indoor = root.querySelector('.indoor');
    expect(indoor).not.toBeNull();
    // 71.4 rounds to 71
    expect(indoor!.textContent).toContain('71');
    const outdoor = root.querySelector('.outdoor');
    expect(outdoor!.textContent).toContain('55');
  });

  it('debounces slider changes and calls PUT /api/v1/preferences after 500ms', async () => {
    const calls = installFetchStub();
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });

    const el = mountCard({
      hass: {
        states: {
          'sensor.living_room_temp': {
            entity_id: 'sensor.living_room_temp',
            state: '72',
          },
        },
      },
    });
    el.setConfig({
      type: 'custom:hm-thermostat-card',
      entities: { indoor_temp: 'sensor.living_room_temp' },
    });
    await flush(el);

    const root = el.shadowRoot!;
    const slider = root.querySelector<HTMLInputElement>('input[name="savings_level"]');
    expect(slider).not.toBeNull();

    // Clear any prior calls so we only capture the PUT triggered by the slider.
    const startIdx = calls.length;

    slider!.value = '2';
    slider!.dispatchEvent(new Event('input', { bubbles: true }));

    // Before timer fires, no PUT.
    const beforePut = calls.slice(startIdx).find(
      (c) => c.url.endsWith('/api/v1/preferences') && c.init?.method === 'PUT',
    );
    expect(beforePut).toBeUndefined();

    await vi.advanceTimersByTimeAsync(500);
    await flush(el);

    const putCall = calls.slice(startIdx).find(
      (c) => c.url.endsWith('/api/v1/preferences') && c.init?.method === 'PUT',
    );
    expect(putCall).toBeDefined();
    const body = JSON.parse(String(putCall!.init!.body));
    expect(body).toEqual({ savings_level: 2 });
  });

  it('renders the savings slider with max="3" (matches backend [1,3] range)', async () => {
    installFetchStub();
    const el = mountCard({
      hass: {
        states: {
          'sensor.living_room_temp': {
            entity_id: 'sensor.living_room_temp',
            state: '72',
          },
        },
      },
    });
    el.setConfig({
      type: 'custom:hm-thermostat-card',
      entities: { indoor_temp: 'sensor.living_room_temp' },
    });
    await flush(el);

    const slider = el.shadowRoot!.querySelector<HTMLInputElement>(
      'input[name="savings_level"]',
    );
    expect(slider).not.toBeNull();
    expect(slider!.getAttribute('max')).toBe('3');
    expect(slider!.getAttribute('min')).toBe('1');
  });

  it('_clampLevel clamps above 3 down to 3 and below 1 up to 1', () => {
    const el = mountCard();
    const clamp = (
      el as unknown as { _clampLevel: (n: number) => number }
    )._clampLevel.bind(el);
    expect(clamp(5)).toBe(3);
    expect(clamp(4)).toBe(3);
    expect(clamp(0)).toBe(1);
    expect(clamp(-1)).toBe(1);
    expect(clamp(2)).toBe(2);
    // Non-finite falls back to default 3.
    expect(clamp(Number.NaN)).toBe(3);
  });

  it('clamps a slider drag to 4 down to 3 before persisting', async () => {
    const calls = installFetchStub();
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });

    const el = mountCard({
      hass: {
        states: {
          'sensor.living_room_temp': {
            entity_id: 'sensor.living_room_temp',
            state: '72',
          },
        },
      },
    });
    el.setConfig({
      type: 'custom:hm-thermostat-card',
      entities: { indoor_temp: 'sensor.living_room_temp' },
    });
    await flush(el);

    const slider = el.shadowRoot!.querySelector<HTMLInputElement>(
      'input[name="savings_level"]',
    );
    expect(slider).not.toBeNull();

    const startIdx = calls.length;
    // Browsers honor the input element's max attribute, but we still defend
    // in code. Simulate a value out of range slipping through.
    slider!.value = '4';
    slider!.dispatchEvent(new Event('input', { bubbles: true }));

    await vi.advanceTimersByTimeAsync(500);
    await flush(el);

    const putCall = calls.slice(startIdx).find(
      (c) => c.url.endsWith('/api/v1/preferences') && c.init?.method === 'PUT',
    );
    expect(putCall).toBeDefined();
    const body = JSON.parse(String(putCall!.init!.body));
    expect(body).toEqual({ savings_level: 3 });

    // The visible slider value also reflects the clamp.
    const sliderValue = el.shadowRoot!.querySelector('.slider-value');
    expect(sliderValue!.textContent).toBe('3');
  });

  it('renders the sign-in stub when the auth store is not authed', async () => {
    installFetchStub();
    setAuthState({ status: 'unauthed' });

    const el = mountCard();
    await flush(el);

    const root = el.shadowRoot!;
    expect(root.textContent).toContain(
      'Sign in from the Hungry Machines panel',
    );
    expect(root.querySelector('.indoor')).toBeNull();
    expect(root.querySelector('input[name="savings_level"]')).toBeNull();
  });

  it('exposes getCardSize() returning 5', () => {
    const el = mountCard();
    expect(el.getCardSize()).toBe(5);
  });

  it('renders the panel-style card chrome (badge, name, savings, mode)', async () => {
    installFetchStub();
    const el = mountCard({
      hass: {
        states: {
          'sensor.living_room_temp': {
            entity_id: 'sensor.living_room_temp',
            state: '72',
          },
        },
      },
    });
    el.setConfig({
      type: 'custom:hm-thermostat-card',
      entities: { indoor_temp: 'sensor.living_room_temp' },
    });
    await flush(el);

    const root = el.shadowRoot!;
    // Matches the panel's .card / .card-head / .savings classes so the
    // overview card and dashboard card read as siblings.
    expect(root.querySelector('.card[data-appliance-type="hvac"]')).not.toBeNull();
    const badge = root.querySelector('.card-head .badge');
    expect(badge!.textContent?.trim()).toBe('HVAC');
    const name = root.querySelector('.card-head .name');
    expect(name!.textContent?.trim()).toBe('Thermostat');
    // Mode badge picks up the schedule's mode ("cool" in the fixture).
    const mode = root.querySelector('.card-head .mode-badge');
    expect(mode!.getAttribute('data-mode')).toBe('cool');
    // Savings line uses the same wording as the panel card.
    expect(root.querySelector('.savings')!.textContent).toContain('savings today');
  });

  it('US-MHVAC-018: selects the configured HVAC by appliance_id when the user has multiple', async () => {
    installFetchStub(
      makeSchedules([
        makeHvacAppliance({
          appliance_id: 'hvac-living',
          name: 'Living Room AC',
          savings_pct: 12,
          schedule: {
            intervals: Array.from({ length: 48 }, (_, i) => i),
            high_temps: Array<number>(48).fill(76),
            low_temps: Array<number>(48).fill(72),
            mode: 'cool',
          },
        }),
        makeHvacAppliance({
          appliance_id: 'hvac-bedroom',
          name: 'Bedroom Mini-Split',
          savings_pct: 28,
          schedule: {
            intervals: Array.from({ length: 48 }, (_, i) => i),
            high_temps: Array<number>(48).fill(70),
            low_temps: Array<number>(48).fill(66),
            mode: 'cool',
          },
        }),
      ]),
    );
    const el = mountCard({
      hass: {
        states: {
          'sensor.living_room_temp': {
            entity_id: 'sensor.living_room_temp',
            state: '72',
          },
        },
      },
    });
    el.setConfig({
      type: 'custom:hm-thermostat-card',
      appliance_id: 'hvac-bedroom',
      entities: { indoor_temp: 'sensor.living_room_temp' },
    });
    await flush(el);

    const root = el.shadowRoot!;
    // The card picked the bedroom unit by id, not the first HVAC.
    expect(root.querySelector('.card-head .name')!.textContent?.trim()).toBe(
      'Bedroom Mini-Split',
    );
    expect(root.querySelector('.savings')!.textContent).toContain('28%');
    expect(root.querySelector('.multi-hvac-stub')).toBeNull();
  });

  it('US-MHVAC-018: back-compat — single HVAC with no appliance_id auto-resolves', async () => {
    installFetchStub(
      makeSchedules([
        makeHvacAppliance({
          appliance_id: 'hvac-only',
          name: 'Whole Home AC',
          savings_pct: 22,
        }),
      ]),
    );
    const el = mountCard({
      hass: {
        states: {
          'sensor.living_room_temp': {
            entity_id: 'sensor.living_room_temp',
            state: '72',
          },
        },
      },
    });
    el.setConfig({
      type: 'custom:hm-thermostat-card',
      entities: { indoor_temp: 'sensor.living_room_temp' },
    });
    await flush(el);

    const root = el.shadowRoot!;
    expect(root.querySelector('.card-head .name')!.textContent?.trim()).toBe(
      'Whole Home AC',
    );
    expect(root.querySelector('.savings')!.textContent).toContain('22%');
    expect(root.querySelector('.multi-hvac-stub')).toBeNull();
  });

  it('US-MHVAC-018: multi-HVAC with no appliance_id renders a configuration stub', async () => {
    installFetchStub(
      makeSchedules([
        makeHvacAppliance({ appliance_id: 'hvac-a', name: 'A' }),
        makeHvacAppliance({ appliance_id: 'hvac-b', name: 'B' }),
      ]),
    );
    const el = mountCard({
      hass: {
        states: {
          'sensor.living_room_temp': {
            entity_id: 'sensor.living_room_temp',
            state: '72',
          },
        },
      },
    });
    el.setConfig({
      type: 'custom:hm-thermostat-card',
      entities: { indoor_temp: 'sensor.living_room_temp' },
    });
    await flush(el);

    const root = el.shadowRoot!;
    const stub = root.querySelector('.multi-hvac-stub');
    expect(stub).not.toBeNull();
    expect(stub!.textContent).toContain('appliance_id');
  });

  it('US-MHVAC-018: shows integration_health badge for non-healthy verdicts (frozen_sensor)', async () => {
    installFetchStub(
      makeSchedules([
        makeHvacAppliance({
          integration_health: {
            status: 'frozen_sensor',
            message: 'Indoor temperature has not changed in 6 hours.',
            sample_count: 60,
            lookback_hours: 6,
          },
        }),
      ]),
    );
    const el = mountCard({
      hass: {
        states: {
          'sensor.living_room_temp': {
            entity_id: 'sensor.living_room_temp',
            state: '72',
          },
        },
      },
    });
    el.setConfig({
      type: 'custom:hm-thermostat-card',
      entities: { indoor_temp: 'sensor.living_room_temp' },
    });
    await flush(el);

    const root = el.shadowRoot!;
    const badge = root.querySelector('.health-badge') as HTMLElement | null;
    expect(badge).not.toBeNull();
    // Visible (no hidden attribute) because status != 'healthy'.
    expect(badge!.hasAttribute('hidden')).toBe(false);
    expect(badge!.getAttribute('data-status')).toBe('frozen_sensor');
    expect(badge!.textContent).toContain('Indoor temperature has not changed');
  });

  it('US-MHVAC-018: hides integration_health badge when status is healthy', async () => {
    installFetchStub(
      makeSchedules([
        makeHvacAppliance({
          integration_health: {
            status: 'healthy',
            message: 'OK',
          },
        }),
      ]),
    );
    const el = mountCard({
      hass: {
        states: {
          'sensor.living_room_temp': {
            entity_id: 'sensor.living_room_temp',
            state: '72',
          },
        },
      },
    });
    el.setConfig({
      type: 'custom:hm-thermostat-card',
      entities: { indoor_temp: 'sensor.living_room_temp' },
    });
    await flush(el);

    const badge = el.shadowRoot!.querySelector(
      '.health-badge',
    ) as HTMLElement | null;
    expect(badge).not.toBeNull();
    expect(badge!.hasAttribute('hidden')).toBe(true);
  });

  it('renders <hm-optimization-chart> with HVAC-range props (40–100°F)', async () => {
    installFetchStub();
    const el = mountCard({
      hass: {
        states: {
          'sensor.living_room_temp': {
            entity_id: 'sensor.living_room_temp',
            state: '72',
          },
        },
      },
    });
    el.setConfig({
      type: 'custom:hm-thermostat-card',
      entities: { indoor_temp: 'sensor.living_room_temp' },
    });
    await flush(el);

    const chart = el.shadowRoot!.querySelector(
      'hm-optimization-chart',
    ) as unknown as HmOptimizationChart | null;
    expect(chart).not.toBeNull();
    // The card pins HVAC range so the visual scale matches the dashboard
    // (40–100 °F, never auto-derived).
    expect(chart!.yMin).toBe(40);
    expect(chart!.yMax).toBe(100);
    expect(chart!.unit).toBe('fahrenheit');
  });
});
