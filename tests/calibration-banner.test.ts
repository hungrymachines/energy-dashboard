import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HungryMachinesPanel } from '../src/panel/hungry-machines-panel.js';
import { HmLoginForm } from '../src/ui/login-form.js';
import { authStore, type AuthState } from '../src/store.js';
import { setApiBase, setTokens } from '../src/api/client.js';
import type { CalibrationStatusResponse } from '../src/api/calibration.js';
import type { Appliance } from '../src/api/appliances.js';

if (!customElements.get('hm-login-form')) {
  customElements.define('hm-login-form', HmLoginForm);
}
if (!customElements.get('hungry-machines-panel')) {
  customElements.define('hungry-machines-panel', HungryMachinesPanel);
}

type PanelEl = HungryMachinesPanel & { updateComplete: Promise<boolean> };

const DISMISS_KEY = 'hm-panel-dismissed-calibrations';

function setAuthed(): void {
  authStore.state = {
    access: 'tok',
    refresh: 'ref',
    user: { user_id: 'u1', email: 'jane@example.com' },
    status: 'authed',
    error: null,
  } as AuthState;
}

const HVAC: Appliance = {
  id: 'app-1',
  name: 'Office AC',
  appliance_type: 'hvac',
} as unknown as Appliance;

function completedStatus(
  runId: number | null,
  completedAt: string | null,
): CalibrationStatusResponse {
  return {
    appliance_id: 'app-1',
    is_complete: true,
    is_in_progress: false,
    can_skip: false,
    history: [],
    latest_run: {
      id: runId,
      status: 'completed',
      schedule_date: '2026-06-20',
      started_at: '2026-06-20T09:00:00Z',
      completed_at: completedAt,
      aborted_reason: null,
      derived_rates: {
        cooling_effect_cool_low: -0.3,
        cooling_effect_cool_high: -1.65,
        coupling_rate: 0.1,
        sample_count: 100,
      },
      phases: [],
    },
  } as unknown as CalibrationStatusResponse;
}

function recentIso(): string {
  // 1 day ago — well inside the 14-day TTL.
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
}

function oldIso(): string {
  // 30 days ago — past the 14-day TTL.
  return new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function installFetchStub(): void {
  // The dashboard kicks off /schedules + /preferences + /rates loads on
  // mount; return empty-but-valid payloads so it settles past the
  // loading skeleton and renders the calibration section.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => jsonResponse({ appliances: [], rates_cents_per_kwh: [] })),
  );
}

async function flush(el: PanelEl): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await el.updateComplete;
    await Promise.resolve();
  }
}

async function mountWithStatus(status: CalibrationStatusResponse): Promise<PanelEl> {
  const el = document.createElement('hungry-machines-panel') as PanelEl;
  document.body.appendChild(el);
  await flush(el);
  (el as unknown as Record<string, unknown>)._appliancesById = { 'app-1': HVAC };
  (el as unknown as Record<string, unknown>)._calibrationByAppliance = { 'app-1': status };
  await el.updateComplete;
  return el;
}

function bannerText(el: PanelEl): string {
  return el.shadowRoot?.querySelector('.banner.calibration.complete')?.textContent ?? '';
}

describe('calibration completed banner — dismiss + TTL', () => {
  beforeEach(() => {
    setApiBase('https://api.example.test');
    localStorage.clear();
    installFetchStub();
    setTokens({ access: 'tok', refresh: 'ref' });
    // hydrate() would otherwise overwrite the authed state we set below.
    vi.spyOn(authStore, 'hydrate').mockImplementation(async () => {});
    setAuthed();
  });

  afterEach(() => {
    document.querySelectorAll('hungry-machines-panel').forEach((n) => n.remove());
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders the completed banner with measured rates', async () => {
    const el = await mountWithStatus(completedStatus(7, recentIso()));
    const text = bannerText(el);
    expect(text).toContain('Office AC calibration done');
    expect(text).toContain('0.6 °F/hr on Low fan');
    expect(text).toContain('3.3 °F/hr on High fan');
    expect(el.shadowRoot?.querySelector('.banner-dismiss')).toBeTruthy();
  });

  it('hides the banner after the dismiss button is clicked and persists the choice', async () => {
    const el = await mountWithStatus(completedStatus(7, recentIso()));
    const btn = el.shadowRoot?.querySelector<HTMLButtonElement>('.banner-dismiss');
    expect(btn).toBeTruthy();
    btn!.click();
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector('.banner.calibration.complete')).toBeNull();
    expect(JSON.parse(localStorage.getItem(DISMISS_KEY) ?? '[]')).toContain(7);
  });

  it('stays dismissed across a remount (hydrates from localStorage)', async () => {
    localStorage.setItem(DISMISS_KEY, JSON.stringify([7]));
    const el = await mountWithStatus(completedStatus(7, recentIso()));
    expect(el.shadowRoot?.querySelector('.banner.calibration.complete')).toBeNull();
  });

  it('auto-hides a banner older than the TTL even when not dismissed', async () => {
    const el = await mountWithStatus(completedStatus(7, oldIso()));
    expect(el.shadowRoot?.querySelector('.banner.calibration.complete')).toBeNull();
  });
});
