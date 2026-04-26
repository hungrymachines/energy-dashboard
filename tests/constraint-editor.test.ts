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

  it('submits hvac form to PUT /api/v1/preferences', async () => {
    const { calls } = captureFetch(
      jsonResponse({
        base_temperature: 72,
        savings_level: 4,
        time_away: '08:00',
        time_home: '18:00',
        optimization_mode: 'savings',
      }),
    );

    const el = mountEditor({
      applianceId: 'hvac-1',
      applianceType: 'hvac',
      currentConstraints: {
        base_temperature: 72,
        savings_level: 3,
        optimization_mode: 'balanced',
      },
      open: true,
    });
    await flush(el);

    const root = el.shadowRoot!;
    setInputValue(root, 'savings_level', '4');
    setInputValue(root, 'optimization_mode', 'savings');
    await flush(el);

    clickSave(root);
    await flush(el);

    expect(calls.length).toBe(1);
    const [url, init] = calls[0]!;
    expect(url).toContain('/api/v1/preferences');
    expect(init?.method).toBe('PUT');
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({
      base_temperature: 72,
      savings_level: 4,
      optimization_mode: 'savings',
      hourly_low_temps_f: null,
      hourly_high_temps_f: null,
    });
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
