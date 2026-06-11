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

describe('optimization pause toggle', () => {
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

  it('renders ON by default and PUTs optimization_enabled=false on click', async () => {
    const putBodies: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.url;
      const method = init?.method ?? (typeof input === 'string' ? 'GET' : input.method) ?? 'GET';
      if (url.includes('/api/v1/preferences') && method === 'PUT') {
        putBodies.push(JSON.parse(String(init?.body)));
        return jsonResponse({
          base_temperature: 72, savings_level: 1, time_away: '08:00',
          time_home: '17:00', optimization_mode: 'cool',
          optimization_enabled: false,
        });
      }
      if (url.includes('/api/v1/preferences')) {
        return jsonResponse({
          base_temperature: 72, savings_level: 1, time_away: '08:00',
          time_home: '17:00', optimization_mode: 'cool',
          optimization_enabled: true,
        });
      }
      if (url.includes('/api/v1/schedules')) return jsonResponse(SCHEDULES);
      if (url.includes('/api/v1/rates')) return jsonResponse(RATES);
      return new Response('{"detail":"nf"}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    }));

    const el = mountAuthedPanel();
    await flush(el);
    const root = el.shadowRoot!;

    const toggle = root.querySelector('.opt-toggle') as HTMLButtonElement;
    expect(toggle).toBeTruthy();
    expect(toggle.textContent).toContain('Optimization on');
    expect(root.querySelector('.paused-banner')).toBeNull();

    toggle.click();
    await flush(el);

    expect(putBodies).toEqual([{ optimization_enabled: false }]);
    const after = root.querySelector('.opt-toggle') as HTMLButtonElement;
    expect(after.textContent).toContain('Optimization paused');
    expect(root.querySelector('.paused-banner')).toBeTruthy();
  });

  it('shows paused state when preferences load with optimization_enabled=false', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | Request) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/api/v1/preferences')) {
        return jsonResponse({
          base_temperature: 72, savings_level: 1, time_away: '08:00',
          time_home: '17:00', optimization_mode: 'cool',
          optimization_enabled: false,
        });
      }
      if (url.includes('/api/v1/schedules')) return jsonResponse(SCHEDULES);
      if (url.includes('/api/v1/rates')) return jsonResponse(RATES);
      return new Response('{"detail":"nf"}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    }));

    const el = mountAuthedPanel();
    await flush(el);
    const root = el.shadowRoot!;
    expect((root.querySelector('.opt-toggle') as HTMLElement).textContent)
      .toContain('Optimization paused');
    expect(root.querySelector('.paused-banner')).toBeTruthy();
  });
});
