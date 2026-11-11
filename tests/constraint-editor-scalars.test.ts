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

describe('constraint editor scalar fields in °C', () => {
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
    // Every save carries all seven keys — the API replaces the whole
    // constraints object, so an omitted key would be erased.
    expect(bodies).toEqual([
      {
        max_temp_f: 131,
        min_temp_f: 60,
        floor_temp_f: 120,
        sanitize_enabled: true,
        sanitize_temp_f: 140,
        sanitize_hold_minutes: 60,
        sanitize_interval_days: 2,
      },
    ]);
  });

  it('water heater floor and sanitize fields seed their defaults when no constraints row exists', async () => {
    stubFetch();
    const el = mount({
      applianceId: 'wh-1',
      applianceType: 'water_heater',
      currentConstraints: {},
      temperatureUnit: 'F',
      open: true,
    });
    await flush(el);
    const root = el.shadowRoot!;
    expect(root.querySelector<HTMLInputElement>('input[name="floor_temp_f"]')!.value).toBe('120');
    expect(root.querySelector<HTMLInputElement>('input[name="sanitize_enabled"]')!.checked).toBe(true);
    expect(root.querySelector<HTMLInputElement>('input[name="sanitize_temp_f"]')!.value).toBe('140');
    expect(root.querySelector<HTMLInputElement>('input[name="sanitize_hold_minutes"]')!.value).toBe('60');
    expect(root.querySelector<HTMLInputElement>('input[name="sanitize_interval_days"]')!.value).toBe('2');
  });

  it('water heater floor and sanitize fields seed the stored constraint when present', async () => {
    stubFetch();
    const el = mount({
      applianceId: 'wh-1',
      applianceType: 'water_heater',
      currentConstraints: {
        max_temp_f: 150,
        min_temp_f: 110,
        floor_temp_f: 125,
        sanitize_enabled: false,
        sanitize_temp_f: 145,
        sanitize_hold_minutes: 90,
        sanitize_interval_days: 3,
      },
      temperatureUnit: 'F',
      open: true,
    });
    await flush(el);
    const root = el.shadowRoot!;
    expect(root.querySelector<HTMLInputElement>('input[name="floor_temp_f"]')!.value).toBe('125');
    expect(root.querySelector<HTMLInputElement>('input[name="sanitize_enabled"]')!.checked).toBe(false);
    expect(root.querySelector<HTMLInputElement>('input[name="sanitize_temp_f"]')!.value).toBe('145');
    expect(root.querySelector<HTMLInputElement>('input[name="sanitize_hold_minutes"]')!.value).toBe('90');
    expect(root.querySelector<HTMLInputElement>('input[name="sanitize_interval_days"]')!.value).toBe('3');
  });

  it('water heater floor temperature shows and round-trips in °C', async () => {
    const { bodies } = stubFetch();
    const el = mount({
      applianceId: 'wh-1',
      applianceType: 'water_heater',
      currentConstraints: { max_temp_f: 150, min_temp_f: 110, floor_temp_f: 120 },
      temperatureUnit: 'C',
      open: true,
    });
    await flush(el);
    // 120 °F stored, untouched — displays as a whole-degree °C.
    expect(el.shadowRoot!.querySelector<HTMLInputElement>('input[name="floor_temp_f"]')!.value).toBe('49');
    type(el, 'floor_temp_f', '50');
    await flush(el);
    save(el);
    await flush(el);
    expect(bodies[0]!['floor_temp_f']).toBe(122);
  });

  it('water heater cycle temperature shows and round-trips in °C', async () => {
    const { bodies } = stubFetch();
    const el = mount({
      applianceId: 'wh-1',
      applianceType: 'water_heater',
      currentConstraints: { max_temp_f: 150, min_temp_f: 110, sanitize_temp_f: 140 },
      temperatureUnit: 'C',
      open: true,
    });
    await flush(el);
    // 140 °F stored, untouched — displays as a whole-degree °C.
    expect(el.shadowRoot!.querySelector<HTMLInputElement>('input[name="sanitize_temp_f"]')!.value).toBe('60');
    type(el, 'sanitize_temp_f', '65');
    await flush(el);
    save(el);
    await flush(el);
    expect(bodies[0]!['sanitize_temp_f']).toBe(149);
  });

  it('water heater floor temperature is range-checked in °C', async () => {
    stubFetch();
    const el = mount({
      applianceId: 'wh-1',
      applianceType: 'water_heater',
      currentConstraints: { max_temp_f: 150, min_temp_f: 110, floor_temp_f: 120 },
      temperatureUnit: 'C',
      open: true,
    });
    await flush(el);
    type(el, 'floor_temp_f', '5');
    await flush(el);
    expect(el.shadowRoot!.textContent).toContain('Must be 16–71');
  });

  it('water heater cycle temperature is range-checked in °C', async () => {
    stubFetch();
    const el = mount({
      applianceId: 'wh-1',
      applianceType: 'water_heater',
      currentConstraints: { max_temp_f: 150, min_temp_f: 110, sanitize_temp_f: 140 },
      temperatureUnit: 'C',
      open: true,
    });
    await flush(el);
    type(el, 'sanitize_temp_f', '5');
    await flush(el);
    expect(el.shadowRoot!.textContent).toContain('Must be 60–71');
  });

  it('sanitize hold minutes outside 30-180 is rejected', async () => {
    stubFetch();
    const el = mount({
      applianceId: 'wh-1',
      applianceType: 'water_heater',
      currentConstraints: { max_temp_f: 150, min_temp_f: 110 },
      temperatureUnit: 'F',
      open: true,
    });
    await flush(el);
    type(el, 'sanitize_hold_minutes', '10');
    await flush(el);
    expect(el.shadowRoot!.textContent).toContain('Must be 30–180');
  });

  it('sanitize interval days outside 1-14 or non-integer is rejected', async () => {
    stubFetch();
    const el = mount({
      applianceId: 'wh-1',
      applianceType: 'water_heater',
      currentConstraints: { max_temp_f: 150, min_temp_f: 110 },
      temperatureUnit: 'F',
      open: true,
    });
    await flush(el);
    type(el, 'sanitize_interval_days', '20');
    await flush(el);
    expect(el.shadowRoot!.textContent).toContain('Must be a whole number 1–14');
  });

  it('unchecking the sanitize checkbox sends sanitize_enabled: false', async () => {
    const { bodies } = stubFetch();
    const el = mount({
      applianceId: 'wh-1',
      applianceType: 'water_heater',
      currentConstraints: { max_temp_f: 150, min_temp_f: 110 },
      temperatureUnit: 'F',
      open: true,
    });
    await flush(el);
    const checkbox = el.shadowRoot!.querySelector<HTMLInputElement>('input[name="sanitize_enabled"]')!;
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    await flush(el);
    save(el);
    await flush(el);
    expect(bodies[0]!['sanitize_enabled']).toBe(false);
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
