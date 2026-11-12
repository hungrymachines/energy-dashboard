import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HmThermostatCard } from '../src/cards/thermostat-card.js';
import { HmOptimizationChart } from '../src/ui/optimization-chart.js';
import { authStore, type AuthState } from '../src/store.js';
import { clearTokens, setApiBase, setTokens } from '../src/api/client.js';
import { temperatureUnitStore } from '../src/utils/temperature.js';

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
  appliancePrefs: Record<string, unknown> = PREFERENCES_RESPONSE,
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
      if (/\/api\/v1\/appliances\/[^/]+\/preferences$/.test(url)) {
        return jsonResponse(appliancePrefs);
      }
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
  // The card fires two dependent async loads on mount: getAllSchedules /
  // getPreferences / getRates in parallel, THEN a per-appliance
  // getAppliancePreferences that depends on the resolved schedule. Give
  // the extra await chain enough microtask turns to settle.
  for (let i = 0; i < 10; i++) {
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
    temperatureUnitStore.setPreference(null);
    temperatureUnitStore.setHaUnit(null);
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

  it('with no entities configured, shows the indoor sensor mapped to the appliance', async () => {
    installFetchStub(
      makeSchedules([
        makeHvacAppliance({
          entities: { entity_id: 'climate.living', indoor_temp_entity_id: 'sensor.back_room' },
        }),
      ]),
    );
    const hass = {
      states: {
        'sensor.back_room': { state: '69.6', attributes: { unit_of_measurement: '°F' } },
        'climate.living': {
          state: 'cool',
          attributes: { current_temperature: 75, temperature: 74, hvac_action: 'cooling' },
        },
      },
    };
    const el = mountCard({ hass });
    el.setConfig({ type: 'custom:hm-thermostat-card' });
    await flush(el);

    const root = el.shadowRoot!;
    expect(root.querySelector('.indoor')!.textContent).toBe('70°');
    expect(root.querySelector('.thermostat')!.textContent).toBe('Set to 74° · cooling');
  });

  it("falls back to the thermostat's own reading when no sensor is mapped", async () => {
    installFetchStub(
      makeSchedules([makeHvacAppliance({ entities: { entity_id: 'climate.living' } })]),
    );
    const hass = {
      states: {
        'climate.living': {
          state: 'heat_cool',
          attributes: { current_temperature: 71, target_temp_low: 68, target_temp_high: 75 },
        },
      },
    };
    const el = mountCard({ hass });
    el.setConfig({ type: 'custom:hm-thermostat-card' });
    await flush(el);

    const root = el.shadowRoot!;
    expect(root.querySelector('.indoor')!.textContent).toBe('71°');
    expect(root.querySelector('.thermostat')!.textContent).toBe('Set to 68° to 75°');
  });

  it('converts thermostat readings from a metric Home Assistant', async () => {
    installFetchStub(
      makeSchedules([makeHvacAppliance({ entities: { entity_id: 'climate.living' } })]),
    );
    const hass = {
      config: { unit_system: { temperature: '°C' } },
      states: {
        'climate.living': { state: 'cool', attributes: { current_temperature: 20, temperature: 25 } },
      },
    };
    const el = mountCard({ hass });
    el.setConfig({ type: 'custom:hm-thermostat-card' });
    await flush(el);
    temperatureUnitStore.setPreference('F');
    await flush(el);

    const root = el.shadowRoot!;
    expect(root.querySelector('.indoor')!.textContent).toBe('68°');
    expect(root.querySelector('.thermostat')!.textContent).toBe('Set to 77°');
  });

  it('says the thermostat is off and shows no readout when nothing is available', async () => {
    installFetchStub(
      makeSchedules([makeHvacAppliance({ entities: { entity_id: 'climate.living' } })]),
    );
    const el = mountCard({ hass: { states: { 'climate.living': { state: 'off', attributes: {} } } } });
    el.setConfig({ type: 'custom:hm-thermostat-card' });
    await flush(el);

    const root = el.shadowRoot!;
    expect(root.querySelector('.indoor')).toBeNull();
    expect(root.querySelector('.thermostat')!.textContent).toBe('Thermostat off');
  });

  it('has no savings slider', async () => {
    installFetchStub();
    const el = mountCard({ hass: { states: {} } });
    el.setConfig({ type: 'custom:hm-thermostat-card' });
    await flush(el);

    expect(el.shadowRoot!.querySelector('input[type="range"]')).toBeNull();
  });

  it("draws the appliance's saved comfort band over the one stored with the plan", async () => {
    installFetchStub(makeSchedules([makeHvacAppliance()]), {
      ...PREFERENCES_RESPONSE,
      hourly_high_temps_f: Array<number>(24).fill(78),
      hourly_low_temps_f: Array<number>(24).fill(67),
    });
    const el = mountCard({ hass: { states: {} } });
    el.setConfig({ type: 'custom:hm-thermostat-card' });
    await flush(el);

    const chart = el.shadowRoot!.querySelector(
      'hm-optimization-chart',
    ) as unknown as HmOptimizationChart;
    expect(chart.highLimits).toEqual(Array<number>(48).fill(78));
    expect(chart.lowLimits).toEqual(Array<number>(48).fill(67));
  });

  it("draws today's own band when the day has one", async () => {
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    vi.setSystemTime(new Date(2026, 10, 14, 9, 0, 0)); // a Saturday
    installFetchStub(makeSchedules([makeHvacAppliance()]), {
      ...PREFERENCES_RESPONSE,
      hourly_high_temps_f: Array<number>(24).fill(78),
      hourly_low_temps_f: Array<number>(24).fill(67),
      weekday_bands: {
        sat: {
          hourly_high_temps_f: Array<number>(24).fill(80),
          hourly_low_temps_f: Array<number>(24).fill(65),
        },
      },
    });
    const el = mountCard({ hass: { states: {} } });
    el.setConfig({ type: 'custom:hm-thermostat-card' });
    await flush(el);

    const chart = el.shadowRoot!.querySelector(
      'hm-optimization-chart',
    ) as unknown as HmOptimizationChart;
    expect(chart.highLimits).toEqual(Array<number>(48).fill(80));
    expect(chart.lowLimits).toEqual(Array<number>(48).fill(65));
  });

  it("keeps the plan's band when the appliance has no saved hourly band", async () => {
    installFetchStub();
    const el = mountCard({ hass: { states: {} } });
    el.setConfig({ type: 'custom:hm-thermostat-card' });
    await flush(el);

    const chart = el.shadowRoot!.querySelector(
      'hm-optimization-chart',
    ) as unknown as HmOptimizationChart;
    expect(chart.highLimits).toEqual(Array<number>(48).fill(74));
    expect(chart.lowLimits).toEqual(Array<number>(48).fill(70));
  });

  describe('status note and mode badge', () => {
    async function noteFor(entry: Record<string, unknown>): Promise<ShadowRoot> {
      installFetchStub(makeSchedules([makeHvacAppliance(entry)]));
      const el = mountCard({ hass: { states: {} } });
      el.setConfig({ type: 'custom:hm-thermostat-card' });
      await flush(el);
      return el.shadowRoot!;
    }
    const plan = makeHvacAppliance().schedule as Record<string, unknown>;

    it('a normal plan day has no note', async () => {
      const root = await noteFor({});
      expect(root.querySelector('.status-note')).toBeNull();
    });

    it('an idle day says so and badges the card idle', async () => {
      const root = await noteFor({ schedule: { ...plan, idle_day: true } });
      expect(root.querySelector('.status-note')!.textContent).toContain('Idle day');
      expect(root.querySelector('.mode-badge')!.textContent).toBe('idle');
    });

    it('a warm-up test day says so', async () => {
      const root = await noteFor({ schedule: { ...plan, calibration: { kind: 'fan' } } });
      expect(root.querySelector('.status-note')!.textContent).toContain('warm-up test');
    });

    it('a plan from an earlier day says so', async () => {
      const root = await noteFor({ stale: true });
      expect(root.querySelector('.status-note')!.textContent).toContain('not ready yet');
    });

    it('no plan: says so, with no mode badge and no savings figure', async () => {
      const root = await noteFor({ schedule: {}, savings_pct: 0, source: 'defaults' });
      expect(root.querySelector('.status-note')!.textContent).toBe('No plan for this unit yet.');
      expect(root.querySelector('.mode-badge')).toBeNull();
      expect(root.querySelector('.savings')).toBeNull();
    });

    it('a paused unit or home says so and shows no savings figure', async () => {
      const unit = await noteFor({ pause_state: 'manual', savings_pct: 0 });
      expect(unit.querySelector('.status-note')!.textContent).toContain('paused for this unit');
      expect(unit.querySelector('.savings')).toBeNull();
      document.body.innerHTML = '';
      const home = await noteFor({ pause_state: 'master', savings_pct: 0 });
      expect(home.querySelector('.status-note')!.textContent).toContain('paused for the whole home');
    });
  });

  it("names the plan's average price in the savings hover text", async () => {
    installFetchStub(
      makeSchedules([
        makeHvacAppliance({
          schedule: {
            ...(makeHvacAppliance().schedule as Record<string, unknown>),
            pricing_cents_48: Array.from({ length: 48 }, (_, i) => (i < 24 ? 10 : 20)),
          },
        }),
      ]),
    );
    const el = mountCard({ hass: { states: {} } });
    el.setConfig({ type: 'custom:hm-thermostat-card' });
    await flush(el);

    expect(el.shadowRoot!.querySelector('.savings')!.getAttribute('title')).toContain(
      '(avg 15.0 ¢/kWh)',
    );
  });

  it('asks for the plan again once it is five minutes old, driven by hass updates', async () => {
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    vi.setSystemTime(new Date(2026, 10, 12, 9, 0, 0));
    const calls = installFetchStub();
    const el = mountCard({ hass: { states: {} } });
    el.setConfig({ type: 'custom:hm-thermostat-card' });
    await flush(el);
    const schedulesCalls = () => calls.filter((c) => c.url.endsWith('/api/v1/schedules')).length;
    expect(schedulesCalls()).toBe(1);

    el.hass = { states: {} };
    await flush(el);
    expect(schedulesCalls()).toBe(1);

    vi.setSystemTime(new Date(2026, 10, 12, 9, 6, 0));
    el.hass = { states: {} };
    await flush(el);
    expect(schedulesCalls()).toBe(2);
  });

  it('links to the panel without reloading the page', async () => {
    installFetchStub();
    const push = vi.spyOn(history, 'pushState').mockImplementation(() => {});
    const moved = vi.fn();
    window.addEventListener('location-changed', moved);
    const el = mountCard({ hass: { states: {} } });
    el.setConfig({ type: 'custom:hm-thermostat-card' });
    await flush(el);

    const link = el.shadowRoot!.querySelector('.card-foot a') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/hungry-machines');
    link.click();
    expect(push).toHaveBeenCalledWith(null, '', '/hungry-machines');
    expect(moved).toHaveBeenCalledTimes(1);
    window.removeEventListener('location-changed', moved);
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
    expect(root.querySelector('.savings')!.textContent).toMatch(/^est\. \d+% savings today$/);
  });

  it('selects the configured HVAC by appliance_id when the user has multiple', async () => {
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

  it('back-compat — single HVAC with no appliance_id auto-resolves', async () => {
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

  it('multi-HVAC with no appliance_id renders a configuration stub', async () => {
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

  it('shows integration_health badge for non-healthy verdicts (frozen_sensor)', async () => {
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

  it('hides integration_health badge when status is healthy', async () => {
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

  describe('pause row', () => {
    function pauseFetch(entry: Record<string, unknown>): FetchCall[] {
      const calls = installFetchStub(makeSchedules([makeHvacAppliance(entry)]));
      const base = globalThis.fetch as unknown as (u: string, i?: RequestInit) => Promise<Response>;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string, init?: RequestInit) => {
          if (/\/(pause|resume)$/.test(String(input))) {
            calls.push({ url: String(input), init });
            return jsonResponse({ appliance_id: 'hvac-1', pause_state: 'timed' });
          }
          return base(input, init);
        }),
      );
      return calls;
    }

    it('active HVAC: three buttons POST 120/240/360 and call apply_now', async () => {
      const calls = pauseFetch({ pause_state: 'active', paused_until: null });
      const callService = vi.fn(async () => undefined);
      const el = mountCard({ hass: { states: {}, callService } });
      el.setConfig({ type: 'custom:hm-thermostat-card' });
      await flush(el);
      for (const [name, minutes] of [['pause_2h', 120], ['pause_4h', 240], ['pause_6h', 360]] as const) {
        const btn = el.shadowRoot!.querySelector(`button[name="${name}"]`) as HTMLButtonElement;
        expect(btn).not.toBeNull();
        btn.click();
        await vi.waitFor(() => expect((el as unknown as { _pauseBusy: boolean })._pauseBusy).toBe(false));
        await flush(el);
        const post = calls.filter((c) => c.url.endsWith('/pause')).pop()!;
        expect(JSON.parse(String(post.init?.body))).toEqual({ minutes });
      }
      expect(callService).toHaveBeenCalledWith('hungry_machines', 'apply_now', {});
    });

    it('timed: shows the label and Resume now, which POSTs resume', async () => {
      const calls = pauseFetch({ pause_state: 'timed', paused_until: '2026-11-06T20:45:00Z' });
      const el = mountCard({ hass: { states: {} } });
      el.setConfig({ type: 'custom:hm-thermostat-card' });
      await flush(el);
      const root = el.shadowRoot!;
      expect(root.querySelector('.paused-until')!.textContent).toContain('Paused until');
      expect(root.querySelector('button[name="pause_2h"]')).toBeNull();
      (root.querySelector('button[name="resume_now"]') as HTMLButtonElement).click();
      await flush(el);
      expect(calls.some((c) => c.url.endsWith('/resume') && c.init?.method === 'POST')).toBe(true);
    });

    it('renders nothing for manual/master or no resolved appliance', async () => {
      pauseFetch({ pause_state: 'manual' });
      const el = mountCard({ hass: { states: {} } });
      el.setConfig({ type: 'custom:hm-thermostat-card' });
      await flush(el);
      expect(el.shadowRoot!.querySelector('.pause-row')).toBeNull();
      document.body.innerHTML = '';
      pauseFetch({ pause_state: 'active' });
      const el2 = mountCard({ hass: { states: {} } });
      el2.setConfig({ type: 'custom:hm-thermostat-card', appliance_id: 'nope' });
      await flush(el2);
      expect(el2.shadowRoot!.querySelector('.pause-row')).toBeNull();
    });
  });
});
