import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HungryMachinesPanel } from '../src/panel/hungry-machines-panel.js';
import { HmLoginForm } from '../src/ui/login-form.js';
import { HmScheduleChart } from '../src/ui/schedule-chart.js';
import { HmOptimizationChart } from '../src/ui/optimization-chart.js';
import { authStore, type AuthState } from '../src/store.js';
import { clearTokens, setApiBase } from '../src/api/client.js';

// Validation suite: a user with TWO HVAC appliances must see a distinct
// dashboard card per machine — its own name, bound entity, savings, the
// optimizer's per-appliance target line, and its own comfort band.

if (!customElements.get('hm-login-form')) {
  customElements.define('hm-login-form', HmLoginForm);
}
if (!customElements.get('hm-schedule-chart')) {
  customElements.define('hm-schedule-chart', HmScheduleChart);
}
if (!customElements.get('hm-optimization-chart')) {
  customElements.define('hm-optimization-chart', HmOptimizationChart);
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

const RATES = Array.from({ length: 48 }, (_, i) => 10 + (i % 3) * 5);

// Two HVACs with deliberately different bands, targets, and savings so
// any cross-wiring between the cards is observable.
const HVAC_A = {
  appliance_id: 'hvac-a',
  appliance_type: 'hvac' as const,
  name: 'Upstairs Zone',
  schedule: {
    intervals: Array.from({ length: 48 }, (_, i) => i),
    high_temps: Array<number>(48).fill(74),
    low_temps: Array<number>(48).fill(70),
    setpoint_temps: Array<number>(48).fill(73),
  },
  savings_pct: 18.0,
  source: 'optimization',
};

const HVAC_B = {
  appliance_id: 'hvac-b',
  appliance_type: 'hvac' as const,
  name: 'Downstairs Zone',
  schedule: {
    intervals: Array.from({ length: 48 }, (_, i) => i),
    high_temps: Array<number>(48).fill(78),
    low_temps: Array<number>(48).fill(66),
    setpoint_temps: Array<number>(48).fill(76),
  },
  savings_pct: 9.0,
  source: 'optimization',
};

const APPLIANCES_LIST = [
  {
    id: 'hvac-a',
    user_id: 'user-123',
    appliance_type: 'hvac',
    name: 'Upstairs Zone',
    config: { entity_id: 'climate.upstairs', hvac_type: 'central' },
    is_active: true,
    created_at: '2026-06-01T00:00:00Z',
  },
  {
    id: 'hvac-b',
    user_id: 'user-123',
    appliance_type: 'hvac',
    name: 'Downstairs Zone',
    config: { entity_id: 'climate.downstairs', hvac_type: 'central' },
    is_active: true,
    created_at: '2026-06-02T00:00:00Z',
  },
];

const RATES_RESPONSE = {
  pricing_location: 3,
  intervals: Array.from({ length: 48 }, (_, i) => i),
  rates_cents_per_kwh: RATES,
  unit: 'cents/kWh',
};

const PREFS_NO_BANDS = {
  base_temperature: 72,
  savings_level: 2,
  time_away: '09:00',
  time_home: '17:00',
  optimization_mode: 'cool',
  hourly_high_temps_f: null,
  hourly_low_temps_f: null,
};

// User-level prefs WITH hourly bands — a flat 80/60 band that matches
// NEITHER appliance's own band, so if it leaks onto a card we see it.
const PREFS_WITH_BANDS = {
  ...PREFS_NO_BANDS,
  hourly_high_temps_f: Array<number>(24).fill(80),
  hourly_low_temps_f: Array<number>(24).fill(60),
};

// Per-appliance preferences rows (appliance_preferences, migration 027).
// The no-bands variants make the cards fall back to the band baked into
// each schedule row.
const APPLIANCE_PREFS_NO_BANDS = {
  base_temperature: 72,
  savings_level: 2,
  time_away: '09:00',
  time_home: '17:00',
  optimization_mode: 'cool',
  hourly_high_temps_f: null,
  hourly_low_temps_f: null,
  optimize_hvac_fan: false,
  optimize_hvac_mode: false,
  optimization_enabled: true,
};

// Freshly edited per-appliance bands — distinct from each schedule row's
// baked band AND from the user-level 80/60, so we can tell which source
// each card rendered.
const HVAC_A_PREFS_WITH_BANDS = {
  ...APPLIANCE_PREFS_NO_BANDS,
  hourly_high_temps_f: Array<number>(24).fill(75),
  hourly_low_temps_f: Array<number>(24).fill(69),
};

const HVAC_B_PREFS_WITH_BANDS = {
  ...APPLIANCE_PREFS_NO_BANDS,
  hourly_high_temps_f: Array<number>(24).fill(79),
  hourly_low_temps_f: Array<number>(24).fill(65),
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

function installFetchStub(routes: Record<string, unknown>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      for (const [path, body] of Object.entries(routes)) {
        if (url.includes(path)) return jsonResponse(body);
      }
      return new Response('{"detail":"not found"}', {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
}

async function flush(el: PanelEl): Promise<void> {
  // Two rounds of fetches happen on mount: schedules/rates/appliances,
  // then the per-HVAC preference + calibration fetches kicked off once
  // the appliance list lands. A macrotask tick per round lets each
  // fetch chain fully settle before Lit re-renders.
  for (let i = 0; i < 5; i++) {
    await el.updateComplete;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await el.updateComplete;
}

/** Return the real (non-example) HVAC cards keyed by their displayed name. */
function hvacCardsByName(el: PanelEl): Record<string, HTMLElement> {
  const root = el.shadowRoot!;
  const cards = Array.from(
    root.querySelectorAll<HTMLElement>('.cards > .card[data-appliance-type="hvac"]'),
  );
  const byName: Record<string, HTMLElement> = {};
  for (const card of cards) {
    const name = card.querySelector('.name')?.textContent?.trim() ?? '';
    byName[name] = card;
  }
  return byName;
}

function chartOf(card: HTMLElement): HmOptimizationChart {
  const chart = card.querySelector<HmOptimizationChart>('hm-optimization-chart');
  expect(chart).not.toBeNull();
  return chart!;
}

describe('two-HVAC dashboard display (multi-HVAC validation)', () => {
  beforeEach(() => {
    setApiBase('https://api.example.test');
    localStorage.clear();
    clearTokens();
    setAuthState({});
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

  async function mountWithPrefs(
    userPrefs: unknown,
    appliancePrefsA: unknown = APPLIANCE_PREFS_NO_BANDS,
    appliancePrefsB: unknown = APPLIANCE_PREFS_NO_BANDS,
  ): Promise<PanelEl> {
    installFetchStub({
      '/api/v1/schedules': {
        date: '2026-07-01',
        appliances: [HVAC_A, HVAC_B],
      },
      '/api/v1/rates': RATES_RESPONSE,
      // The stub matches by substring in insertion order, so the
      // per-appliance preference routes must precede '/api/v1/appliances'.
      '/api/v1/appliances/hvac-a/preferences': appliancePrefsA,
      '/api/v1/appliances/hvac-b/preferences': appliancePrefsB,
      '/api/v1/appliances': APPLIANCES_LIST,
      '/api/v1/preferences': userPrefs,
    });
    setAuthState({
      access: 'ACCESS',
      refresh: 'REFRESH',
      status: 'authed',
      user: SAMPLE_USER,
    });
    const el = mountPanel();
    el._view = 'dashboard';
    await flush(el);
    return el;
  }

  it('renders one card per HVAC with its own name, entity, and savings', async () => {
    const el = await mountWithPrefs(PREFS_NO_BANDS);
    const cards = hvacCardsByName(el);

    expect(Object.keys(cards).sort()).toEqual(['Downstairs Zone', 'Upstairs Zone']);

    const up = cards['Upstairs Zone'];
    const down = cards['Downstairs Zone'];

    expect(up.querySelector('.entity-binding')?.textContent).toContain('climate.upstairs');
    expect(down.querySelector('.entity-binding')?.textContent).toContain('climate.downstairs');

    expect(up.textContent).toMatch(/18%\s+savings today/);
    expect(down.textContent).toMatch(/9%\s+savings today/);
  });

  it('each chart carries its own optimizer target line (setpoint_temps)', async () => {
    const el = await mountWithPrefs(PREFS_NO_BANDS);
    const cards = hvacCardsByName(el);

    expect(chartOf(cards['Upstairs Zone']).targetValues).toEqual(Array<number>(48).fill(73));
    expect(chartOf(cards['Downstairs Zone']).targetValues).toEqual(Array<number>(48).fill(76));
  });

  it('each chart carries its own comfort band when user prefs have no hourly bands', async () => {
    const el = await mountWithPrefs(PREFS_NO_BANDS);
    const cards = hvacCardsByName(el);

    const upChart = chartOf(cards['Upstairs Zone']);
    expect(upChart.highLimits).toEqual(Array<number>(48).fill(74));
    expect(upChart.lowLimits).toEqual(Array<number>(48).fill(70));

    const downChart = chartOf(cards['Downstairs Zone']);
    expect(downChart.highLimits).toEqual(Array<number>(48).fill(78));
    expect(downChart.lowLimits).toEqual(Array<number>(48).fill(66));
  });

  it('user-level hourly bands must NOT overwrite both machines\' distinct bands', async () => {
    // Each appliance's schedule row carries the band the optimizer
    // actually honored for THAT machine (74/70 vs 78/66). The account
    // row's 80/60 hourly bands are per-HVAC *seed defaults* since
    // migration 027/029 — the dashboard must not paint them over both
    // cards, or two machines with different bands look identical.
    const el = await mountWithPrefs(PREFS_WITH_BANDS);
    const cards = hvacCardsByName(el);

    const upChart = chartOf(cards['Upstairs Zone']);
    const downChart = chartOf(cards['Downstairs Zone']);

    expect(upChart.highLimits).toEqual(Array<number>(48).fill(74));
    expect(upChart.lowLimits).toEqual(Array<number>(48).fill(70));
    expect(downChart.highLimits).toEqual(Array<number>(48).fill(78));
    expect(downChart.lowLimits).toEqual(Array<number>(48).fill(66));
  });

  it('recompute results with a failed appliance surface a toast naming it', async () => {
    // The recompute HTTP call succeeds even when one appliance's
    // optimization failed server-side — the panel must read the new
    // per-appliance `results` array and tell the user which machine
    // kept its stale schedule instead of silently showing old data.
    const el = await mountWithPrefs(PREFS_NO_BANDS);

    const recomputed = {
      date: '2026-07-02',
      appliances: [HVAC_A, HVAC_B],
      results: [
        {
          appliance_id: 'hvac-a',
          appliance_type: 'hvac',
          name: 'Upstairs Zone',
          status: 'ok',
        },
        {
          appliance_id: 'hvac-b',
          appliance_type: 'hvac',
          name: 'Downstairs Zone',
          status: 'failed',
          detail: 'weather fetch failed',
        },
      ],
    };
    installFetchStub({
      '/api/v1/schedule/recompute': recomputed,
      '/api/v1/schedules': { date: '2026-07-02', appliances: [HVAC_A, HVAC_B] },
    });

    await (el as unknown as { _recomputeNow(): Promise<void> })._recomputeNow();
    await flush(el);

    // `_recomputeError` is the reactive state that drives the toast
    // (`_renderRecomputeToast`). We assert the state rather than the
    // rendered `.recompute-error` node because happy-dom mangles the
    // trailing child-part comment markers of the authed template (the
    // delete-confirm / toast / overlay expressions after
    // <hm-appliance-form> never commit under happy-dom; browsers parse
    // them fine).
    const error = (el as unknown as { _recomputeError: string | null })._recomputeError;
    expect(error).not.toBeNull();
    expect(error).toContain('Downstairs Zone');
    expect(error).toContain('could not be re-optimized');
    expect(error).not.toContain('Upstairs Zone');
  });

  it('recompute results with a calibration preemption explain the pending run', async () => {
    const el = await mountWithPrefs(PREFS_NO_BANDS);

    installFetchStub({
      '/api/v1/schedule/recompute': {
        date: '2026-07-02',
        appliances: [HVAC_A, HVAC_B],
        results: [
          {
            appliance_id: 'hvac-a',
            appliance_type: 'hvac',
            name: 'Upstairs Zone',
            status: 'ok',
          },
          {
            appliance_id: 'hvac-b',
            appliance_type: 'hvac',
            name: 'Downstairs Zone',
            status: 'calibration',
          },
        ],
      },
    });

    await (el as unknown as { _recomputeNow(): Promise<void> })._recomputeNow();
    await flush(el);

    const error = (el as unknown as { _recomputeError: string | null })._recomputeError;
    expect(error).toContain('Downstairs Zone');
    expect(error).toContain('calibration');
  });

  it('recompute results all-ok leaves no error toast', async () => {
    const el = await mountWithPrefs(PREFS_NO_BANDS);

    installFetchStub({
      '/api/v1/schedule/recompute': {
        date: '2026-07-02',
        appliances: [HVAC_A, HVAC_B],
        results: [
          { appliance_id: 'hvac-a', appliance_type: 'hvac', name: 'Upstairs Zone', status: 'ok' },
          { appliance_id: 'hvac-b', appliance_type: 'hvac', name: 'Downstairs Zone', status: 'ok' },
        ],
      },
    });

    await (el as unknown as { _recomputeNow(): Promise<void> })._recomputeNow();
    await flush(el);

    expect(
      (el as unknown as { _recomputeError: string | null })._recomputeError,
    ).toBeNull();
  });

  it('each machine\'s own saved hourly bands win over its baked schedule row', async () => {
    // Fresh per-appliance band edits (appliance_preferences) should show
    // on that machine's chart immediately — without waiting for tonight's
    // optimization to bake them into a new schedule row — and each card
    // must show ITS OWN row, not the other zone's and not the account
    // row's 80/60.
    const el = await mountWithPrefs(
      PREFS_WITH_BANDS,
      HVAC_A_PREFS_WITH_BANDS,
      HVAC_B_PREFS_WITH_BANDS,
    );
    const cards = hvacCardsByName(el);

    const upChart = chartOf(cards['Upstairs Zone']);
    const downChart = chartOf(cards['Downstairs Zone']);

    expect(upChart.highLimits).toEqual(Array<number>(48).fill(75));
    expect(upChart.lowLimits).toEqual(Array<number>(48).fill(69));
    expect(downChart.highLimits).toEqual(Array<number>(48).fill(79));
    expect(downChart.lowLimits).toEqual(Array<number>(48).fill(65));
  });
});
