import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HmThermostatCard } from '../src/cards/thermostat-card.js';
import { HmScheduleChart } from '../src/ui/schedule-chart.js';
import { authStore, type AuthState } from '../src/store.js';
import { clearTokens, setApiBase, setTokens } from '../src/api/client.js';

if (!customElements.get('hm-schedule-chart')) {
  customElements.define('hm-schedule-chart', HmScheduleChart);
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
};

const HVAC_SCHEDULE_RESPONSE = {
  date: '2025-11-18',
  schedule: {
    intervals: Array.from({ length: 48 }, (_, i) => i),
    high_temps: Array<number>(48).fill(74),
    low_temps: Array<number>(48).fill(70),
  },
  mode: 'cool',
  estimated_savings_pct: 18.5,
  model_confidence: 0.3,
  generated_at: '2025-11-18T04:15:00+00:00',
  source: 'optimization',
};

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

function installFetchStub(): FetchCall[] {
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
      if (url.endsWith('/api/v1/schedule')) return jsonResponse(HVAC_SCHEDULE_RESPONSE);
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

    slider!.value = '4';
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
    expect(body).toEqual({ savings_level: 4 });
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

  it('exposes getCardSize() returning 4', () => {
    const el = mountCard();
    expect(el.getCardSize()).toBe(4);
  });
});
