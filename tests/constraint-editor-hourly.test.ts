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
  for (let i = 0; i < 6; i++) {
    await el.updateComplete;
    await Promise.resolve();
  }
}

function findButtonByText(root: ShadowRoot | HTMLElement, text: string): HTMLButtonElement {
  const btn = Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(
    (b) => b.textContent?.trim().includes(text),
  );
  if (!btn) throw new Error(`button containing "${text}" not found`);
  return btn;
}

function saveButton(root: ShadowRoot): HTMLButtonElement {
  const btn = Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
    b.classList.contains('save'),
  );
  if (!btn) throw new Error('save button not found');
  return btn;
}

function styleRadio(root: ShadowRoot, value: 'simple' | 'custom'): HTMLInputElement {
  const el = root.querySelector<HTMLInputElement>(
    `input[name="comfort_style"][value="${value}"]`,
  );
  if (!el) throw new Error(`comfort_style radio "${value}" not found`);
  return el;
}

function selectStyle(root: ShadowRoot, value: 'simple' | 'custom'): void {
  const radio = styleRadio(root, value);
  radio.checked = true;
  radio.dispatchEvent(new Event('change', { bubbles: true }));
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

describe('hm-constraint-editor hourly bands (US-FE-OVR-02)', () => {
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

  it('(a) defaults to the simple style; the preview toggle reveals 24 disabled rows derived from base+savings+home/away', async () => {
    captureFetch(jsonResponse({}));

    // base=72, savings=3 (offset 12), away 08:00-17:00.
    // The band is symmetric and mode-independent:
    //   home hour: base ± 1.0 → 71 / 73
    //   away hour: base ± 12  → 60 / 84
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
    // The style choice is always visible, simple pre-selected.
    expect(styleRadio(root, 'simple').checked).toBe(true);
    expect(styleRadio(root, 'custom').checked).toBe(false);

    // Preview collapsed by default: no rows in DOM.
    expect(root.querySelectorAll('tr[data-row]').length).toBe(0);
    expect(root.textContent).toContain('Preview hourly limits');

    // Click toggle to open the derived preview.
    findButtonByText(root, 'Preview hourly limits').click();
    await flush(el);

    const rows = root.querySelectorAll<HTMLTableRowElement>('tr[data-row]');
    expect(rows.length).toBe(24);

    // Hour 0 is HOME time (before 08:00) → tight ±1.0 band.
    const low0 = root.querySelector<HTMLInputElement>('input[name="hourly_low_0"]')!;
    const high0 = root.querySelector<HTMLInputElement>('input[name="hourly_high_0"]')!;
    expect(low0.value).toBe('71');
    expect(high0.value).toBe('73');
    expect(low0.disabled).toBe(true);
    expect(high0.disabled).toBe(true);
    // Hour 12 is AWAY (08:00-17:00) → wide ±12 band (savings level 3).
    const low12 = root.querySelector<HTMLInputElement>('input[name="hourly_low_12"]')!;
    const high12 = root.querySelector<HTMLInputElement>('input[name="hourly_high_12"]')!;
    expect(low12.value).toBe('60');
    expect(high12.value).toBe('84');
  });

  it('(b) selecting the custom style, modifying row 0 to low=70/high=74, then Save fires PUT with the expected arrays', async () => {
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
        time_away: '08:00',
        time_home: '18:00',
        optimization_mode: 'auto',
      },
      open: true,
    });
    await flush(el);

    const root = el.shadowRoot!;
    // Switch to the custom style — the editable table appears without
    // any extra collapsible toggle.
    selectStyle(root, 'custom');
    await flush(el);

    expect(root.querySelectorAll('tr[data-row]').length).toBe(24);

    // Modify row 0 (a HOME hour given away=08:00, home=18:00).
    setRowInput(root, 'low', 0, '70');
    setRowInput(root, 'high', 0, '74');
    await flush(el);

    const save = saveButton(root);
    expect(save.disabled).toBe(false);
    save.click();
    await flush(el);

    expect(calls.length).toBe(1);
    const [url, init] = calls[0]!;
    // Per-HVAC-appliance preferences endpoint (US-MHVAC-017).
    expect(url).toContain('/api/v1/appliances/hvac-1/preferences');
    expect(init?.method).toBe('PUT');
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
    // Untouched rows reflect the symmetric mode-independent band
    // (savings=3, base=72, away 08:00-18:00):
    //   home hours → 71 / 73 (base ± 1.0)
    //   away hours → 60 / 84 (base ± 12)
    for (let i = 1; i < 24; i++) {
      const isAway = i >= 8 && i < 18;
      const expectedLow = isAway ? 60 : 71;
      const expectedHigh = isAway ? 84 : 73;
      expect(body.hourly_low_temps_f[i]).toBe(expectedLow);
      expect(body.hourly_high_temps_f[i]).toBe(expectedHigh);
    }
    // Legacy fields still submitted.
    expect(body.base_temperature).toBe(72);
    expect(body.savings_level).toBe(3);
    expect(body.optimization_mode).toBe('auto');
  });

  it('(c) leaving the simple style selected and clicking Save fires PUT with both fields explicitly null', async () => {
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
    // Don't touch the style radios. Save should still fire with nulls.
    const save = saveButton(root);
    expect(save.disabled).toBe(false);
    save.click();
    await flush(el);

    expect(calls.length).toBe(1);
    const [url, init] = calls[0]!;
    // Per-HVAC-appliance preferences endpoint (US-MHVAC-017).
    expect(url).toContain('/api/v1/appliances/hvac-1/preferences');
    expect(init?.method).toBe('PUT');
    const body = JSON.parse(String(init?.body)) as {
      hourly_high_temps_f: number[] | null;
      hourly_low_temps_f: number[] | null;
    };
    expect(body.hourly_high_temps_f).toBeNull();
    expect(body.hourly_low_temps_f).toBeNull();
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
    selectStyle(root, 'custom');
    await flush(el);

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

  it('(e) when currentConstraints contains both 24-element arrays, the custom style is pre-selected with the table pre-filled', async () => {
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
    expect(styleRadio(root, 'custom').checked).toBe(true);
    expect(styleRadio(root, 'simple').checked).toBe(false);
    // Custom style hides the simple-only fields.
    expect(root.querySelector('input[name="savings_level"]')).toBeNull();
    expect(root.querySelector('input[name="time_away"]')).toBeNull();

    // The editable table renders immediately — no collapsible in the way.
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

  it('(f) switching a bands-enabled appliance back to the simple style and saving PUTs both fields explicitly null', async () => {
    const { calls } = captureFetch(jsonResponse({}));

    const lows = Array.from({ length: 24 }, () => 68);
    const highs = Array.from({ length: 24 }, () => 78);
    const el = mountEditor({
      applianceId: 'hvac-1',
      applianceType: 'hvac',
      currentConstraints: {
        base_temperature: 72,
        savings_level: 3,
        optimization_mode: 'auto',
        time_away: '08:00',
        time_home: '18:00',
        hourly_low_temps_f: lows,
        hourly_high_temps_f: highs,
        optimization_enabled: true,
      },
      open: true,
    });
    await flush(el);

    const root = el.shadowRoot!;
    expect(styleRadio(root, 'custom').checked).toBe(true);

    // The user goes back to the simple schedule.
    selectStyle(root, 'simple');
    await flush(el);

    // Simple-only fields come back and the table shows the derived
    // preview instead of the stale custom values.
    expect(root.querySelector('input[name="savings_level"]')).not.toBeNull();
    expect(root.querySelector('input[name="time_away"]')).not.toBeNull();

    const save = saveButton(root);
    expect(save.disabled).toBe(false);
    save.click();
    await flush(el);

    expect(calls.length).toBe(1);
    const body = JSON.parse(String(calls[0]![1]?.body)) as {
      hourly_high_temps_f: number[] | null;
      hourly_low_temps_f: number[] | null;
    };
    expect(body.hourly_high_temps_f).toBeNull();
    expect(body.hourly_low_temps_f).toBeNull();
  });

  it('(g) a late currentConstraints reassignment does NOT revert an in-progress style switch (Lit checked-stomp regression)', async () => {
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
    expect(styleRadio(root, 'custom').checked).toBe(true);

    // …the user switches back to simple while the panel's async
    // per-appliance GET is still in flight…
    selectStyle(root, 'simple');
    await flush(el);
    expect(styleRadio(root, 'simple').checked).toBe(true);

    // …and the GET lands afterwards, reassigning currentConstraints to a
    // fresh object that still carries the (now stale) custom bands.
    // Before the dirty-guard fix this silently flipped the editor back
    // to bands-enabled while the radio kept LOOKING like "simple", so
    // Save re-sent the custom arrays the user had just turned off.
    el.currentConstraints = { ...bandsRow };
    await flush(el);

    expect(styleRadio(root, 'simple').checked).toBe(true);
    expect(styleRadio(root, 'custom').checked).toBe(false);

    saveButton(root).click();
    await flush(el);

    expect(calls.length).toBe(1);
    const body = JSON.parse(String(calls[0]![1]?.body)) as {
      hourly_high_temps_f: number[] | null;
      hourly_low_temps_f: number[] | null;
    };
    expect(body.hourly_high_temps_f).toBeNull();
    expect(body.hourly_low_temps_f).toBeNull();
  });

  it('(h) a late currentConstraints reassignment still reseeds a PRISTINE editor (34874ae behavior preserved)', async () => {
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
    expect(styleRadio(root, 'simple').checked).toBe(true);

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

    expect(styleRadio(root, 'custom').checked).toBe(true);
    expect(
      root.querySelector<HTMLInputElement>('input[name="base_temperature"]')!.value,
    ).toBe('70');
  });
});
