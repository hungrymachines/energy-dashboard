import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HmConstraintEditor } from '../src/ui/constraint-editor.js';
import { clearTokens, setApiBase, setTokens } from '../src/api/client.js';

if (!customElements.get('hm-constraint-editor')) {
  customElements.define('hm-constraint-editor', HmConstraintEditor);
}

type EditorEl = HmConstraintEditor & { updateComplete: Promise<boolean> };

function mount(init: Partial<HmConstraintEditor>): EditorEl {
  const el = document.createElement('hm-constraint-editor') as EditorEl;
  Object.assign(el, init);
  document.body.appendChild(el);
  return el;
}

async function flush(el: EditorEl): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await el.updateComplete;
    await Promise.resolve();
  }
}

function stubFetch(): { bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_u: unknown, init?: RequestInit) => {
      if (init?.method === 'PUT' || init?.method === 'POST') bodies.push(JSON.parse(String(init.body)));
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
  return { bodies };
}

function type(el: EditorEl, name: string, value: string): void {
  const input = el.shadowRoot!.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function check(el: EditorEl, name: string, checked: boolean): void {
  const input = el.shadowRoot!.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
  input.checked = checked;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function save(el: EditorEl): void {
  el.shadowRoot!.querySelector<HTMLButtonElement>('button.save')!.click();
}

function fieldErrors(el: EditorEl): string[] {
  return Array.from(el.shadowRoot!.querySelectorAll('.field-error')).map((n) => n.textContent ?? '');
}

function saveDisabled(el: EditorEl): boolean {
  return el.shadowRoot!.querySelector<HTMLButtonElement>('button.save')!.disabled;
}

describe('hot tub constraint editor', () => {
  beforeEach(() => {
    setApiBase('https://api.example.test');
    setTokens({ access: 'ACCESS', refresh: 'REFRESH' });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
    clearTokens();
  });

  it('seeds ready/eco defaults and one every-day soak row when no constraints exist', async () => {
    stubFetch();
    const el = mount({
      applianceId: 'tub-1',
      applianceType: 'hot_tub',
      currentConstraints: {},
      temperatureUnit: 'F',
      open: true,
    });
    await flush(el);
    const root = el.shadowRoot!;
    expect(root.querySelector<HTMLInputElement>('input[name="ready_temp_f"]')!.value).toBe('102');
    expect(root.querySelector<HTMLInputElement>('input[name="eco_temp_f"]')!.value).toBe('95');
    expect(root.querySelector<HTMLInputElement>('input[name="soak_start_0"]')!.value).toBe('19:00');
    expect(root.querySelector<HTMLInputElement>('input[name="soak_end_0"]')!.value).toBe('21:00');
    for (const day of ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']) {
      expect(root.querySelector<HTMLInputElement>(`input[name="soak_day_0_${day}"]`)!.checked).toBe(true);
    }
    expect(root.querySelectorAll('[data-soak-row]').length).toBe(1);
    // A single row cannot be removed.
    expect(root.querySelector('button.soak-remove')).toBeNull();
  });

  it('seeds ready/eco and soak windows from stored constraints, including a restricted days list', async () => {
    stubFetch();
    const el = mount({
      applianceId: 'tub-1',
      applianceType: 'hot_tub',
      currentConstraints: {
        ready_temp_f: 100,
        eco_temp_f: 90,
        soak_windows: [
          { start: '07:00', end: '08:00', days: [5, 6] },
          { start: '19:00', end: '21:00' },
        ],
      },
      temperatureUnit: 'F',
      open: true,
    });
    await flush(el);
    const root = el.shadowRoot!;
    expect(root.querySelector<HTMLInputElement>('input[name="ready_temp_f"]')!.value).toBe('100');
    expect(root.querySelector<HTMLInputElement>('input[name="eco_temp_f"]')!.value).toBe('90');
    expect(root.querySelector<HTMLInputElement>('input[name="soak_start_0"]')!.value).toBe('07:00');
    expect(root.querySelector<HTMLInputElement>('input[name="soak_end_0"]')!.value).toBe('08:00');
    expect(root.querySelector<HTMLInputElement>('input[name="soak_day_0_sat"]')!.checked).toBe(true);
    expect(root.querySelector<HTMLInputElement>('input[name="soak_day_0_sun"]')!.checked).toBe(true);
    expect(root.querySelector<HTMLInputElement>('input[name="soak_day_0_mon"]')!.checked).toBe(false);
    expect(root.querySelector<HTMLInputElement>('input[name="soak_start_1"]')!.value).toBe('19:00');
    for (const day of ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']) {
      expect(root.querySelector<HTMLInputElement>(`input[name="soak_day_1_${day}"]`)!.checked).toBe(true);
    }
    expect(root.querySelectorAll('[data-soak-row]').length).toBe(2);
  });

  it('adds rows up to the 4-row cap, hiding Add after the fourth', async () => {
    stubFetch();
    const el = mount({
      applianceId: 'tub-1',
      applianceType: 'hot_tub',
      currentConstraints: {},
      temperatureUnit: 'F',
      open: true,
    });
    await flush(el);
    const root = el.shadowRoot!;
    const add = () => root.querySelector<HTMLButtonElement>('button.reset-defaults')!;
    expect(add()).not.toBeNull();
    add().click();
    await flush(el);
    add().click();
    await flush(el);
    add().click();
    await flush(el);
    expect(root.querySelectorAll('[data-soak-row]').length).toBe(4);
    expect(root.querySelector('button.reset-defaults')).toBeNull();
  });

  it('removes a row and the cap lifts again, but never below one row', async () => {
    stubFetch();
    const el = mount({
      applianceId: 'tub-1',
      applianceType: 'hot_tub',
      currentConstraints: {},
      temperatureUnit: 'F',
      open: true,
    });
    await flush(el);
    const root = el.shadowRoot!;
    root.querySelector<HTMLButtonElement>('button.reset-defaults')!.click();
    await flush(el);
    expect(root.querySelectorAll('[data-soak-row]').length).toBe(2);
    root.querySelector<HTMLButtonElement>('button.soak-remove')!.click();
    await flush(el);
    expect(root.querySelectorAll('[data-soak-row]').length).toBe(1);
    expect(root.querySelector('button.soak-remove')).toBeNull();
  });

  it('maps weekday toggles with Monday = 0 in the saved payload', async () => {
    const { bodies } = stubFetch();
    const el = mount({
      applianceId: 'tub-9',
      applianceType: 'hot_tub',
      currentConstraints: {},
      temperatureUnit: 'F',
      open: true,
    });
    await flush(el);
    // Uncheck every day except Wednesday (index 2) and Saturday (index 5).
    for (const day of ['mon', 'tue', 'thu', 'fri', 'sun']) {
      check(el, `soak_day_0_${day}`, false);
    }
    await flush(el);
    save(el);
    await flush(el);
    const body = bodies[0] as { soak_windows: Array<{ start: string; end: string; days?: number[] }> };
    expect(body.soak_windows[0]!.days).toEqual([2, 5]);
  });

  it('omits days from the payload when every day is on', async () => {
    const { bodies } = stubFetch();
    const el = mount({
      applianceId: 'tub-9',
      applianceType: 'hot_tub',
      currentConstraints: {},
      temperatureUnit: 'F',
      open: true,
    });
    await flush(el);
    save(el);
    await flush(el);
    const body = bodies[0] as { soak_windows: Array<{ start: string; end: string; days?: number[] }> };
    expect(body.soak_windows[0]).toEqual({ start: '19:00', end: '21:00' });
    expect('days' in body.soak_windows[0]!).toBe(false);
  });

  it('submits the exact three-key payload shape', async () => {
    const { calls } = (() => {
      const calls: Array<[string, RequestInit | undefined]> = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: unknown, init?: RequestInit) => {
          const url = typeof input === 'string' ? input : (input as URL | Request).toString();
          calls.push([url, init]);
          return new Response(
            JSON.stringify({ status: 'ok', constraints: {} }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }),
      );
      return { calls };
    })();

    const el = mount({
      applianceId: 'tub-9',
      applianceType: 'hot_tub',
      currentConstraints: {},
      temperatureUnit: 'F',
      open: true,
    });
    await flush(el);
    save(el);
    await flush(el);

    expect(calls.length).toBe(1);
    const [url, init] = calls[0]!;
    expect(url).toContain('/api/v1/appliances/tub-9/constraints');
    expect(init?.method).toBe('POST');
    const body = JSON.parse(String(init?.body));
    expect(Object.keys(body).sort()).toEqual(['eco_temp_f', 'ready_temp_f', 'soak_windows'].sort());
    expect(body).toEqual({
      ready_temp_f: 102,
      eco_temp_f: 95,
      soak_windows: [{ start: '19:00', end: '21:00' }],
    });
    expect(el.open).toBe(false);
  });

  it('blocks save when ready_temp_f is out of its 80-104 range', async () => {
    stubFetch();
    const el = mount({
      applianceId: 'tub-2',
      applianceType: 'hot_tub',
      currentConstraints: {},
      temperatureUnit: 'F',
      open: true,
    });
    await flush(el);
    type(el, 'ready_temp_f', '79');
    await flush(el);
    expect(saveDisabled(el)).toBe(true);
    expect(fieldErrors(el).some((t) => t.includes('80–104'))).toBe(true);
  });

  it('blocks save when eco_temp_f is out of its 50-104 range', async () => {
    stubFetch();
    const el = mount({
      applianceId: 'tub-2',
      applianceType: 'hot_tub',
      currentConstraints: {},
      temperatureUnit: 'F',
      open: true,
    });
    await flush(el);
    type(el, 'eco_temp_f', '49');
    await flush(el);
    expect(saveDisabled(el)).toBe(true);
    expect(fieldErrors(el).some((t) => t.includes('50–104'))).toBe(true);
  });

  it('blocks save when eco_temp_f exceeds ready_temp_f', async () => {
    const { calls } = stubFetch() as unknown as { calls: unknown[] };
    const el = mount({
      applianceId: 'tub-3',
      applianceType: 'hot_tub',
      currentConstraints: {},
      temperatureUnit: 'F',
      open: true,
    });
    await flush(el);
    type(el, 'ready_temp_f', '90');
    type(el, 'eco_temp_f', '95');
    await flush(el);
    expect(saveDisabled(el)).toBe(true);
    expect(fieldErrors(el).some((t) => t.includes('at or below ready'))).toBe(true);
    save(el);
    await flush(el);
    expect((calls ?? []).length ?? 0).toBe(0);
  });

  it('allows eco_temp_f equal to ready_temp_f', async () => {
    stubFetch();
    const el = mount({
      applianceId: 'tub-4',
      applianceType: 'hot_tub',
      currentConstraints: {},
      temperatureUnit: 'F',
      open: true,
    });
    await flush(el);
    type(el, 'ready_temp_f', '90');
    type(el, 'eco_temp_f', '90');
    await flush(el);
    expect(saveDisabled(el)).toBe(false);
  });

  it('blocks save when a soak row has no start or end time', async () => {
    stubFetch();
    const el = mount({
      applianceId: 'tub-5',
      applianceType: 'hot_tub',
      currentConstraints: {},
      temperatureUnit: 'F',
      open: true,
    });
    await flush(el);
    type(el, 'soak_start_0', '');
    await flush(el);
    expect(saveDisabled(el)).toBe(true);
    expect(fieldErrors(el).some((t) => t === 'Required')).toBe(true);
  });

  it('blocks save when a soak row time is not HH:MM', async () => {
    stubFetch();
    const el = mount({
      applianceId: 'tub-6',
      applianceType: 'hot_tub',
      currentConstraints: {},
      temperatureUnit: 'F',
      open: true,
    });
    await flush(el);
    type(el, 'soak_start_0', 'nope');
    await flush(el);
    expect(saveDisabled(el)).toBe(true);
    expect(fieldErrors(el).some((t) => t.includes('HH:MM'))).toBe(true);
  });

  it('blocks save when a soak row start is not earlier than its end', async () => {
    stubFetch();
    const el = mount({
      applianceId: 'tub-7',
      applianceType: 'hot_tub',
      currentConstraints: {},
      temperatureUnit: 'F',
      open: true,
    });
    await flush(el);
    type(el, 'soak_start_0', '21:00');
    type(el, 'soak_end_0', '19:00');
    await flush(el);
    expect(saveDisabled(el)).toBe(true);
    expect(fieldErrors(el).some((t) => t.includes('after start'))).toBe(true);
  });

  it('blocks save when a soak row has no weekday selected', async () => {
    stubFetch();
    const el = mount({
      applianceId: 'tub-8',
      applianceType: 'hot_tub',
      currentConstraints: {},
      temperatureUnit: 'F',
      open: true,
    });
    await flush(el);
    for (const day of ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']) {
      check(el, `soak_day_0_${day}`, false);
    }
    await flush(el);
    expect(saveDisabled(el)).toBe(true);
    expect(fieldErrors(el).some((t) => t.includes('at least one day'))).toBe(true);
  });

  it('round-trips ready and eco temperatures in °C', async () => {
    const { bodies } = stubFetch();
    const el = mount({
      applianceId: 'tub-10',
      applianceType: 'hot_tub',
      currentConstraints: { ready_temp_f: 102, eco_temp_f: 95 },
      temperatureUnit: 'C',
      open: true,
    });
    await flush(el);
    const root = el.shadowRoot!;
    // Stored °F values untouched, displayed in °C to the nearest 0.5.
    expect(root.querySelector<HTMLInputElement>('input[name="ready_temp_f"]')!.value).toBe('39');
    expect(root.querySelector<HTMLInputElement>('input[name="eco_temp_f"]')!.value).toBe('35');
    type(el, 'ready_temp_f', '40');
    await flush(el);
    save(el);
    await flush(el);
    expect(bodies[0]!['ready_temp_f']).toBe(104);
    // eco_temp_f was never touched, so it saves the exact stored °F.
    expect(bodies[0]!['eco_temp_f']).toBe(95);
  });

  it('range-checks ready_temp_f in °C', async () => {
    stubFetch();
    const el = mount({
      applianceId: 'tub-11',
      applianceType: 'hot_tub',
      currentConstraints: { ready_temp_f: 102, eco_temp_f: 95 },
      temperatureUnit: 'C',
      open: true,
    });
    await flush(el);
    type(el, 'ready_temp_f', '20');
    await flush(el);
    expect(fieldErrors(el).some((t) => t.includes('26.5–40'))).toBe(true);
  });
});
