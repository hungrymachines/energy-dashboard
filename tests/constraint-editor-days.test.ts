import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HmConstraintEditor } from '../src/ui/constraint-editor.js';
import { clearTokens, setApiBase, setTokens } from '../src/api/client.js';

if (!customElements.get('hm-constraint-editor')) {
  customElements.define('hm-constraint-editor', HmConstraintEditor);
}

type EditorEl = HmConstraintEditor & { updateComplete: Promise<boolean> };
type FetchCall = [string, RequestInit | undefined];

const WEEKDAY = { high: Array(24).fill(76.2), low: Array(24).fill(68.4) };
const WEEKEND = { high: Array(24).fill(79), low: Array(24).fill(66) };
const SAT = { high: Array(24).fill(80), low: Array(24).fill(65) };
const entry = (b: { high: number[]; low: number[] }) => ({
  hourly_high_temps_f: b.high,
  hourly_low_temps_f: b.low,
});

function base(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    base_temperature: 72,
    savings_level: 1,
    optimization_mode: 'auto',
    hourly_high_temps_f: WEEKDAY.high,
    hourly_low_temps_f: WEEKDAY.low,
    ...extra,
  };
}

async function open(constraints: Record<string, unknown>, unit: 'F' | 'C' = 'F') {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push([typeof input === 'string' ? input : String(input), init]);
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
  const el = document.createElement('hm-constraint-editor') as EditorEl;
  Object.assign(el, {
    applianceId: 'hvac-1',
    applianceType: 'hvac',
    currentConstraints: constraints,
    temperatureUnit: unit,
    open: true,
  });
  document.body.appendChild(el);
  await el.updateComplete;
  return { el, calls, root: el.shadowRoot! };
}

const tick = async (el: EditorEl) => {
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
};

function radio(root: ShadowRoot, id: string) {
  const r = root.querySelector<HTMLInputElement>(`input[name="day_preset"][value="${id}"]`)!;
  r.checked = true;
  r.dispatchEvent(new Event('change', { bubbles: true }));
}
const chip = (root: ShadowRoot, day: string) =>
  root.querySelector<HTMLButtonElement>(`button.day-chip[data-day="${day}"]`)!;
