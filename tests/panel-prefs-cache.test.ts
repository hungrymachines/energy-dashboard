import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HungryMachinesPanel } from '../src/panel/hungry-machines-panel.js';
import { authStore } from '../src/store.js';
import { clearTokens, setApiBase } from '../src/api/client.js';

if (!customElements.get('hungry-machines-panel')) {
  customElements.define('hungry-machines-panel', HungryMachinesPanel);
}

type PanelEl = HungryMachinesPanel & { updateComplete: Promise<boolean> };

const SCHEDULES = { date: '2026-06-11', appliances: [] };
const RATES = { rates_cents_per_kwh: Array(48).fill(10) };

// User-level fallback (what _loadSchedulesIfNeeded fetches) vs the
// per-appliance row. They differ so we can tell which one seeded the editor.
const USER_PREFS = {
  base_temperature: 72,
  savings_level: 3,
  time_away: '08:00',
  time_home: '17:00',
  optimization_mode: 'auto',
  optimization_enabled: true,
};
const APPLIANCE_PREFS = {
  base_temperature: 66,
  savings_level: 1,
  time_away: '06:30',
  time_home: '19:00',
  optimization_mode: 'cool',
  optimization_enabled: true,
};
const EV_CONSTRAINTS = {
  target_charge_pct: 85,
  min_charge_pct: 45,
  deadline_time: '07:30',
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function flush(el: PanelEl): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await el.updateComplete;
    await Promise.resolve();
  }
}

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | Request) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/api/v1/appliances/hvac-1/preferences')) {
        return jsonResponse(APPLIANCE_PREFS);
      }
      if (url.includes('/api/v1/appliances/ev-1/constraints')) {
        return jsonResponse({ status: 'ok', constraints: EV_CONSTRAINTS });
      }
      if (url.includes('/api/v1/appliances')) return jsonResponse([]);
      if (url.includes('/api/v1/preferences')) return jsonResponse(USER_PREFS);
      if (url.includes('/api/v1/schedules')) return jsonResponse(SCHEDULES);
      if (url.includes('/api/v1/rates')) return jsonResponse(RATES);
      return new Response('{"detail":"nf"}', {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
}

function mountAuthedPanel(): PanelEl {
  authStore.state = {
    access: 'A',
    refresh: 'R',
    status: 'authed',
    user: { user_id: 'u-1' } as never,
    error: null,
  } as never;
  const el = document.createElement('hungry-machines-panel') as PanelEl;
  document.body.appendChild(el);
  (el as unknown as Record<string, unknown>)._view = 'dashboard';
  (el as unknown as Record<string, unknown>)._auth = authStore.state;
  return el;
}

function openEditor(el: PanelEl, id: string, type = 'hvac'): Promise<void> {
  return (
    el as unknown as { _openEditor(id: string, t: string): Promise<void> }
  )._openEditor(id, type);
}

function editorConstraints(el: PanelEl): Record<string, unknown> | undefined {
  return (el as unknown as { _editorConstraints?: Record<string, unknown> })
    ._editorConstraints;
}

describe('preferences cache persistence', () => {
  beforeEach(() => {
    setApiBase('https://api.example.test');
    localStorage.clear();
    clearTokens();
    vi.spyOn(authStore, 'hydrate').mockImplementation(async () => {});
    stubFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    localStorage.clear();
    clearTokens();
  });

  it('persists user + per-appliance prefs to localStorage stamped with user_id', async () => {
    const el = mountAuthedPanel();
    await flush(el);
    await openEditor(el, 'hvac-1');
    await flush(el);

    const userBlob = JSON.parse(
      localStorage.getItem('hm-panel-user-prefs') ?? 'null',
    );
    expect(userBlob.user_id).toBe('u-1');
    expect(userBlob.prefs.base_temperature).toBe(72);

    const applBlob = JSON.parse(
      localStorage.getItem('hm-panel-appliance-prefs') ?? 'null',
    );
    expect(applBlob.user_id).toBe('u-1');
    expect(applBlob.prefs['hvac-1'].base_temperature).toBe(66);
  });

  it('seeds the editor from the persisted per-appliance row on a fresh mount, before the GET lands', async () => {
    // First panel populates the cache, then goes away.
    const first = mountAuthedPanel();
    await flush(first);
    await openEditor(first, 'hvac-1');
    await flush(first);
    first.remove();

    // Fresh remount (same user). Opening the editor must show the cached
    // per-appliance values (66) synchronously — NOT the user-level
    // fallback (72) — which is the "my changes reset" symptom.
    const second = mountAuthedPanel();
    await flush(second);
    void openEditor(second, 'hvac-1');
    // Inspect the seed BEFORE flushing so the network GET cannot have
    // resolved yet — this is purely the localStorage-hydrated cache.
    expect(editorConstraints(second)?.base_temperature).toBe(66);
    expect(editorConstraints(second)?.optimization_mode).toBe('cool');
  });

  it('persists non-HVAC constraints and seeds the editor from cache on a fresh mount', async () => {
    const first = mountAuthedPanel();
    await flush(first);
    await openEditor(first, 'ev-1', 'ev_charger');
    await flush(first);

    // The GET /constraints response is cached to localStorage, stamped
    // with the user_id.
    const blob = JSON.parse(
      localStorage.getItem('hm-panel-appliance-constraints') ?? 'null',
    );
    expect(blob.user_id).toBe('u-1');
    expect(blob.constraints['ev-1'].target_charge_pct).toBe(85);
    first.remove();

    // Fresh remount: opening the EV editor shows the cached constraints
    // synchronously (before the GET resolves) instead of a blank form —
    // the write-only-constraints bug.
    const second = mountAuthedPanel();
    await flush(second);
    void openEditor(second, 'ev-1', 'ev_charger');
    expect(editorConstraints(second)?.target_charge_pct).toBe(85);
    expect(editorConstraints(second)?.deadline_time).toBe('07:30');
  });

  it('does not leak a prior user\'s cache to a different account', async () => {
    const first = mountAuthedPanel();
    await flush(first);
    await openEditor(first, 'hvac-1');
    await flush(first);
    first.remove();

    // Different user signs in on the same browser — the user_id stamp must
    // make the persisted blob invisible to them.
    authStore.state = {
      access: 'A',
      refresh: 'R',
      status: 'authed',
      user: { user_id: 'u-2' } as never,
      error: null,
    } as never;
    const second = document.createElement('hungry-machines-panel') as PanelEl;
    document.body.appendChild(second);
    (second as unknown as Record<string, unknown>)._view = 'dashboard';
    (second as unknown as Record<string, unknown>)._auth = authStore.state;
    await flush(second);

    const cache = (
      second as unknown as { _appliancePrefsById: Record<string, unknown> }
    )._appliancePrefsById;
    expect(cache['hvac-1']).toBeUndefined();
  });
});
