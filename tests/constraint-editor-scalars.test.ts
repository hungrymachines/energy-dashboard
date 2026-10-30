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
  const input = el.shadowRoot!.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function save(el: EditorEl): void {
  el.shadowRoot!.querySelector<HTMLButtonElement>('button.save')!.click();
}

describe('constraint editor scalar fields in °C (US-TMP-017)', () => {
  beforeEach(() => {
    setApiBase('https://api.example.test');
    setTokens({ access: 'ACCESS', refresh: 'REFRESH' });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
    clearTokens();
  });

  const hourly = {
    hourly_high_temps_f: Array(24).fill(75),
    hourly_low_temps_f: Array(24).fill(70),
  };

  it('stored 60 °F water minimum saves untouched and is not blocked by the 16 °C limit', async () => {
    const { bodies } = stubFetch();
    const el = mount({
      applianceId: 'wh-1',
      applianceType: 'water_heater',
      currentConstraints: { max_temp_f: 131, min_temp_f: 60 },
      temperatureUnit: 'C',
      open: true,
    });
    await flush(el);
    const root = el.shadowRoot!;
    expect(root.querySelector<HTMLInputElement>('input[name="max_temp_f"]')!.value).toBe('55');
    expect(root.querySelector<HTMLInputElement>('input[name="min_temp_f"]')!.value).toBe('16');
    save(el);
    await flush(el);
    expect(bodies).toEqual([{ max_temp_f: 131, min_temp_f: 60 }]);
  });

  it('water heater min >= max errors in °C', async () => {
    stubFetch();
    const el = mount({
      applianceId: 'wh-1',
      applianceType: 'water_heater',
      currentConstraints: { max_temp_f: 131, min_temp_f: 100 },
      temperatureUnit: 'C',
      open: true,
    });
    await flush(el);
    type(el, 'min_temp_f', '60');
    await flush(el);
    expect(el.shadowRoot!.textContent).toContain('Must be less than max');
  });

  it('edited water heater value is range-checked in °C', async () => {
    stubFetch();
    const el = mount({
      applianceId: 'wh-1',
      applianceType: 'water_heater',
      currentConstraints: { max_temp_f: 131, min_temp_f: 100 },
      temperatureUnit: 'C',
      open: true,
    });
    await flush(el);
    type(el, 'min_temp_f', '10');
    await flush(el);
    expect(el.shadowRoot!.textContent).toContain('Must be 16–82');
  });

  it('edited base 22 °C sends the exact °F, untouched sends the stored °F', async () => {
    const { bodies } = stubFetch();
    const el = mount({
      applianceId: 'hvac-1',
      applianceType: 'hvac',
      currentConstraints: { base_temperature: 72, savings_level: 1, ...hourly },
      temperatureUnit: 'C',
      open: true,
    });
    await flush(el);
    expect(el.shadowRoot!.querySelector<HTMLInputElement>('input[name="base_temperature"]')!.value).toBe('22');
    save(el);
    await flush(el);
    expect(bodies[0]!['base_temperature']).toBe(72);

    const el2 = mount({
      applianceId: 'hvac-1',
      applianceType: 'hvac',
      currentConstraints: { base_temperature: 72, savings_level: 1, ...hourly },
      temperatureUnit: 'C',
      open: true,
    });
    await flush(el2);
    type(el2, 'base_temperature', '22.5');
    await flush(el2);
    save(el2);
    await flush(el2);
    expect(bodies[1]!['base_temperature']).toBe(72.5);
  });

  it('stored 70 °F base, edited to 22 °C, sends 71.6', async () => {
    const { bodies } = stubFetch();
    const el = mount({
      applianceId: 'hvac-1',
      applianceType: 'hvac',
      currentConstraints: { base_temperature: 70, savings_level: 1, ...hourly },
      temperatureUnit: 'C',
      open: true,
    });
    await flush(el);
    type(el, 'base_temperature', '22');
    await flush(el);
    save(el);
    await flush(el);
    expect(bodies[0]!['base_temperature']).toBe(71.6);
  });

  it('base temperature outside the range errors on an edited value only', async () => {
    stubFetch();
    const el = mount({
      applianceId: 'hvac-1',
      applianceType: 'hvac',
      currentConstraints: { base_temperature: 72, savings_level: 1, ...hourly },
      temperatureUnit: 'C',
      open: true,
    });
    await flush(el);
    type(el, 'base_temperature', '30');
    await flush(el);
    expect(el.shadowRoot!.textContent).toContain('Must be 16–29 °C');
  });

  it('°F is unchanged: base 72 sends 72 and a label says °F', async () => {
    const { bodies } = stubFetch();
    const el = mount({
      applianceId: 'hvac-1',
      applianceType: 'hvac',
      currentConstraints: { base_temperature: 72, savings_level: 1, ...hourly },
      temperatureUnit: 'F',
      open: true,
    });
    await flush(el);
    expect(el.shadowRoot!.textContent).toContain('Base temperature (°F)');
    save(el);
    await flush(el);
    expect(bodies[0]!['base_temperature']).toBe(72);
  });
});
