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
});
