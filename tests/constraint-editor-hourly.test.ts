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

/** Routes requests by URL substring so a test can stub both the
 * default-bands GET and the save PUT with different bodies. */
function routeFetch(
  routes: Array<{ match: string; response: Response }>,
): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const spy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    calls.push([url, init]);
    const route = routes.find((r) => url.includes(r.match));
    if (!route) throw new Error(`no route stubbed for ${url}`);
    return route.response.clone();
  });
  vi.stubGlobal('fetch', spy);
  return { calls };
}

async function flush(el: EditorEl): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await el.updateComplete;
    await Promise.resolve();
  }
}

function saveButton(root: ShadowRoot): HTMLButtonElement {
  const btn = Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
    b.classList.contains('save'),
  );
  if (!btn) throw new Error('save button not found');
  return btn;
}

function resetButton(root: ShadowRoot): HTMLButtonElement {
  const btn = Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
    b.classList.contains('reset-defaults'),
  );
  if (!btn) throw new Error('reset-defaults button not found');
  return btn;
}

function setRowInput(
  root: ShadowRoot,
  side: 'low' | 'high',
  row: number,
  value: string,
): void {
  const el = root.querySelector<HTMLInputElement>(
    `input[name="hourly_${side}_${row}"]`,
  );
  if (!el) throw new Error(`hourly_${side}_${row} not found`);
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('hm-constraint-editor hourly bands (US-SDC-032: table is the primary control)', () => {
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

  it('(a) the hourly table renders unconditionally — no style toggle, no preview collapsible — seeded from the shaped default', async () => {
    captureFetch(jsonResponse({}));

    // base=72, savings=3 (away offset 12), away 08:00-17:00 — same
    // fixture the old flat-band test used; home hour 0 and away hour 12
    // are unaffected by the US-SDC-030 peak/precool shaping, so they
    // still pin the original expected values.
    const el = mountEditor({
      applianceId: 'hvac-1',
      applianceType: 'hvac',
      currentConstraints: {
        base_temperature: 72,
        savings_level: 3,
        time_away: '08:00',
        time_home: '17:00',
        optimization_mode: 'auto',
      },
      open: true,
    });
    await flush(el);

    const root = el.shadowRoot!;
    // No toggle/radio controls from the old simple/custom split.
    expect(root.querySelector('input[name="comfort_style"]')).toBeNull();
    expect(root.textContent).not.toContain('Preview hourly limits');
    expect(root.textContent).not.toContain('Comfort schedule style');

    // Defaults group is present with its own fields.
    expect(root.textContent).toContain('Defaults');
    expect(root.querySelector('input[name="base_temperature"]')).not.toBeNull();
    expect(root.querySelector('input[name="savings_level"]')).not.toBeNull();
    expect(root.querySelector('input[name="time_away"]')).not.toBeNull();
    expect(root.querySelector('input[name="time_home"]')).not.toBeNull();

    // The table is present immediately, fully enabled, 24 rows.
    const rows = root.querySelectorAll<HTMLTableRowElement>('tr[data-row]');
    expect(rows.length).toBe(24);

    const low0 = root.querySelector<HTMLInputElement>('input[name="hourly_low_0"]')!;
    const high0 = root.querySelector<HTMLInputElement>('input[name="hourly_high_0"]')!;
    expect(low0.disabled).toBe(false);
    expect(high0.disabled).toBe(false);
    // Hour 0 — home, outside peak/precool: tight ±1.0.
    expect(low0.value).toBe('71');
    expect(high0.value).toBe('73');
    // Hour 12 — away (08:00-17:00): full ±12 (savings level 3).
    const low12 = root.querySelector<HTMLInputElement>('input[name="hourly_low_12"]')!;
    const high12 = root.querySelector<HTMLInputElement>('input[name="hourly_high_12"]')!;
    expect(low12.value).toBe('60');
    expect(high12.value).toBe('84');
  });

  it('(b) editing a table row and clicking Save fires PUT with both hourly arrays, never null', async () => {
    const { calls } = routeFetch([
      {
        match: '/preferences',
        response: jsonResponse({
          base_temperature: 72,
          savings_level: 3,
          time_away: '08:00',
          time_home: '18:00',
          optimization_mode: 'auto',
        }),
      },
    ]);

    const el = mountEditor({
      applianceId: 'hvac-1',
      applianceType: 'hvac',
      currentConstraints: {
        base_temperature: 72,
        savings_level: 3,
        time_away: '08:00',
        time_home: '18:00',
        optimization_mode: 'auto',
      },
      open: true,
    });
    await flush(el);

    const root = el.shadowRoot!;
    expect(root.querySelectorAll('tr[data-row]').length).toBe(24);

    setRowInput(root, 'low', 0, '70');
    setRowInput(root, 'high', 0, '74');
    await flush(el);

    const save = saveButton(root);
    expect(save.disabled).toBe(false);
    save.click();
    await flush(el);

    const putCalls = calls.filter(([, init]) => init?.method === 'PUT');
    expect(putCalls.length).toBe(1);
    const [url, init] = putCalls[0]!;
    expect(url).toContain('/api/v1/appliances/hvac-1/preferences');
    const body = JSON.parse(String(init?.body)) as {
      hourly_high_temps_f: number[];
      hourly_low_temps_f: number[];
      base_temperature: number;
      savings_level: number;
      optimization_mode: string;
    };
    expect(Array.isArray(body.hourly_low_temps_f)).toBe(true);
    expect(Array.isArray(body.hourly_high_temps_f)).toBe(true);
    expect(body.hourly_low_temps_f.length).toBe(24);
    expect(body.hourly_high_temps_f.length).toBe(24);
    expect(body.hourly_low_temps_f[0]).toBe(70);
    expect(body.hourly_high_temps_f[0]).toBe(74);
    // Legacy fields still submitted alongside the hourly arrays.
    expect(body.base_temperature).toBe(72);
    expect(body.savings_level).toBe(3);
    expect(body.optimization_mode).toBe('auto');
  });

  it('(c) Save with no row edits still PUTs the seeded (non-null) hourly arrays', async () => {
    const { calls } = captureFetch(
      jsonResponse({
        base_temperature: 72,
        savings_level: 3,
        time_away: '08:00',
        time_home: '18:00',
        optimization_mode: 'auto',
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
    const save = saveButton(root);
    expect(save.disabled).toBe(false);
    save.click();
    await flush(el);

    expect(calls.length).toBe(1);
    const [url, init] = calls[0]!;
    expect(url).toContain('/api/v1/appliances/hvac-1/preferences');
    expect(init?.method).toBe('PUT');
    const body = JSON.parse(String(init?.body)) as {
      hourly_high_temps_f: number[] | null;
      hourly_low_temps_f: number[] | null;
    };
    expect(body.hourly_high_temps_f).not.toBeNull();
    expect(body.hourly_low_temps_f).not.toBeNull();
    expect(body.hourly_high_temps_f).toHaveLength(24);
    expect(body.hourly_low_temps_f).toHaveLength(24);
  });

  it('(d) low=75/high=70 in row 5 shows "High must be greater than low" and disables Save', async () => {
    captureFetch(jsonResponse({}));

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
    setRowInput(root, 'low', 5, '75');
    setRowInput(root, 'high', 5, '70');
    await flush(el);

    const errorRow = root.querySelector<HTMLElement>('tr[data-row-error="5"]');
    expect(errorRow).not.toBeNull();
    expect(errorRow!.hasAttribute('hidden')).toBe(false);
    expect(errorRow!.textContent).toContain('High must be greater than low');

    const save = saveButton(root);
    expect(save.disabled).toBe(true);
    expect(save.title).toBe('Fix hourly bands errors');
  });

  it('(e) when currentConstraints carries stored 24-element hourly arrays, the table is pre-filled with them (not re-derived)', async () => {
    captureFetch(jsonResponse({}));

    const lows = Array.from({ length: 24 }, (_, i) => 65 + (i % 3));
    const highs = Array.from({ length: 24 }, (_, i) => 75 + (i % 3));

    const el = mountEditor({
      applianceId: 'hvac-1',
      applianceType: 'hvac',
      currentConstraints: {
        base_temperature: 72,
        savings_level: 3,
        optimization_mode: 'auto',
        hourly_low_temps_f: lows,
        hourly_high_temps_f: highs,
      },
      open: true,
    });
    await flush(el);

    const root = el.shadowRoot!;
    for (let i = 0; i < 24; i++) {
      const lowEl = root.querySelector<HTMLInputElement>(
        `input[name="hourly_low_${i}"]`,
      )!;
      const highEl = root.querySelector<HTMLInputElement>(
        `input[name="hourly_high_${i}"]`,
      )!;
      expect(Number(lowEl.value)).toBe(lows[i]);
      expect(Number(highEl.value)).toBe(highs[i]);
      expect(lowEl.disabled).toBe(false);
      expect(highEl.disabled).toBe(false);
    }
  });

  it('(f) "Reset to defaults" calls the per-appliance default-bands endpoint with the in-progress form values and refills the table', async () => {
    const { calls } = routeFetch([
      {
        match: '/preferences/default-bands',
        response: jsonResponse({
          hourly_high_temps_f: Array.from({ length: 24 }, () => 80),
          hourly_low_temps_f: Array.from({ length: 24 }, () => 64),
          peak_hours: [13, 21],
          precool_hours: [9, 13],
        }),
      },
    ]);

    const el = mountEditor({
      applianceId: 'hvac-1',
      applianceType: 'hvac',
      currentConstraints: {
        base_temperature: 72,
        savings_level: 3,
        time_away: '08:00',
        time_home: '17:00',
        optimization_mode: 'auto',
      },
      open: true,
    });
    await flush(el);

    const root = el.shadowRoot!;
    // Edit base_temperature before resetting — Reset should send the
    // live form value, not the stale stored one.
    const baseInput = root.querySelector<HTMLInputElement>(
      'input[name="base_temperature"]',
    )!;
    baseInput.value = '75';
    baseInput.dispatchEvent(new Event('input', { bubbles: true }));
    await flush(el);

    resetButton(root).click();
    await flush(el);

    const getCalls = calls.filter(([url]) => url.includes('/preferences/default-bands'));
    expect(getCalls.length).toBe(1);
    const [url] = getCalls[0]!;
    expect(url).toContain('/api/v1/appliances/hvac-1/preferences/default-bands');
    expect(url).toContain('base_temperature=75');
    expect(url).toContain('savings_level=3');
    expect(url).toContain('time_away=08%3A00');
    expect(url).toContain('time_home=17%3A00');

    const low0 = root.querySelector<HTMLInputElement>('input[name="hourly_low_0"]')!;
    const high0 = root.querySelector<HTMLInputElement>('input[name="hourly_high_0"]')!;
    expect(low0.value).toBe('64');
    expect(high0.value).toBe('80');
    // No failure note when the request succeeds.
    expect(root.textContent).not.toContain('Could not reach the server');
  });

  it('(g) "Reset to defaults" falls back to the local mirror and shows an inline note when the request fails', async () => {
    const spy = vi.fn(async () => {
      throw new TypeError('network error');
    });
    vi.stubGlobal('fetch', spy);

    const el = mountEditor({
      applianceId: 'hvac-1',
      applianceType: 'hvac',
      currentConstraints: {
        base_temperature: 72,
        savings_level: 3,
        time_away: '08:00',
        time_home: '17:00',
        optimization_mode: 'auto',
      },
      open: true,
    });
    await flush(el);

    const root = el.shadowRoot!;
    resetButton(root).click();
    await flush(el);

    // Falls back to the local mirror (deriveHourlyComfortBand) — same
    // shaped-default values the initial seed already used.
    const low0 = root.querySelector<HTMLInputElement>('input[name="hourly_low_0"]')!;
    const high0 = root.querySelector<HTMLInputElement>('input[name="hourly_high_0"]')!;
    expect(low0.value).toBe('71');
    expect(high0.value).toBe('73');
    expect(root.textContent).toContain('Could not reach the server');

    // The table is still usable afterward: Save is enabled and sends the
    // fallback-filled arrays.
    const save = saveButton(root);
    expect(save.disabled).toBe(false);
  });

  it('(h) a late currentConstraints reassignment does NOT revert an in-progress table edit', async () => {
    const { calls } = captureFetch(jsonResponse({}));

    const lows = Array.from({ length: 24 }, () => 68);
    const highs = Array.from({ length: 24 }, () => 78);
    const bandsRow = {
      base_temperature: 72,
      savings_level: 3,
      optimization_mode: 'auto',
      time_away: '08:00',
      time_home: '18:00',
      hourly_low_temps_f: lows,
      hourly_high_temps_f: highs,
      optimization_enabled: true,
    };

    // Panel opens the editor seeded from its cache…
    const el = mountEditor({
      applianceId: 'hvac-1',
      applianceType: 'hvac',
      currentConstraints: { ...bandsRow },
      open: true,
    });
    await flush(el);

    const root = el.shadowRoot!;
    expect(
      root.querySelector<HTMLInputElement>('input[name="hourly_low_0"]')!.value,
    ).toBe('68');

    // …the user edits a row while the panel's async per-appliance GET is
    // still in flight…
    setRowInput(root, 'low', 0, '65');
    await flush(el);
    expect(
      root.querySelector<HTMLInputElement>('input[name="hourly_low_0"]')!.value,
    ).toBe('65');

    // …and the GET lands afterwards, reassigning currentConstraints to a
    // fresh object carrying the (now stale) original bands. Before the
    // dirty-guard fix this silently reverted the in-progress edit.
    el.currentConstraints = { ...bandsRow };
    await flush(el);

    expect(
      root.querySelector<HTMLInputElement>('input[name="hourly_low_0"]')!.value,
    ).toBe('65');

    saveButton(root).click();
    await flush(el);

    expect(calls.length).toBe(1);
    const body = JSON.parse(String(calls[0]![1]?.body)) as {
      hourly_low_temps_f: number[];
    };
    expect(body.hourly_low_temps_f[0]).toBe(65);
  });

  it('(i) a late currentConstraints reassignment still reseeds a PRISTINE editor', async () => {
    captureFetch(jsonResponse({}));

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
    // The per-appliance GET lands with custom bands and the user hasn't
    // touched anything — the form must adopt the fresh row.
    el.currentConstraints = {
      base_temperature: 70,
      savings_level: 2,
      optimization_mode: 'cool',
      hourly_low_temps_f: Array.from({ length: 24 }, () => 66),
      hourly_high_temps_f: Array.from({ length: 24 }, () => 76),
    };
    await flush(el);

    expect(
      root.querySelector<HTMLInputElement>('input[name="base_temperature"]')!.value,
    ).toBe('70');
    expect(
      root.querySelector<HTMLInputElement>('input[name="hourly_low_0"]')!.value,
    ).toBe('66');
  });
});
