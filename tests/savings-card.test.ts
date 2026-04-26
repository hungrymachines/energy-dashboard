import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HmSavingsCard } from '../src/cards/savings-card.js';
import { authStore, type AuthState } from '../src/store.js';
import { clearTokens, setApiBase, setTokens } from '../src/api/client.js';

if (!customElements.get('hm-savings-card')) {
  customElements.define('hm-savings-card', HmSavingsCard);
}

type CardEl = HmSavingsCard & { updateComplete: Promise<boolean> };

const SAMPLE_USER = {
  user_id: 'user-123',
  email: 'jane@example.com',
  location_zip: '94107',
  home_size_sqft: 1800,
  pricing_location: 3,
  timezone: 'America/Los_Angeles',
  subscription_tier: 'free',
};

const EV_INTERVALS = Array<boolean>(48)
  .fill(false)
  .map((_, i) => i === 28);

const HVAC_APPLIANCE = {
  appliance_id: 'hvac-1',
  appliance_type: 'hvac' as const,
  name: 'Living Room AC',
  schedule: {
    intervals: Array.from({ length: 48 }, (_, i) => i),
    high_temps: Array<number>(48).fill(74),
    low_temps: Array<number>(48).fill(70),
  },
  savings_pct: 18,
  source: 'optimization',
};

const EV_APPLIANCE = {
  appliance_id: 'ev-1',
  appliance_type: 'ev_charger' as const,
  name: 'Tesla Model 3',
  schedule: {
    intervals: EV_INTERVALS,
    value_trajectory: Array.from({ length: 48 }, (_, i) => 30 + i),
    unit: 'percent',
  },
  savings_pct: 32,
  source: 'optimization',
};

const SCHEDULES_RESPONSE = {
  date: '2025-11-18',
  appliances: [HVAC_APPLIANCE, EV_APPLIANCE],
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

function installFetchStub(schedules: unknown = SCHEDULES_RESPONSE): FetchCall[] {
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
      return new Response('{}', {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  return calls;
}

function mountCard(init: Partial<HmSavingsCard> = {}): CardEl {
  const el = document.createElement('hm-savings-card') as CardEl;
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

describe('hm-savings-card', () => {
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
    // Fix "current time" to 08:00 local so interval 28 (14:00) is upcoming.
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    vi.setSystemTime(new Date(2025, 10, 18, 8, 0, 0));
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

  it('renders the average savings across appliances as a rounded percent', async () => {
    installFetchStub();
    const el = mountCard();
    el.setConfig({ type: 'custom:hm-savings-card' });
    await flush(el);

    const root = el.shadowRoot!;
    const savings = root.querySelector('.savings');
    expect(savings).not.toBeNull();
    // (18 + 32) / 2 = 25
    expect(savings!.textContent).toMatch(/25%\s+savings today/);
  });

  it('converts home power > 1000 W into "1.5 kW" using the configured hass entity', async () => {
    installFetchStub();
    const hass = {
      states: {
        'sensor.home_power': {
          entity_id: 'sensor.home_power',
          state: '1500',
        },
      },
    };
    const el = mountCard({ hass });
    el.setConfig({
      type: 'custom:hm-savings-card',
      entities: { power: 'sensor.home_power' },
    });
    await flush(el);

    const root = el.shadowRoot!;
    const power = root.querySelector('.power-value');
    expect(power).not.toBeNull();
    expect(power!.textContent).toContain('1.5 kW');
  });

  it('renders the next scheduled run HH:MM (interval 28 → 14:00) with appliance name', async () => {
    installFetchStub();
    const el = mountCard();
    el.setConfig({ type: 'custom:hm-savings-card' });
    await flush(el);

    const root = el.shadowRoot!;
    const nextValue = root.querySelector('.next-value');
    expect(nextValue).not.toBeNull();
    expect(nextValue!.textContent).toContain('Tesla Model 3');
    expect(nextValue!.textContent).toContain('14:00');
  });

  it('renders the sign-in stub when the auth store is not authed', async () => {
    installFetchStub();
    setAuthState({ status: 'unauthed' });

    const el = mountCard();
    await flush(el);

    const root = el.shadowRoot!;
    expect(root.textContent).toContain(
      'Sign in from the Hungry Machines panel to see your savings',
    );
    expect(root.querySelector('.savings')).toBeNull();
  });

  it('exposes getCardSize() returning 2', () => {
    const el = mountCard();
    expect(el.getCardSize()).toBe(2);
  });

  it('renders "No upcoming runs." when no non-HVAC schedule has a true interval', async () => {
    installFetchStub({
      date: '2025-11-18',
      appliances: [
        HVAC_APPLIANCE,
        {
          ...EV_APPLIANCE,
          schedule: {
            ...EV_APPLIANCE.schedule,
            intervals: Array<boolean>(48).fill(false),
          },
        },
      ],
    });
    const el = mountCard();
    el.setConfig({ type: 'custom:hm-savings-card' });
    await flush(el);

    const nextValue = el.shadowRoot!.querySelector('.next-value');
    expect(nextValue!.textContent).toContain('No upcoming runs.');
  });
});
