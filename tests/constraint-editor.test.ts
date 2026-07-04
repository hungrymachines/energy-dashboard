import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HmConstraintEditor } from '../src/ui/constraint-editor.js';
import { clearTokens, setApiBase, setTokens } from '../src/api/client.js';

if (!customElements.get('hm-constraint-editor')) {
  customElements.define('hm-constraint-editor', HmConstraintEditor);
}

type EditorEl = HmConstraintEditor & { updateComplete: Promise<boolean> };

function mountEditor(init: Partial<HmConstraintEditor>): EditorEl {
  const el = document.createElement('hm-constraint-editor') as EditorEl;
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

type FetchCall = [string, RequestInit | undefined];

function captureFetch(response: Response): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const spy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    calls.push([url, init]);
    return response.clone();
  });
  vi.stubGlobal('fetch', spy);
  return { calls };
}

async function flush(el: EditorEl): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await el.updateComplete;
    await Promise.resolve();
  }
}

function setInputValue(
  root: ShadowRoot,
  name: string,
  value: string,
): void {
  const el = root.querySelector<HTMLInputElement | HTMLSelectElement>(
    `[name="${name}"]`,
  );
  if (!el) throw new Error(`input[name="${name}"] not found`);
  el.value = value;
  const evName = el.tagName === 'SELECT' ? 'change' : 'input';
  el.dispatchEvent(new Event(evName, { bubbles: true }));
}

function clickSave(root: ShadowRoot): void {
  const save = Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(
    (b) => b.classList.contains('save'),
  );
  if (!save) throw new Error('save button not found');
  save.click();
}