function type(root: ShadowRoot, name: string, value: string) {
  const el = root.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
async function save(el: EditorEl, calls: FetchCall[]) {
  [...el.shadowRoot!.querySelectorAll<HTMLButtonElement>('button')]
    .find((b) => b.classList.contains('save'))!
    .click();
  await tick(el);
  const put = calls.filter(([, i]) => i?.method === 'PUT');
  expect(put.length).toBe(1);
  return JSON.parse(String(put[0]![1]?.body)) as Record<string, any>;
}
const checked = (root: ShadowRoot) =>
  [...root.querySelectorAll<HTMLInputElement>('input[name="day_preset"]')].find((r) => r.checked)?.value;

describe('constraint editor day bands', () => {
  beforeEach(() => {
    setApiBase('https://api.example.test');
    setTokens({ access: 'A', refresh: 'R' });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
    clearTokens();
  });

  it('seeds every / weekend / each from the stored prefs', async () => {
    let t = await open(base());
    expect(checked(t.root)).toBe('every');
    expect(t.root.querySelectorAll('button.day-chip').length).toBe(0);
    expect(t.root.textContent).toContain('Days run midnight to midnight.');
    document.body.innerHTML = '';

    t = await open(base({ weekday_bands: { sat: entry(WEEKEND), sun: entry(WEEKEND) } }));
    expect(checked(t.root)).toBe('weekend');
    expect([...t.root.querySelectorAll('button.day-chip')].map((b) => b.textContent!.trim())).toEqual([
      'Mon–Fri',
      'Sat–Sun',
    ]);
    document.body.innerHTML = '';

    t = await open(base({ weekday_bands: { sat: entry(SAT) } }));
    expect(checked(t.root)).toBe('each');
    expect(t.root.querySelectorAll('button.day-chip').length).toBe(7);
    expect(chip(t.root, 'sat').getAttribute('aria-label')).toBe('Saturday');
    expect(chip(t.root, 'tue').classList.contains('same')).toBe(true);
    expect(chip(t.root, 'sat').classList.contains('same')).toBe(false);
  });

  it('editing Saturday in each saves only a sat entry', async () => {
    const { el, calls, root } = await open(base({ weekday_bands: { sat: entry(SAT) } }));
    chip(root, 'sat').click();
    await tick(el);
    expect(root.querySelector<HTMLInputElement>('input[name="hourly_high_0"]')!.value).toBe('80');
    type(root, 'hourly_high_0', '81');
    await tick(el);
    const body = await save(el, calls);
    expect(Object.keys(body.weekday_bands)).toEqual(['sat']);
    expect(body.weekday_bands.sat.hourly_high_temps_f[0]).toBe(81);
    expect(body.hourly_high_temps_f).toEqual(WEEKDAY.high);
  });

  it('weekend save shape: Mon-Fri arrays plus sat and sun', async () => {
    const { el, calls, root } = await open(base());
    radio(root, 'weekend');
    await tick(el);
    chip(root, 'sat').click();
    await tick(el);
    type(root, 'hourly_low_3', '64');
    await tick(el);
    const body = await save(el, calls);
    expect(Object.keys(body.weekday_bands).sort()).toEqual(['sat', 'sun']);
    expect(body.weekday_bands.sun).toEqual(body.weekday_bands.sat);
    expect(body.weekday_bands.sat.hourly_low_temps_f[3]).toBe(64);
    expect(body.hourly_low_temps_f).toEqual(WEEKDAY.low);
  });

  it('switching to every sends weekday_bands null and shows the replace note', async () => {
    const { el, calls, root } = await open(base({ weekday_bands: { sat: entry(SAT) } }));
    radio(root, 'every');
    await tick(el);
    expect(root.textContent).toContain('Days with their own band will be replaced when you save.');
    const body = await save(el, calls);
    expect(body.weekday_bands).toBeNull();
    expect(body.hourly_high_temps_f).toEqual(WEEKDAY.high);
  });

  it('opens in °C and an untouched day saves its exact stored °F', async () => {
    const { el, calls, root } = await open(base({ weekday_bands: { sat: entry(SAT) } }), 'C');
    chip(root, 'sat').click();
    await tick(el);
    chip(root, 'mon').click();
    await tick(el);
    const body = await save(el, calls);
    expect(body.hourly_high_temps_f).toEqual(WEEKDAY.high);
    expect(body.hourly_low_temps_f).toEqual(WEEKDAY.low);
    expect(body.weekday_bands.sat.hourly_high_temps_f).toEqual(SAT.high);
  });

  it('blocks a chip switch while the shown band has errors', async () => {
    const { el, root } = await open(base({ weekday_bands: { sat: entry(SAT) } }));
    type(root, 'hourly_high_0', '10');
    await tick(el);
    chip(root, 'sat').click();
    await tick(el);
    expect(root.textContent).toContain("Fix this day's errors first.");
    expect(chip(root, 'mon').getAttribute('aria-pressed')).toBe('true');
    expect(chip(root, 'sat').getAttribute('aria-pressed')).toBe('false');
  });

  it('copies this day to the chosen days', async () => {
    const { el, calls, root } = await open(base({ weekday_bands: { sat: entry(SAT) } }));
    chip(root, 'sat').click();
    await tick(el);
    root.querySelector<HTMLButtonElement>('button.copy-toggle')!.click();
    await tick(el);
    for (const d of ['sun', 'fri']) {
      const cb = root.querySelector<HTMLInputElement>(`input[name="copy_${d}"]`)!;
      cb.checked = true;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
    }
    await tick(el);
    root.querySelector<HTMLButtonElement>('button.copy-go')!.click();
    await tick(el);
    expect(chip(root, 'fri').classList.contains('same')).toBe(true);
    const body = await save(el, calls);
    expect(Object.keys(body.weekday_bands).sort()).toEqual(['fri', 'sat', 'sun']);
  });
});
