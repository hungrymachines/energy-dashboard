import { describe, it, expect, beforeEach } from 'vitest';
import { HmOptimizationChart } from '../src/ui/optimization-chart.js';

if (!customElements.get('hm-optimization-chart')) {
  customElements.define('hm-optimization-chart', HmOptimizationChart);
}

type ChartEl = HmOptimizationChart & { updateComplete: Promise<boolean> };

const RATES_48 = Array.from({ length: 48 }, (_, i) => 10 + (i % 4) * 5);

function mount(): ChartEl {
  const el = document.createElement('hm-optimization-chart') as ChartEl;
  document.body.appendChild(el);
  return el;
}

async function flush(el: ChartEl): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await el.updateComplete;
    await Promise.resolve();
  }
}

describe('hm-optimization-chart', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('renders an empty-state message when rates is wrong length', async () => {
    const el = mount();
    el.rates = [1, 2, 3];
    el.highLimits = Array<number>(48).fill(76);
    await flush(el);
    const root = el.shadowRoot!;
    expect(root.querySelector('.empty')).not.toBeNull();
    expect(root.querySelector('svg')).toBeNull();
  });

  it('renders an empty-state when rates are present but no line series given', async () => {
    const el = mount();
    el.rates = RATES_48;
    await flush(el);
    const root = el.shadowRoot!;
    expect(root.querySelector('.empty')).not.toBeNull();
    expect(root.querySelector('.empty')!.textContent).toContain('No temperature plan');
  });

  it('shows a percent-mode empty state when unit is percent', async () => {
    const el = mount();
    el.rates = RATES_48;
    el.unit = 'percent';
    await flush(el);
    expect(el.shadowRoot!.querySelector('.empty')!.textContent).toContain('No charge plan');
  });

  it('renders 24 hourly price bars when only rates + targetValues given', async () => {
    const el = mount();
    el.rates = RATES_48;
    el.targetValues = Array<number>(48).fill(72);
    await flush(el);
    const root = el.shadowRoot!;
    const bars = root.querySelectorAll('rect.price-bar');
    expect(bars.length).toBe(24);
  });

  it('renders three polylines when all three series are present', async () => {
    const el = mount();
    el.rates = RATES_48;
    el.highLimits = Array<number>(48).fill(76);
    el.lowLimits = Array<number>(48).fill(68);
    el.targetValues = Array<number>(48).fill(72);
    await flush(el);
    const root = el.shadowRoot!;
    expect(root.querySelector('polyline.high-limit')).not.toBeNull();
    expect(root.querySelector('polyline.low-limit')).not.toBeNull();
    expect(root.querySelector('polyline.target')).not.toBeNull();
  });

  it('expands 24-hour line input to 48 points internally', async () => {
    const el = mount();
    el.rates = RATES_48;
    el.targetValues = Array.from({ length: 24 }, (_, i) => 70 + i * 0.1);
    await flush(el);
    const root = el.shadowRoot!;
    const target = root.querySelector('polyline.target')!;
    const points = (target.getAttribute('points') ?? '').trim().split(/\s+/);
    expect(points.length).toBe(48);
  });

  it('legend lists all four series labels in fahrenheit mode', async () => {
    const el = mount();
    el.rates = RATES_48;
    el.highLimits = Array<number>(48).fill(76);
    el.lowLimits = Array<number>(48).fill(68);
    el.targetValues = Array<number>(48).fill(72);
    await flush(el);
    const text = el.shadowRoot!.querySelector('.legend')!.textContent ?? '';
    expect(text).toContain('Optimized Temperature');
    expect(text).toContain('High Limit');
    expect(text).toContain('Low Limit');
    expect(text).toContain('Electricity Price');
  });

  it('legend uses charge wording in percent mode', async () => {
    const el = mount();
    el.rates = RATES_48;
    el.lowLimits = Array<number>(48).fill(20);
    el.targetValues = Array<number>(48).fill(60);
    el.unit = 'percent';
    await flush(el);
    const text = el.shadowRoot!.querySelector('.legend')!.textContent ?? '';
    expect(text).toContain('Optimized Charge');
    expect(text).toContain('Minimum Charge');
    expect(text).toContain('Electricity Price');
  });

  it('legend hides high/low items when their arrays are absent', async () => {
    const el = mount();
    el.rates = RATES_48;
    el.targetValues = Array<number>(48).fill(50);
    el.unit = 'percent';
    await flush(el);
    const text = el.shadowRoot!.querySelector('.legend')!.textContent ?? '';
    expect(text).toContain('Optimized Charge');
    expect(text).not.toContain('Maximum');
    expect(text).not.toContain('Minimum');
  });

  it('y-axis title shows °F in fahrenheit mode and % in percent mode', async () => {
    const el = mount();
    el.rates = RATES_48;
    el.targetValues = Array<number>(48).fill(72);
    await flush(el);
    let titles = Array.from(el.shadowRoot!.querySelectorAll('text.axis-title'));
    let titleTexts = titles.map((t) => t.textContent);
    expect(titleTexts).toContain('°F');
    expect(titleTexts).toContain('$/kWh');

    el.unit = 'percent';
    el.targetValues = Array<number>(48).fill(60);
    await flush(el);
    titles = Array.from(el.shadowRoot!.querySelectorAll('text.axis-title'));
    titleTexts = titles.map((t) => t.textContent);
    expect(titleTexts).toContain('%');
  });

  it('renders a target marker dot with auto-generated label in percent mode', async () => {
    const el = mount();
    el.rates = RATES_48;
    el.lowLimits = Array<number>(48).fill(20);
    el.targetValues = Array.from({ length: 48 }, (_, i) => 30 + i);
    el.unit = 'percent';
    el.targetMarker = { interval: 16, value: 70 }; // 16 = 08:00
    await flush(el);

    const root = el.shadowRoot!;
    expect(root.querySelector('circle.marker-dot')).not.toBeNull();
    const label = root.querySelector('text.marker-label');
    expect(label).not.toBeNull();
    expect(label!.textContent).toContain('70%');
    expect(label!.textContent).toContain('08:00');
  });

  it('uses an explicit marker label when provided', async () => {
    const el = mount();
    el.rates = RATES_48;
    el.targetValues = Array<number>(48).fill(50);
    el.unit = 'percent';
    el.targetMarker = { interval: 14, value: 80, label: '80% by 7am' };
    await flush(el);
    const label = el.shadowRoot!.querySelector('text.marker-label');
    expect(label!.textContent).toBe('80% by 7am');
  });

  it('omits the marker when interval is out of range', async () => {
    const el = mount();
    el.rates = RATES_48;
    el.targetValues = Array<number>(48).fill(50);
    el.unit = 'percent';
    el.targetMarker = { interval: 99, value: 70 };
    await flush(el);
    expect(el.shadowRoot!.querySelector('circle.marker-dot')).toBeNull();
  });

  // --- v2.5 size prop ----------------------------------------------------

  function viewBoxOf(el: ChartEl): { width: number; height: number } | null {
    const svg = el.shadowRoot!.querySelector('svg');
    const vb = svg?.getAttribute('viewBox');
    if (!vb) return null;
    const [, , w, h] = vb.split(' ').map(Number);
    return { width: w, height: h };
  }

  it('defaults to size="large" with the v2.4.1 baseline viewBox', async () => {
    const el = mount();
    el.rates = RATES_48;
    el.targetValues = Array<number>(48).fill(72);
    el.highLimits = Array<number>(48).fill(74);
    el.lowLimits = Array<number>(48).fill(70);
    await flush(el);
    expect(el.size).toBe('large');
    expect(viewBoxOf(el)).toEqual({ width: 600, height: 388 });
    expect(el.getAttribute('size')).toBe('large');
  });

  it('size="medium" produces an intermediate viewBox height', async () => {
    const el = mount();
    el.size = 'medium';
    el.rates = RATES_48;
    el.targetValues = Array<number>(48).fill(72);
    el.highLimits = Array<number>(48).fill(74);
    el.lowLimits = Array<number>(48).fill(70);
    await flush(el);
    expect(viewBoxOf(el)).toEqual({ width: 600, height: 298 });
    expect(el.getAttribute('size')).toBe('medium');
  });

  it('size="small" produces the shortest viewBox', async () => {
    const el = mount();
    el.size = 'small';
    el.rates = RATES_48;
    el.targetValues = Array<number>(48).fill(72);
    el.highLimits = Array<number>(48).fill(74);
    el.lowLimits = Array<number>(48).fill(70);
    await flush(el);
    expect(viewBoxOf(el)).toEqual({ width: 600, height: 198 });
    expect(el.getAttribute('size')).toBe('small');
  });

  it('renders hour-only x-axis labels (no trailing :00)', async () => {
    const el = mount();
    el.rates = RATES_48;
    el.targetValues = Array<number>(48).fill(72);
    el.highLimits = Array<number>(48).fill(74);
    el.lowLimits = Array<number>(48).fill(70);
    await flush(el);

    const labels = Array.from(
      el.shadowRoot!.querySelectorAll('text.axis-label'),
    ).map((n) => n.textContent || '');
    // Hour 24 % 24 → '00' (same as start), so the unique x-axis labels
    // are 00, 04, 08, 12, 16, 20 plus the wraparound '00'. None should
    // carry a trailing ':00'.
    expect(labels).toContain('00');
    expect(labels).toContain('04');
    expect(labels).toContain('12');
    expect(labels).toContain('20');
    for (const l of labels) {
      expect(l.endsWith(':00')).toBe(false);
    }
  });

  it('honors caller-supplied yMin/yMax for HVAC range (40–100 °F)', async () => {
    const el = mount();
    el.rates = RATES_48;
    el.targetValues = Array<number>(48).fill(72);
    el.highLimits = Array<number>(48).fill(74);
    el.lowLimits = Array<number>(48).fill(70);
    el.yMin = 40;
    el.yMax = 100;
    await flush(el);

    const labels = Array.from(
      el.shadowRoot!.querySelectorAll('text.axis-label'),
    ).map((n) => n.textContent || '');
    // 3-tick scale: 40, 60, 80, 100. All four must be present as the
    // left-axis (no '%' suffix) labels.
    expect(labels).toContain('40');
    expect(labels).toContain('60');
    expect(labels).toContain('80');
    expect(labels).toContain('100');
  });

  it('honors caller-supplied yMin/yMax for water-heater range (50–150 °F)', async () => {
    const el = mount();
    el.rates = RATES_48;
    el.targetValues = Array<number>(48).fill(120);
    el.highLimits = Array<number>(48).fill(140);
    el.lowLimits = Array<number>(48).fill(110);
    el.yMin = 50;
    el.yMax = 150;
    await flush(el);

    const labels = Array.from(
      el.shadowRoot!.querySelectorAll('text.axis-label'),
    ).map((n) => n.textContent || '');
    expect(labels).toContain('50');
    expect(labels).toContain('150');
  });

  it('ignores yMin/yMax if invalid (NaN, inverted) and falls back to auto-derive', async () => {
    const el = mount();
    el.rates = RATES_48;
    el.targetValues = Array<number>(48).fill(72);
    el.highLimits = Array<number>(48).fill(74);
    el.lowLimits = Array<number>(48).fill(70);
    // Invalid: max < min. Should fall back to auto-derived range from
    // data values (70..74 padded to 68..76).
    el.yMin = 100;
    el.yMax = 50;
    await flush(el);

    const labels = Array.from(
      el.shadowRoot!.querySelectorAll('text.axis-label'),
    ).map((n) => n.textContent || '');
    // The 100 from yMin must not appear as a left-axis tick when the
    // auto-derive path kicked in.
    expect(labels).not.toContain('100');
  });

  it('positions axis title above the top tick label without overlap', async () => {
    const el = mount();
    el.size = 'large';
    el.rates = RATES_48;
    el.targetValues = Array<number>(48).fill(72);
    el.highLimits = Array<number>(48).fill(74);
    el.lowLimits = Array<number>(48).fill(70);
    await flush(el);

    const titleEl = el.shadowRoot!.querySelector('text.axis-title');
    const tickEls = Array.from(
      el.shadowRoot!.querySelectorAll('text.axis-label'),
    );
    expect(titleEl).not.toBeNull();

    // Find the top left-axis tick label (smallest y among labels with
    // text-anchor="end" — those are the left-axis ones).
    const leftAxisTicks = tickEls.filter(
      (t) => t.getAttribute('text-anchor') === 'end',
    );
    expect(leftAxisTicks.length).toBeGreaterThan(0);
    const topTickY = Math.min(
      ...leftAxisTicks.map((t) => Number(t.getAttribute('y') || 0)),
    );
    const titleY = Number(titleEl!.getAttribute('y') || 0);
    // Title baseline must sit clearly above the top tick baseline.
    // (text height ~11px → 8+ px separation prevents overlap.)
    expect(topTickY - titleY).toBeGreaterThanOrEqual(8);
  });

  it('switching size live re-renders with the new viewBox', async () => {
    const el = mount();
    el.size = 'large';
    el.rates = RATES_48;
    el.targetValues = Array<number>(48).fill(72);
    el.highLimits = Array<number>(48).fill(74);
    el.lowLimits = Array<number>(48).fill(70);
    await flush(el);
    expect(viewBoxOf(el)).toEqual({ width: 600, height: 388 });

    el.size = 'small';
    await flush(el);
    expect(viewBoxOf(el)).toEqual({ width: 600, height: 198 });
  });

  describe('scale', () => {
    // Left-axis ticks, bottom to top: end-anchored labels at the smallest x
    // (the x-axis "24" label is end-anchored too, but at the right edge).
    const leftTicks = (el: ChartEl): string[] => {
      const ends = Array.from(el.shadowRoot!.querySelectorAll('text.axis-label')).filter(
        (t) => t.getAttribute('text-anchor') === 'end',
      );
      const x = Math.min(...ends.map((t) => Number(t.getAttribute('x'))));
      return ends
        .filter((t) => Number(t.getAttribute('x')) === x)
        .map((n) => n.textContent || '');
    };

    async function drawHvac(extra: Partial<HmOptimizationChart> = {}): Promise<ChartEl> {
      const el = mount();
      el.rates = RATES_48;
      el.targetValues = Array<number>(48).fill(72);
      el.highLimits = Array<number>(48).fill(74);
      el.lowLimits = Array.from({ length: 48 }, (_, i) => (i < 24 ? 70 : 68));
      el.yMin = 40;
      el.yMax = 100;
      Object.assign(el, extra);
      await flush(el);
      return el;
    }

    it('standard keeps the caller range', async () => {
      const el = await drawHvac();
      expect(leftTicks(el)).toEqual(['40', '60', '80', '100']);
    });

    it('dynamic fits the lowest and highest values with a 10 F standoff', async () => {
      // 68..74 F → 58..84 F
      const el = await drawHvac({ scale: 'dynamic' });
      const ticks = leftTicks(el);
      expect(ticks[0]).toBe('58');
      expect(ticks[ticks.length - 1]).toBe('84');
    });

    it('dynamic uses a 6 C standoff, rounded outward', async () => {
      // 68..74 F = 20.0..23.3 C → floor(14.0)=14 .. ceil(29.3)=30
      const el = await drawHvac({ scale: 'dynamic', displayUnit: 'C' });
      const ticks = leftTicks(el);
      expect(ticks[0]).toBe('14');
      expect(ticks[ticks.length - 1]).toBe('30');
    });

    it('dynamic covers a setpoint that leaves the band', async () => {
      const el = await drawHvac({ scale: 'dynamic', targetValues: Array<number>(48).fill(80) });
      const ticks = leftTicks(el);
      expect(ticks[0]).toBe('58');
      expect(ticks[ticks.length - 1]).toBe('90');
    });

    async function drawSolar(extra: Partial<HmOptimizationChart> = {}): Promise<ChartEl> {
      const el = mount();
      el.rates = RATES_48;
      el.unit = 'kw';
      el.targetValues = Array.from({ length: 48 }, (_, i) => (i >= 16 && i < 36 ? 3.2 : 0));
      el.yMin = 0;
      el.yMax = 8;
      Object.assign(el, extra);
      await flush(el);
      return el;
    }

    it('solar max keeps the system size as the top', async () => {
      const ticks = leftTicks(await drawSolar({ scale: 'max' }));
      expect(ticks[0]).toBe('0.0');
      expect(ticks[ticks.length - 1]).toBe('8.0');
    });

    it('solar dynamic tops out at the day peak plus 25%', async () => {
      // 3.2 kW × 1.25 = 4.0 kW
      const ticks = leftTicks(await drawSolar({ scale: 'dynamic' }));
      expect(ticks[0]).toBe('0.0');
      expect(ticks[ticks.length - 1]).toBe('4.0');
    });

    it('solar dynamic on a zero-generation day falls back to the system size', async () => {
      const ticks = leftTicks(await drawSolar({ scale: 'dynamic', targetValues: Array<number>(48).fill(0) }));
      expect(ticks[ticks.length - 1]).toBe('8.0');
    });

    it('solar axes of 10 kW or more keep whole numbers', async () => {
      const ticks = leftTicks(await drawSolar({ scale: 'max', yMax: 12 }));
      expect(ticks).toEqual(['0', '4', '8', '12']);
    });

    it('draws actuals as separate runs around gaps and relabels the forecast', async () => {
      const actual = Array<number | null>(48).fill(null);
      actual[16] = 1;
      actual[17] = 1.5;
      actual[20] = 2;
      const el = await drawSolar({ actualValues: actual });
      const root = el.shadowRoot!;
      expect(root.querySelectorAll('polyline[data-series="actual"]')).toHaveLength(2);
      const legend = root.querySelector('.legend')!.textContent!;
      expect(legend).toContain('Forecast Generation');
      expect(legend).toContain('Actual Generation');
    });

    it('without actuals keeps the Solar Generation label and no actual line', async () => {
      const el = await drawSolar();
      const root = el.shadowRoot!;
      expect(root.querySelector('polyline[data-series="actual"]')).toBeNull();
      expect(root.querySelector('.legend')!.textContent).toContain('Solar Generation');
    });

    it('raises the max scale when a measured peak beats the system size', async () => {
      const actual = Array<number | null>(48).fill(null);
      actual[24] = 9;
      const ticks = leftTicks(await drawSolar({ scale: 'max', actualValues: actual }));
      expect(ticks[ticks.length - 1]).toBe('9.0');
    });

    it('dynamic scale counts the measured peak', async () => {
      const actual = Array<number | null>(48).fill(null);
      actual[24] = 4;
      // max(3.2, 4) × 1.25 = 5.0
      const ticks = leftTicks(await drawSolar({ scale: 'dynamic', actualValues: actual }));
      expect(ticks[ticks.length - 1]).toBe('5.0');
    });

    it('percent charts ignore dynamic', async () => {
      const mk = async (scale: 'standard' | 'dynamic') => {
        const el = mount();
        el.rates = RATES_48;
        el.targetValues = Array<number>(48).fill(50);
        el.unit = 'percent';
        el.scale = scale;
        await flush(el);
        return el.shadowRoot!.innerHTML;
      };
      expect(await mk('dynamic')).toBe(await mk('standard'));
    });
  });

  describe('displayUnit', () => {
    const HIGH = Array<number>(48).fill(76);
    const LOW = Array<number>(48).fill(68);
    const TARGET = Array.from({ length: 48 }, (_, i) => 70 + (i % 6));

    async function draw(displayUnit?: 'F' | 'C', extra: Partial<HmOptimizationChart> = {}) {
      const el = mount();
      el.rates = RATES_48;
      el.highLimits = HIGH;
      el.lowLimits = LOW;
      el.targetValues = TARGET;
      el.yMin = 40;
      el.yMax = 100;
      Object.assign(el, extra);
      if (displayUnit) el.displayUnit = displayUnit;
      await flush(el);
      return el.shadowRoot!;
    }

    const yPoints = (root: ShadowRoot, series: string): number[] =>
      root
        .querySelector(`polyline[data-series="${series}"]`)!
        .getAttribute('points')!
        .split(' ')
        .map((p) => Number(p.split(',')[1]));

    it('defaults to byte-identical °F output', async () => {
      const a = await draw();
      const b = await draw('F');
      expect(a.innerHTML).toBe(b.innerHTML);
      expect(a.querySelector('.axis-title')!.textContent).toBe('°F');
    });

    it('uses a °C axis title and whole-degree outward bounds', async () => {
      const root = await draw('C');
      expect(root.querySelector('.axis-title')!.textContent).toBe('°C');
      const labels = Array.from(root.querySelectorAll('.axis-label')).map((n) => n.textContent);
      expect(labels).toContain('4');
      expect(labels).toContain('38');
      expect(labels).not.toContain('40');
    });

    it('draws the same line shape in both units', async () => {
      const f = yPoints(await draw('F'), 'target');
      const c = yPoints(await draw('C'), 'target');
      // 40-100 F maps to 4-38 C, which is a slightly different span, so compare
      // normalised position within the plot: same shape within rounding.
      for (let i = 0; i < f.length; i++) expect(Math.abs(f[i] - c[i])).toBeLessThan(12);
      expect(c.indexOf(Math.min(...c))).toBe(f.indexOf(Math.min(...f)));
    });

    it('converts the default marker label', async () => {
      const root = await draw('C', { targetMarker: { interval: 16, value: 77 } });
      expect(root.querySelector('.marker-label')!.textContent).toBe('25° by 08:00');
    });

    it('pads auto-range by about 2 F in C', async () => {
      const root = await draw('C', { yMin: undefined, yMax: undefined });
      const labels = Array.from(root.querySelectorAll('.axis-label')).map((n) => n.textContent);
      // data spans 68..76 F = 20.0..24.4 C, padded 1.1 C each side
      expect(labels).toContain('19');
      expect(labels).toContain('26');
    });

    it('ignores displayUnit for percent charts', async () => {
      const mk = async (du: 'F' | 'C') => {
        const el = mount();
        el.rates = RATES_48;
        el.targetValues = Array<number>(48).fill(50);
        el.unit = 'percent';
        el.displayUnit = du;
        await flush(el);
        return el.shadowRoot!.innerHTML;
      };
      expect(await mk('C')).toBe(await mk('F'));
    });
  });
});