describe('hm-constraint-editor', () => {
  beforeEach(() => {
    setApiBase('https://api.example.test');
    setTokens({ access: 'ACCESS', refresh: 'REFRESH' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    clearTokens();
  });

  it('submits ev_charger form to POST /api/v1/appliances/<id>/constraints', async () => {
    const { calls } = captureFetch(
      jsonResponse({ status: 'ok', constraints: {} }),
    );

    const el = mountEditor({
      applianceId: 'ev-42',
      applianceType: 'ev_charger',
      currentConstraints: {},
      open: true,
    });
    await flush(el);

    const root = el.shadowRoot!;
    setInputValue(root, 'target_charge_pct', '80');
    setInputValue(root, 'min_charge_pct', '30');
    setInputValue(root, 'current_charge_pct', '40');
    setInputValue(root, 'deadline_time', '07:30');
    await flush(el);

    // Listen for the bubbling custom event before clicking Save.
    const saved = new Promise<CustomEvent>((resolve) => {
      el.addEventListener(
        'constraints-saved',
        (e) => resolve(e as CustomEvent),
        { once: true },
      );
    });

    clickSave(root);
    await flush(el);
    const event = await saved;

    expect(calls.length).toBe(1);
    const [url, init] = calls[0]!;
    expect(url).toContain('/api/v1/appliances/ev-42/constraints');
    expect(init?.method).toBe('POST');
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({
      target_charge_pct: 80,
      min_charge_pct: 30,
      current_charge_pct: 40,
      deadline_time: '07:30',
    });
    expect(event.detail).toEqual({
      applianceId: 'ev-42',
      payload: body,
    });
    expect(el.open).toBe(false);
  });

  it('submits hvac form to PUT /api/v1/appliances/{id}/preferences (US-MHVAC-017)', async () => {
    const { calls } = captureFetch(
      jsonResponse({
        base_temperature: 72,
        savings_level: 2,
        time_away: '08:00',
        time_home: '18:00',
        optimization_mode: 'cool',
      }),
    );

    const el = mountEditor({
      applianceId: 'hvac-1',
      applianceType: 'hvac',
      currentConstraints: {
        base_temperature: 72,
        savings_level: 3,
        optimization_mode: 'auto',
      },
      open: true,
    });
    await flush(el);

    const root = el.shadowRoot!;
    setInputValue(root, 'savings_level', '2');
    setInputValue(root, 'optimization_mode', 'cool');
    await flush(el);

    clickSave(root);
    await flush(el);

    expect(calls.length).toBe(1);
    const [url, init] = calls[0]!;
    expect(url).toContain('/api/v1/appliances/hvac-1/preferences');
    expect(url).not.toContain('/api/v1/preferences');
    expect(init?.method).toBe('PUT');
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({
      base_temperature: 72,
      savings_level: 2,
      optimization_mode: 'cool',
      // Phase C/D opt-ins default off, so the payload always carries
      // explicit booleans (not omitted) — that lets PUT /preferences
      // disambiguate "not provided" from "user turned this off".
      optimize_hvac_fan: false,
      optimize_hvac_mode: false,
      // Per-appliance pause switch defaults ON for new/legacy editors
      // (US-MHVAC-017) so the editor doesn't accidentally pause a
      // unit on first open.
      optimization_enabled: true,
      hourly_low_temps_f: null,
      hourly_high_temps_f: null,
    });
  });

  it('seeds all five hvac fields from currentConstraints (US-FE-HVAC-EDITOR-PREFS-01 a)', async () => {
    captureFetch(jsonResponse({}));
    const el = mountEditor({
      applianceId: 'hvac-1',
      applianceType: 'hvac',
      currentConstraints: {
        base_temperature: 70,
        savings_level: 2,
        optimization_mode: 'cool',
        time_away: '07:30',
        time_home: '18:00',
      },
      open: true,
    });
    await flush(el);

    const root = el.shadowRoot!;
    const baseInput = root.querySelector<HTMLInputElement>('input[name="base_temperature"]')!;
    expect(baseInput.value).toBe('70');
    const savingsInput = root.querySelector<HTMLInputElement>('input[name="savings_level"]')!;
    expect(savingsInput.value).toBe('2');
    const modeSelect = root.querySelector<HTMLSelectElement>('select[name="optimization_mode"]')!;
    expect(modeSelect.value).toBe('cool');
    const awayInput = root.querySelector<HTMLInputElement>('input[name="time_away"]')!;
    expect(awayInput.value).toBe('07:30');
    const homeInput = root.querySelector<HTMLInputElement>('input[name="time_home"]')!;
    expect(homeInput.value).toBe('18:00');
  });

  it('re-seeds when currentConstraints is reassigned while open (per-appliance GET lands after open)', async () => {
    captureFetch(jsonResponse({}));
    // Open seeded with the user-level fallback the panel uses before its
    // async per-appliance preferences GET resolves.
    const el = mountEditor({
      applianceId: 'hvac-1',
      applianceType: 'hvac',
      currentConstraints: {
        base_temperature: 72,
        savings_level: 3,
        optimization_mode: 'auto',
      },
      open: true,
    });
    await flush(el);

    const root = el.shadowRoot!;
    expect(root.querySelector<HTMLInputElement>('input[name="base_temperature"]')!.value).toBe('72');

    // Panel reassigns currentConstraints to the per-appliance row once the
    // GET lands — same applianceId/type/open. The form must re-seed instead
    // of clinging to the stale fallback (the "shows old data until I cancel
    // and reopen" bug).
    el.currentConstraints = {
      base_temperature: 68,
      savings_level: 1,
      optimization_mode: 'cool',
    };
    await flush(el);

    expect(root.querySelector<HTMLInputElement>('input[name="base_temperature"]')!.value).toBe('68');
    expect(root.querySelector<HTMLInputElement>('input[name="savings_level"]')!.value).toBe('1');
    expect(root.querySelector<HTMLSelectElement>('select[name="optimization_mode"]')!.value).toBe('cool');
  });

  it('submits hvac with time_away set, time_home omitted when empty (US-FE-HVAC-EDITOR-PREFS-01 b)', async () => {
    const { calls } = captureFetch(
      jsonResponse({
        base_temperature: 72,
        savings_level: 2,
        optimization_mode: 'cool',
        time_away: '06:30',
        time_home: '',
      }),
    );

    const el = mountEditor({
      applianceId: 'hvac-1',
      applianceType: 'hvac',
      currentConstraints: {
        base_temperature: 72,
        savings_level: 2,
        optimization_mode: 'cool',
      },
      open: true,
    });
    await flush(el);

    const root = el.shadowRoot!;
    setInputValue(root, 'time_away', '06:30');
    await flush(el);

    clickSave(root);
    await flush(el);

    expect(calls.length).toBe(1);
    const [url, init] = calls[0]!;
    expect(url).toContain('/api/v1/appliances/hvac-1/preferences');
    expect(init?.method).toBe('PUT');
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({
      base_temperature: 72,
      savings_level: 2,
      optimization_mode: 'cool',
      optimize_hvac_fan: false,
      optimize_hvac_mode: false,
      optimization_enabled: true,
      time_away: '06:30',
      hourly_low_temps_f: null,
      hourly_high_temps_f: null,
    });
    expect('time_home' in body).toBe(false);
  });

  it('toggles optimize_hvac_fan and optimize_hvac_mode opt-ins (Phase C/D)', async () => {
    const { calls } = captureFetch(jsonResponse({}));
    const el = mountEditor({
      applianceId: 'hvac-1',
      applianceType: 'hvac',
      currentConstraints: {
        base_temperature: 72,
        savings_level: 2,
        optimization_mode: 'cool',
      },
      open: true,
    });
    await flush(el);

    const root = el.shadowRoot!;
    // Both checkboxes should default to UNCHECKED — temperature-only
    // is the safe baseline for new + existing users.
    const fanBox = root.querySelector<HTMLInputElement>(
      'input[name="optimize_hvac_fan"]',
    );
    const modeBox = root.querySelector<HTMLInputElement>(
      'input[name="optimize_hvac_mode"]',
    );
    expect(fanBox).not.toBeNull();
    expect(modeBox).not.toBeNull();
    expect(fanBox!.checked).toBe(false);
    expect(modeBox!.checked).toBe(false);

    // Tick fan, leave mode unchecked.
    fanBox!.checked = true;
    fanBox!.dispatchEvent(new Event('change', { bubbles: true }));
    await flush(el);

    clickSave(root);
    await flush(el);

    expect(calls.length).toBe(1);
    const body = JSON.parse(String(calls[0]![1]?.body));
    expect(body.optimize_hvac_fan).toBe(true);
    expect(body.optimize_hvac_mode).toBe(false);
  });

  it('seeds Phase C/D toggles from currentConstraints (both true)', async () => {
    captureFetch(jsonResponse({}));
    const el = mountEditor({
      applianceId: 'hvac-1',
      applianceType: 'hvac',
      currentConstraints: {
        base_temperature: 72,
        savings_level: 2,
        optimization_mode: 'cool',
        optimize_hvac_fan: true,
        optimize_hvac_mode: true,
      },
      open: true,
    });
    await flush(el);

    const root = el.shadowRoot!;
    const fanBox = root.querySelector<HTMLInputElement>(
      'input[name="optimize_hvac_fan"]',
    );
    const modeBox = root.querySelector<HTMLInputElement>(
      'input[name="optimize_hvac_mode"]',
    );
    expect(fanBox!.checked).toBe(true);
    expect(modeBox!.checked).toBe(true);
  });

  it('blocks save with Use HH:MM error when time_away is invalid (US-FE-HVAC-EDITOR-PREFS-01 c)', async () => {
    const { calls } = captureFetch(jsonResponse({}));
    const el = mountEditor({
      applianceId: 'hvac-1',
      applianceType: 'hvac',
      currentConstraints: {
        base_temperature: 72,
        savings_level: 2,
        optimization_mode: 'cool',
      },
      open: true,
    });
    await flush(el);

    const root = el.shadowRoot!;
    setInputValue(root, 'time_away', 'invalid');
    await flush(el);

    const save = Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
      b.classList.contains('save'),
    )!;
    expect(save.disabled).toBe(true);

    const fieldErrors = Array.from(root.querySelectorAll('.field-error')).map((n) => n.textContent ?? '');
    expect(fieldErrors.some((t) => t.includes('Use HH:MM'))).toBe(true);

    clickSave(root);
    await flush(el);
    expect(calls.length).toBe(0);
  });

  it('hides time_away/time_home inputs when hourly bands are enabled (US-FE-HVAC-EDITOR-PREFS-01 d)', async () => {
    captureFetch(jsonResponse({}));
    const el = mountEditor({
      applianceId: 'hvac-1',
      applianceType: 'hvac',
      currentConstraints: {
        base_temperature: 72,
        savings_level: 2,
        optimization_mode: 'cool',
        time_away: '08:00',
        time_home: '17:00',
      },
      open: true,
    });
    await flush(el);

    const root = el.shadowRoot!;
    expect(root.querySelector('input[name="time_away"]')).not.toBeNull();
    expect(root.querySelector('input[name="time_home"]')).not.toBeNull();

    // Switch the comfort schedule style to custom hourly limits.
    const customRadio = root.querySelector<HTMLInputElement>(
      'input[name="comfort_style"][value="custom"]',
    )!;
    customRadio.checked = true;
    customRadio.dispatchEvent(new Event('change', { bubbles: true }));
    await flush(el);

    expect(root.querySelector('input[name="time_away"]')).toBeNull();
    expect(root.querySelector('input[name="time_home"]')).toBeNull();
    // The savings slider only drives the simple style — hidden too.
    expect(root.querySelector('input[name="savings_level"]')).toBeNull();
  });

  it('renders a per-appliance pause toggle that defaults ON and submits false when unchecked (US-MHVAC-017)', async () => {
    const { calls } = captureFetch(jsonResponse({}));
    const el = mountEditor({
      applianceId: 'hvac-bedroom',
      applianceType: 'hvac',
      currentConstraints: {
        base_temperature: 72,
        savings_level: 2,
        optimization_mode: 'cool',
      },
      open: true,
    });
    await flush(el);

    const root = el.shadowRoot!;
    const pauseBox = root.querySelector<HTMLInputElement>(
      'input[name="optimization_enabled"]',
    );
    expect(pauseBox).not.toBeNull();
    // Default ON — a missing field on currentConstraints (older API)
    // must NEVER read as paused.
    expect(pauseBox!.checked).toBe(true);

    // Uncheck to pause this HVAC.
    pauseBox!.checked = false;
    pauseBox!.dispatchEvent(new Event('change', { bubbles: true }));
    await flush(el);

    clickSave(root);
    await flush(el);

    expect(calls.length).toBe(1);
    const [url, init] = calls[0]!;
    expect(url).toContain('/api/v1/appliances/hvac-bedroom/preferences');
    const body = JSON.parse(String(init?.body));
    expect(body.optimization_enabled).toBe(false);
  });

  it('seeds the pause toggle from currentConstraints.optimization_enabled=false (US-MHVAC-017)', async () => {
    captureFetch(jsonResponse({}));
    const el = mountEditor({
      applianceId: 'hvac-1',
      applianceType: 'hvac',
      currentConstraints: {
        base_temperature: 72,
        savings_level: 2,
        optimization_mode: 'cool',
        optimization_enabled: false,
      },
      open: true,
    });
    await flush(el);

    const root = el.shadowRoot!;
    const pauseBox = root.querySelector<HTMLInputElement>(
      'input[name="optimization_enabled"]',
    );
    expect(pauseBox!.checked).toBe(false);
  });

  it('two HVAC appliances hold and submit independent values (US-MHVAC-017)', async () => {
    // Each save returns the canonical row shape, but the test asserts
    // that the URL + body the editor sent are tagged with the right
    // applianceId AND carry the value the user edited in each form.
    const { calls } = captureFetch(jsonResponse({}));

    // Mount editor #1 for the bedroom HVAC, seed at 68 F.
    const el1 = mountEditor({
      applianceId: 'hvac-bedroom',
      applianceType: 'hvac',
      currentConstraints: {
        base_temperature: 68,
        savings_level: 1,
        optimization_mode: 'cool',
      },
      open: true,
    });
    await flush(el1);

    const root1 = el1.shadowRoot!;
    expect(
      root1.querySelector<HTMLInputElement>('input[name="base_temperature"]')!.value,
    ).toBe('68');

    // Edit + save the bedroom editor.
    setInputValue(root1, 'base_temperature', '66');
    await flush(el1);
    clickSave(root1);
    await flush(el1);

    // Mount editor #2 for the living-room HVAC, seed at 74 F. Critically,
    // the same panel can host both editors back-to-back; the per-
    // appliance applianceId on the editor is what disambiguates the
    // save target.
    const el2 = mountEditor({
      applianceId: 'hvac-living',
      applianceType: 'hvac',
      currentConstraints: {
        base_temperature: 74,
        savings_level: 3,
        optimization_mode: 'cool',
      },
      open: true,
    });
    await flush(el2);

    const root2 = el2.shadowRoot!;
    // Independence lock: the living-room form must NOT inherit the
    // bedroom's edited value.
    expect(
      root2.querySelector<HTMLInputElement>('input[name="base_temperature"]')!.value,
    ).toBe('74');

    setInputValue(root2, 'base_temperature', '76');
    await flush(el2);
    clickSave(root2);
    await flush(el2);

    expect(calls.length).toBe(2);

    const [url1, init1] = calls[0]!;
    expect(url1).toContain('/api/v1/appliances/hvac-bedroom/preferences');
    const body1 = JSON.parse(String(init1?.body));
    expect(body1.base_temperature).toBe(66);
    expect(body1.savings_level).toBe(1);

    const [url2, init2] = calls[1]!;
    expect(url2).toContain('/api/v1/appliances/hvac-living/preferences');
    const body2 = JSON.parse(String(init2?.body));
    expect(body2.base_temperature).toBe(76);
    expect(body2.savings_level).toBe(3);

    // Neither save touched the user-level /api/v1/preferences endpoint.
    expect(
      calls.every(([u]) => !u.endsWith('/api/v1/preferences')),
    ).toBe(true);
  });

  it('blocks save when min_charge_pct is not less than target_charge_pct', async () => {
    const { calls } = captureFetch(
      jsonResponse({ status: 'ok', constraints: {} }),
    );

    const el = mountEditor({
      applianceId: 'ev-9',
      applianceType: 'ev_charger',
      currentConstraints: {},
      open: true,
    });
    await flush(el);

    const root = el.shadowRoot!;
    setInputValue(root, 'target_charge_pct', '50');
    setInputValue(root, 'min_charge_pct', '60'); // invalid: min >= target
    setInputValue(root, 'current_charge_pct', '30');
    setInputValue(root, 'deadline_time', '07:00');
    await flush(el);

    const save = Array.from(
      root.querySelectorAll<HTMLButtonElement>('button'),
    ).find((b) => b.classList.contains('save'))!;
    expect(save.disabled).toBe(true);

    clickSave(root);
    await flush(el);
    expect(calls.length).toBe(0);
    // A field error should be visible for min_charge_pct.
    const fieldErrors = Array.from(
      root.querySelectorAll('.field-error'),
    ).map((n) => n.textContent);
    expect(fieldErrors.some((t) => (t ?? '').includes('less than target'))).toBe(
      true,
    );
  });
});
