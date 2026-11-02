import { describe, it, expect, afterEach } from 'vitest';
import { HmExportRateChart } from '../src/ui/export-rate-chart.js';
import { HmOptimizationChart } from '../src/ui/optimization-chart.js';

if (!customElements.get('hm-export-rate-chart')) {
  customElements.define('hm-export-rate-chart', HmExportRateChart);
}
if (!customElements.get('hm-optimization-chart')) {
  customElements.define('hm-optimization-chart', HmOptimizationChart);
}

async function mount(
  exportRates: number[] | null,
  buyRates: number[] | null = null,
): Promise<HmExportRateChart> {
  const el = document.createElement('hm-export-rate-chart') as HmExportRateChart;
  el.exportRates = exportRates;
  el.buyRates = buyRates;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('hm-export-rate-chart', () => {
  it('draws one bar per hour with a line for the buy price', async () => {
    const el = await mount(Array<number>(48).fill(4), Array<number>(48).fill(12));
    const root = el.shadowRoot!;

    expect(root.querySelectorAll('rect.bar').length).toBe(24);
    expect(root.querySelector('polyline.buy-line')).not.toBeNull();
    expect(root.textContent).toContain('Your buy price');
  });

  it('omits the line without a buy curve', async () => {
    const el = await mount(Array<number>(48).fill(4));
    expect(el.shadowRoot!.querySelector('polyline.buy-line')).toBeNull();
  });

  it('keeps every bar height non-negative on a negative price', async () => {
    const rates = Array<number>(48).fill(4);
    rates[20] = -3;
    rates[21] = -3;
    const el = await mount(rates);

    const heights = [...el.shadowRoot!.querySelectorAll('rect.bar')].map((r) =>
      Number(r.getAttribute('height')),
    );
    expect(heights.every((h) => Number.isFinite(h) && h >= 0)).toBe(true);
    const bar = el.shadowRoot!.querySelector('rect.bar[data-hour="10"]')!;
    const other = el.shadowRoot!.querySelector('rect.bar[data-hour="9"]')!;
    expect(Number(bar.getAttribute('y'))).toBeGreaterThan(Number(other.getAttribute('y')));
  });

  it('renders nothing without a full curve', async () => {
    const el = await mount([1, 2, 3]);
    expect(el.shadowRoot!.querySelector('svg')).toBeNull();
  });
});

describe('hm-optimization-chart negative price', () => {
  it('draws no negative-height bar and takes a price label', async () => {
    const el = document.createElement('hm-optimization-chart') as HmOptimizationChart;
    el.rates = Array<number>(48).fill(-2);
    el.targetValues = Array<number>(48).fill(1);
    el.unit = 'kw';
    el.priceLabel = 'Export Price';
    document.body.appendChild(el);
    await el.updateComplete;

    const heights = [...el.shadowRoot!.querySelectorAll('rect.price-bar')].map((r) =>
      Number(r.getAttribute('height')),
    );
    expect(heights.length).toBe(24);
    expect(heights.every((h) => h >= 0)).toBe(true);
    expect(el.shadowRoot!.textContent).toContain('Export Price');
  });
});
