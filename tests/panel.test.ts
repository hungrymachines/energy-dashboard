import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HungryMachinesPanel } from '../src/panel/hungry-machines-panel.js';
import { HmLoginForm } from '../src/ui/login-form.js';
import { HmApplianceForm } from '../src/ui/appliance-form.js';
import type { SchedulesResponse } from '../src/api/schedules.js';
import { authStore, type AuthState } from '../src/store.js';
import { clearTokens, setApiBase, setTokens } from '../src/api/client.js';

if (!customElements.get('hm-login-form')) {
  customElements.define('hm-login-form', HmLoginForm);
}
if (!customElements.get('hm-appliance-form')) {
  customElements.define('hm-appliance-form', HmApplianceForm);
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

function mountPanel(): PanelEl {
  const el = document.createElement('hungry-machines-panel') as PanelEl;
  document.body.appendChild(el);
  return el;
}

function findButtonByText(
  root: ShadowRoot,
  text: string,
): HTMLButtonElement | undefined {
  return Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(
    (b) => b.textContent?.trim() === text,
  );
}

describe('hungry-machines-panel', () => {
  beforeEach(() => {
    setApiBase('https://api.example.test');
    localStorage.clear();
    clearTokens();
    setAuthState({});
    // Prevent hydrate() from clobbering the state we force in each test.
    vi.spyOn(authStore, 'hydrate').mockImplementation(async () => {});
    // Stub fetch so the dashboard's /schedules + /rates calls don't hit the
    // real network (US-FE-07 triggers these on mount when authed).
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('null', { status: 200, headers: { 'Content-Type': 'application/json' } })),
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

  it('renders the login form and no app header when unauthed', async () => {
    setAuthState({ status: 'unauthed' });
    const el = mountPanel();
    await el.updateComplete;

    const root = el.shadowRoot!;
    expect(root.querySelector('hm-login-form')).not.toBeNull();
    expect(root.querySelector('header.app-header')).toBeNull();
    expect(root.querySelector('footer.app-footer')).toBeNull();
  });

  it('renders the authenticated layout with the user email and a Sign out button', async () => {
    setAuthState({
      access: 'ACCESS',
      refresh: 'REFRESH',
      status: 'authed',
      user: SAMPLE_USER,
    });
    const el = mountPanel();
    await el.updateComplete;

    const root = el.shadowRoot!;

    const header = root.querySelector('header.app-header');
    expect(header).not.toBeNull();
    expect(header!.textContent).toContain('Hungry Machines');

    const tabs = root.querySelectorAll<HTMLButtonElement>('nav.tabs button');
    expect(tabs.length).toBe(2);
    expect(tabs[0]!.textContent?.trim()).toBe('Dashboard');
    expect(tabs[1]!.textContent?.trim()).toBe('Settings');

    const footer = root.querySelector('footer.app-footer');
    expect(footer).not.toBeNull();
    expect(footer!.textContent).toContain('jane@example.com');

    const signOutBtn = findButtonByText(root, 'Sign out');
    expect(signOutBtn).toBeDefined();

    // No login form rendered in authed state.
    expect(root.querySelector('hm-login-form')).toBeNull();
  });

  it('clicking Sign out invokes authStore.logout', async () => {
    setAuthState({
      access: 'ACCESS',
      refresh: 'REFRESH',
      status: 'authed',
      user: SAMPLE_USER,
    });
    const el = mountPanel();
    await el.updateComplete;

    const logoutSpy = vi.spyOn(authStore, 'logout').mockImplementation(() => {
      /* prevent side effects */
    });

    const signOutBtn = findButtonByText(el.shadowRoot!, 'Sign out');
    expect(signOutBtn).toBeDefined();
    signOutBtn!.click();

    expect(logoutSpy).toHaveBeenCalledTimes(1);
  });

  it('switches the content section when the Settings tab is clicked', async () => {
    setAuthState({
      access: 'ACCESS',
      refresh: 'REFRESH',
      status: 'authed',
      user: SAMPLE_USER,
    });
    const el = mountPanel();
    await el.updateComplete;

    const root = el.shadowRoot!;
    const content = root.querySelector('section.content')!;
    expect(content.textContent).toContain('Dashboard');

    const settingsTab = Array.from(
      root.querySelectorAll<HTMLButtonElement>('nav.tabs button'),
    ).find((b) => b.textContent?.trim() === 'Settings');
    expect(settingsTab).toBeDefined();
    settingsTab!.click();
    await el.updateComplete;

    const updated = root.querySelector('section.content')!;
    expect(updated.textContent).toContain('Settings');
  });

  it("clicking 'Add appliance' on the empty dashboard opens the appliance form", async () => {
    setAuthState({
      access: 'ACCESS',
      refresh: 'REFRESH',
      status: 'authed',
      user: SAMPLE_USER,
    });
    setTokens({ access: 'ACCESS', refresh: 'REFRESH' });
    // Schedules / rates / appliances / preferences all return empty.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ date: 'today', appliances: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    const el = mountPanel();
    for (let i = 0; i < 5; i++) {
      await el.updateComplete;
      await Promise.resolve();
    }

    const root = el.shadowRoot!;
    const addBtn = findButtonByText(root, 'Add appliance');
    expect(addBtn).toBeDefined();
    addBtn!.click();
    await el.updateComplete;
    await Promise.resolve();

    const form = root.querySelector('hm-appliance-form') as HmApplianceForm | null;
    expect(form).not.toBeNull();
    expect(form!.open).toBe(true);
  });

  it('appliance-created event triggers an immediate schedule recompute', async () => {
    setAuthState({
      access: 'ACCESS',
      refresh: 'REFRESH',
      status: 'authed',
      user: SAMPLE_USER,
    });
    setTokens({ access: 'ACCESS', refresh: 'REFRESH' });

    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        calls.push(url);
        return new Response(JSON.stringify({ date: 'today', appliances: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );

    const el = mountPanel();
    for (let i = 0; i < 5; i++) {
      await el.updateComplete;
      await Promise.resolve();
    }

    const initialScheduleCalls = calls.filter((u) => u.endsWith('/api/v1/schedules')).length;
    expect(initialScheduleCalls).toBeGreaterThanOrEqual(1);

    const form = el.shadowRoot!.querySelector('hm-appliance-form') as HmApplianceForm;
    expect(form).not.toBeNull();
    form.dispatchEvent(
      new CustomEvent('appliance-created', {
        detail: {
          appliance: {
            id: 'a-1',
            user_id: 'user-123',
            appliance_type: 'hvac',
            name: 'My HVAC',
            config: {},
            is_active: true,
            created_at: new Date().toISOString(),
          },
        },
        bubbles: true,
        composed: true,
      }),
    );
    for (let i = 0; i < 5; i++) {
      await el.updateComplete;
      await Promise.resolve();
    }

    // Post-v2.4: instead of re-fetching /schedules, the panel POSTs to
    // /schedule/recompute which both runs an optimization and returns the
    // freshly written schedules in one round-trip.
    const recomputeCalls = calls.filter((u) =>
      u.endsWith('/api/v1/schedule/recompute'),
    ).length;
    expect(recomputeCalls).toBeGreaterThanOrEqual(1);
  });

  it('constraints-saved event POSTs to /schedule/recompute and replaces _schedules with the response', async () => {
    setAuthState({
      access: 'ACCESS',
      refresh: 'REFRESH',
      status: 'authed',
      user: SAMPLE_USER,
    });
    setTokens({ access: 'ACCESS', refresh: 'REFRESH' });

    const calls: string[] = [];
    const recomputed = {
      date: '2026-05-08',
      appliances: [
        {
          appliance_id: 'a-1',
          appliance_type: 'hvac',
          name: 'After-recompute',
          schedule: {},
          savings_pct: 42.0,
          source: 'optimization',
        },
      ],
    };

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        calls.push(url);
        if (url.endsWith('/api/v1/schedule/recompute')) {
          return new Response(JSON.stringify(recomputed), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ date: 'today', appliances: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );

    const el = mountPanel();
    for (let i = 0; i < 5; i++) {
      await el.updateComplete;
      await Promise.resolve();
    }

    // Fire the save event from the constraint editor.
    const editor = el.shadowRoot!.querySelector('hm-constraint-editor');
    expect(editor).not.toBeNull();
    editor!.dispatchEvent(
      new CustomEvent('constraints-saved', {
        detail: { applianceId: 'a-1', payload: { base_temperature: 71 } },
        bubbles: true,
        composed: true,
      }),
    );
    for (let i = 0; i < 5; i++) {
      await el.updateComplete;
      await Promise.resolve();
    }

    // The panel hit the recompute endpoint and replaced its cached
    // schedules with the response — that's how the dashboard chart
    // updates inline without a page reload.
    expect(
      calls.filter((u) => u.endsWith('/api/v1/schedule/recompute')).length,
    ).toBeGreaterThanOrEqual(1);
    const finalSchedules = (el as unknown as {
      _schedules: SchedulesResponse | null;
    })._schedules;
    expect(finalSchedules).not.toBeNull();
    expect(finalSchedules!.appliances[0]?.savings_pct).toBe(42.0);
    expect((el as unknown as { _recomputing: boolean })._recomputing).toBe(false);
  });

  // -----------------------------------------------------------------------
  // US-MHVAC-015 — the dashboard renders one card per HVAC appliance,
  // each labeled with its name AND its bound climate entity so a
  // multi-HVAC user can see which card controls which unit.
  // -----------------------------------------------------------------------
  it('renders two HVAC cards each labeled with its distinct bound climate entity', async () => {
    setAuthState({
      access: 'ACCESS',
      refresh: 'REFRESH',
      status: 'authed',
      user: SAMPLE_USER,
    });
    setTokens({ access: 'ACCESS', refresh: 'REFRESH' });

    const schedules = {
      date: 'today',
      appliances: [
        {
          appliance_id: 'app-1',
          appliance_type: 'hvac',
          name: 'Living Room',
          schedule: {},
          savings_pct: 25,
          source: 'optimization',
        },
        {
          appliance_id: 'app-2',
          appliance_type: 'hvac',
          name: 'Bedroom',
          schedule: {},
          savings_pct: 18,
          source: 'optimization',
        },
      ],
    };
    const appliances = [
      {
        id: 'app-1',
        user_id: 'user-123',
        appliance_type: 'hvac',
        name: 'Living Room',
        config: { entity_id: 'climate.living_room', hvac_type: 'central_ac', home_size_sqft: 1200 },
        is_active: true,
        created_at: new Date().toISOString(),
      },
      {
        id: 'app-2',
        user_id: 'user-123',
        appliance_type: 'hvac',
        name: 'Bedroom',
        config: { entity_id: 'climate.bedroom', hvac_type: 'central_ac', home_size_sqft: 900 },
        is_active: true,
        created_at: new Date().toISOString(),
      },
    ];

    const rates = {
      pricing_source: 'zone',
      pricing_location: 1,
      pricing_zone_id: 1,
      available_pricing_zones: [],
      available_pjm_nodes: [],
      pjm_pnode_id: null,
      pricing_adder_cents_per_kwh: null,
      rates_cents_per_kwh: [],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        if (url.endsWith('/api/v1/schedules')) {
          return new Response(JSON.stringify(schedules), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.endsWith('/api/v1/appliances')) {
          return new Response(JSON.stringify(appliances), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.endsWith('/api/v1/rates')) {
          return new Response(JSON.stringify(rates), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.includes('/api/v1/calibration/status')) {
          return new Response(
            JSON.stringify({ is_in_progress: false, latest_run: null }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response('null', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );

    const el = mountPanel();
    for (let i = 0; i < 10; i++) {
      await el.updateComplete;
      await Promise.resolve();
    }

    const root = el.shadowRoot!;
    const cards = Array.from(
      root.querySelectorAll<HTMLDivElement>('div.card[data-appliance-type="hvac"]'),
    );
    expect(cards.length).toBe(2);

    const labels = cards.map((c) => {
      const name = c.querySelector('.name')?.textContent?.trim() ?? '';
      const binding = c.querySelector('.entity-binding')?.textContent?.trim() ?? '';
      return { name, binding };
    });
    expect(labels).toEqual([
      { name: 'Living Room', binding: 'climate.living_room' },
      { name: 'Bedroom', binding: 'climate.bedroom' },
    ]);

    // The appliance form should receive the existing appliances so the
    // uniqueness guard can fire (US-MHVAC-015 client-side guard).
    const form = root.querySelector('hm-appliance-form') as
      | (HmApplianceForm & { existingAppliances: unknown[] })
      | null;
    expect(form).not.toBeNull();
    expect(Array.isArray(form!.existingAppliances)).toBe(true);
    expect(form!.existingAppliances.length).toBe(2);
  });

  // -----------------------------------------------------------------------
  // US-MHVAC-018 — the dashboard renders one schedule chart + savings
  // figure per HVAC appliance, each sourced from that appliance's own
  // /schedules entry. Sibling units must never share a chart or savings
  // number; this regression-locks the per-appliance projection.
  // -----------------------------------------------------------------------
  it('US-MHVAC-018: per-HVAC charts and savings figures are independent', async () => {
    setAuthState({
      access: 'ACCESS',
      refresh: 'REFRESH',
      status: 'authed',
      user: SAMPLE_USER,
    });
    setTokens({ access: 'ACCESS', refresh: 'REFRESH' });

    const livingHighs = Array<number>(48).fill(76);
    const bedroomHighs = Array<number>(48).fill(70);
    const livingLows = Array<number>(48).fill(72);
    const bedroomLows = Array<number>(48).fill(66);

    const schedules = {
      date: 'today',
      appliances: [
        {
          appliance_id: 'app-living',
          appliance_type: 'hvac',
          name: 'Living Room',
          schedule: {
            intervals: Array.from({ length: 48 }, (_, i) => i),
            high_temps: livingHighs,
            low_temps: livingLows,
            setpoint_temps: Array<number>(48).fill(74),
            mode: 'cool',
          },
          savings_pct: 12,
          source: 'optimization',
        },
        {
          appliance_id: 'app-bedroom',
          appliance_type: 'hvac',
          name: 'Bedroom',
          schedule: {
            intervals: Array.from({ length: 48 }, (_, i) => i),
            high_temps: bedroomHighs,
            low_temps: bedroomLows,
            setpoint_temps: Array<number>(48).fill(68),
            mode: 'cool',
          },
          savings_pct: 34,
          source: 'optimization',
        },
      ],
    };
    const appliances = [
      {
        id: 'app-living',
        user_id: 'user-123',
        appliance_type: 'hvac',
        name: 'Living Room',
        config: { entity_id: 'climate.living_room', hvac_type: 'central_ac', home_size_sqft: 1200 },
        is_active: true,
        created_at: new Date().toISOString(),
      },
      {
        id: 'app-bedroom',
        user_id: 'user-123',
        appliance_type: 'hvac',
        name: 'Bedroom',
        config: { entity_id: 'climate.bedroom', hvac_type: 'central_ac', home_size_sqft: 900 },
        is_active: true,
        created_at: new Date().toISOString(),
      },
    ];

    const rates = {
      pricing_source: 'zone',
      pricing_location: 1,
      pricing_zone_id: 1,
      available_pricing_zones: [],
      available_pjm_nodes: [],
      pjm_pnode_id: null,
      pricing_adder_cents_per_kwh: null,
      rates_cents_per_kwh: Array<number>(48).fill(10),
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        if (url.endsWith('/api/v1/schedules')) {
          return new Response(JSON.stringify(schedules), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.endsWith('/api/v1/appliances')) {
          return new Response(JSON.stringify(appliances), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.endsWith('/api/v1/rates')) {
          return new Response(JSON.stringify(rates), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.includes('/api/v1/calibration/status')) {
          return new Response(
            JSON.stringify({ is_in_progress: false, latest_run: null }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response('null', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );

    const el = mountPanel();
    for (let i = 0; i < 10; i++) {
      await el.updateComplete;
      await Promise.resolve();
    }

    const root = el.shadowRoot!;
    const cards = Array.from(
      root.querySelectorAll<HTMLDivElement>('div.card[data-appliance-type="hvac"]'),
    );
    expect(cards.length).toBe(2);

    // Each card carries its own savings figure (12% vs 34%).
    const savingsTexts = cards.map(
      (c) => c.querySelector('.savings')?.textContent?.trim() ?? '',
    );
    expect(savingsTexts[0]).toContain('12%');
    expect(savingsTexts[1]).toContain('34%');

    // Each card has its own <hm-optimization-chart>, fed with the
    // appliance's own high_temps array (76 vs 70).
    const charts = cards.map(
      (c) =>
        c.querySelector('hm-optimization-chart') as
          | (HTMLElement & { highLimits?: number[] })
          | null,
    );
    expect(charts.length).toBe(2);
    expect(charts[0]).not.toBeNull();
    expect(charts[1]).not.toBeNull();
    expect(Array.isArray(charts[0]!.highLimits)).toBe(true);
    expect(charts[0]!.highLimits![0]).toBe(76);
    expect(charts[1]!.highLimits![0]).toBe(70);
  });

  it('shows a loading spinner when the auth store reports loading', async () => {
    setAuthState({ status: 'loading' });
    const el = mountPanel();
    await el.updateComplete;

    const root = el.shadowRoot!;
    expect(root.querySelector('.spinner')).not.toBeNull();
    expect(root.querySelector('hm-login-form')).toBeNull();
    expect(root.querySelector('header.app-header')).toBeNull();
  });
});
