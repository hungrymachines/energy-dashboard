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

  it('(a) renders Hourly bands section closed; clicking toggle reveals 24 rows derived from base+savings+home/away', async () => {
    captureFetch(jsonResponse({}));

    // Provide explicit prefs so the derived band is deterministic.
    // base=72, savings=3 (offset 12), auto mode, away 08:00-17:00.
    // Expected (auto mode):
    //   away hour: high = base + offset/2 = 78, low = base - offset/2 = 66
    //   home hour: high = base + 1.5      = 73.5, low = base - 1.5     = 70.5
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
    // Closed by default: no rows in DOM.
    expect(root.querySelectorAll('tr[data-row]').length).toBe(0);
    // Section title exists.
    expect(root.textContent).toContain('Hourly bands (advanced)');

    // Click toggle to open.
    findButtonByText(root, 'Hourly bands (advanced)').click();
    await flush(el);

    const rows = root.querySelectorAll<HTMLTableRowElement>('tr[data-row]');
    expect(rows.length).toBe(24);

    // Hour 0 is HOME time (before 08:00) → tight band base ± 1.5.
    const low0 = root.querySelector<HTMLInputElement>('input[name="hourly_low_0"]')!;
    const high0 = root.querySelector<HTMLInputElement>('input[name="hourly_high_0"]')!;
    expect(low0.value).toBe('70.5');
    expect(high0.value).toBe('73.5');
    // Hour 12 is AWAY (08:00-17:00) → widened by savings_offset/2 in auto mode.
    const low12 = root.querySelector<HTMLInputElement>('input[name="hourly_low_12"]')!;
    const high12 = root.querySelector<HTMLInputElement>('input[name="hourly_high_12"]')!;
    expect(low12.value).toBe('66');
    expect(high12.value).toBe('78');

    // Checkbox is unchecked by default — the user has not opted into hourly overrides.
    const checkbox = root.querySelector<HTMLInputElement>(
      'input[name="use_hourly_bands"]',
    )!;
    expect(checkbox.checked).toBe(false);
  });

  it('(b) checking the box, modifying row 0 to low=70/high=74, then Save fires PUT with the expected arrays', async () => {
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
    findButtonByText(root, 'Hourly bands (advanced)').click();
    await flush(el);

    // Check the "Use my hourly bands" box.
    const checkbox = root.querySelector<HTMLInputElement>(
      'input[name="use_hourly_bands"]',
    )!;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    await flush(el);

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
    expect(url).toContain('/api/v1/preferences');
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
    // Untouched rows now reflect the derived band (auto mode, savings=3,
    // base=72, away 08:00-18:00). Home hours: 70.5 / 73.5; away: 66 / 78.
    for (let i = 1; i < 24; i++) {
      const isAway = i >= 8 && i < 18;
      const expectedLow = isAway ? 66 : 70.5;
      const expectedHigh = isAway ? 78 : 73.5;
      expect(body.hourly_low_temps_f[i]).toBe(expectedLow);
      expect(body.hourly_high_temps_f[i]).toBe(expectedHigh);
    }
    // Legacy fields still submitted.
    expect(body.base_temperature).toBe(72);
    expect(body.savings_level).toBe(3);
    expect(body.optimization_mode).toBe('auto');
  });

  it('(c) leaving the box unchecked and clicking Save fires PUT with both fields explicitly null', async () => {
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
    // Don't open the section, don't check the box. Save should still fire with nulls.
    const save = saveButton(root);
    expect(save.disabled).toBe(false);
    save.click();
    await flush(el);

    expect(calls.length).toBe(1);
    const [url, init] = calls[0]!;
    expect(url).toContain('/api/v1/preferences');
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
    findButtonByText(root, 'Hourly bands (advanced)').click();
    await flush(el);

    const checkbox = root.querySelector<HTMLInputElement>(
      'input[name="use_hourly_bands"]',
    )!;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
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

  it('(e) when currentConstraints contains both 24-element arrays, section opens pre-checked and pre-filled', async () => {
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
    // Section is open by default when both arrays are pre-supplied.
    const checkbox = root.querySelector<HTMLInputElement>(
      'input[name="use_hourly_bands"]',
    );
    expect(checkbox).not.toBeNull();
    expect(checkbox!.checked).toBe(true);

    for (let i = 0; i < 24; i++) {
      const lowEl = root.querySelector<HTMLInputElement>(
        `input[name="hourly_low_${i}"]`,
      )!;
      const highEl = root.querySelector<HTMLInputElement>(
        `input[name="hourly_high_${i}"]`,
      )!;
      expect(Number(lowEl.value)).toBe(lows[i]);
      expect(Number(highEl.value)).toBe(highs[i]);
    }
  });
});
