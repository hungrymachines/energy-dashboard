import { describe, it, expect, afterEach, vi } from 'vitest';
import { HmScheduleChart } from '../src/ui/schedule-chart.js';

if (!customElements.get('hm-schedule-chart')) {
  customElements.define('hm-schedule-chart', HmScheduleChart);
}

type ChartEl = HmScheduleChart & { updateComplete: Promise<boolean> };

function mount(props: Partial<HmScheduleChart>): ChartEl {
  const el = document.createElement('hm-schedule-chart') as ChartEl;
  Object.assign(el, props);
  document.body.appendChild(el);
  return el;
}

describe('hm-schedule-chart', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('renders 48 rate bars split 16/16/16 across the three tercile colors', async () => {
    const rates = [
      ...Array<number>(16).fill(5),
      ...Array<number>(16).fill(15),
      ...Array<number>(16).fill(25),
    ];

    const el = mount({ rates });
    await el.updateComplete;

    const root = el.shadowRoot!;
    const svgEl = root.querySelector('svg');
    expect(svgEl).not.toBeNull();

    const rateBars = root.querySelectorAll('rect.rate-bar');
    expect(rateBars.length).toBe(48);

    expect(root.querySelectorAll('rect.rate-bar[data-tier="low"]').length).toBe(
      16,
    );
    expect(root.querySelectorAll('rect.rate-bar[data-tier="mid"]').length).toBe(
      16,
    );
    expect(
      root.querySelectorAll('rect.rate-bar[data-tier="high"]').length,
    ).toBe(16);
  });

  it('renders a visible boolean-active strip when booleanSchedule is provided', async () => {
    const rates = Array<number>(48).fill(10);
    const booleanSchedule = Array<boolean>(48).fill(false);
    booleanSchedule[5] = true;
    booleanSchedule[12] = true;
    booleanSchedule[30] = true;

    const el = mount({ rates, booleanSchedule });
    await el.updateComplete;

    const active = el.shadowRoot!.querySelectorAll('rect.boolean-active');
    expect(active.length).toBe(3);
  });

  it('renders empty and logs a warning when rates length is not 48', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {
      /* suppress */
    });

    const el = mount({ rates: [1, 2, 3] });
    await el.updateComplete;

    const root = el.shadowRoot!;
    expect(root.querySelectorAll('rect.rate-bar').length).toBe(0);
    expect(root.querySelector('svg')).toBeNull();
    expect(warn).toHaveBeenCalled();
    const firstCall = warn.mock.calls[0] as unknown as [string];
    expect(firstCall[0]).toContain('48');
  });

  it('renders a translucent comfort band when comfortHighs/comfortLows are length 48', async () => {
    const rates = Array<number>(48).fill(10);
    const comfortHighs = Array<number>(48).fill(70);
    const comfortLows = Array<number>(48).fill(68);

    const el = mount({ rates, comfortHighs, comfortLows });
    await el.updateComplete;

    const root = el.shadowRoot!;
    const bands = root.querySelectorAll('rect.comfort-band');
    expect(bands.length).toBe(48);
  });

  it('skips the comfort overlay and warns when comfortHighs is wrong length', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {
      /* suppress */
    });
    const rates = Array<number>(48).fill(10);
    const comfortHighs = Array<number>(24).fill(70);
    const comfortLows = Array<number>(24).fill(68);

    const el = mount({ rates, comfortHighs, comfortLows });
    await el.updateComplete;

    const root = el.shadowRoot!;
    expect(root.querySelectorAll('rect.comfort-band').length).toBe(0);
    expect(root.querySelector('svg')).not.toBeNull();
    expect(warn).toHaveBeenCalled();
    const calls = warn.mock.calls as unknown as Array<[string]>;
    const matched = calls.find((c) => c[0].includes('comfort'));
    expect(matched).toBeDefined();
  });

  it('renders comfort band before optimizer setpoints band in document order', async () => {
    const rates = Array<number>(48).fill(10);
    const highTemps = Array<number>(48).fill(74);
    const lowTemps = Array<number>(48).fill(70);
    const comfortHighs = Array<number>(48).fill(78);
    const comfortLows = Array<number>(48).fill(66);

    const el = mount({ rates, highTemps, lowTemps, comfortHighs, comfortLows });
    await el.updateComplete;

    const root = el.shadowRoot!;
    const allRects = Array.from(root.querySelectorAll('rect'));
    const firstComfortIdx = allRects.findIndex((r) =>
      r.classList.contains('comfort-band'),
    );
    const firstTempIdx = allRects.findIndex((r) =>
      r.classList.contains('temp-band'),
    );
    expect(firstComfortIdx).toBeGreaterThanOrEqual(0);
    expect(firstTempIdx).toBeGreaterThanOrEqual(0);
    expect(firstComfortIdx).toBeLessThan(firstTempIdx);
  });
});
