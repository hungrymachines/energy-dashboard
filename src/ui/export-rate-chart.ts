import { LitElement, css, html, type PropertyValues, type TemplateResult } from 'lit';

const SVG_NS = 'http://www.w3.org/2000/svg';

const HOURS = 24;
const WIDTH = 640;
const HEIGHT = 200;
const PAD = { top: 12, right: 12, bottom: 26, left: 44 };
const PLOT_W = WIDTH - PAD.left - PAD.right;
const PLOT_H = HEIGHT - PAD.top - PAD.bottom;
const AXIS_HOURS = [0, 6, 12, 18, 24];

function hourly(rates: number[]): number[] {
  const out: number[] = [];
  for (let h = 0; h < HOURS; h++) out.push(((rates[h * 2] ?? 0) + (rates[h * 2 + 1] ?? 0)) / 2);
  return out;
}

function isCurve(rates: number[] | null | undefined): rates is number[] {
  return Array.isArray(rates) && rates.length === 48 && rates.every(Number.isFinite);
}

function hourLabel(h: number): string {
  if (h === 12) return '12pm';
  if (h === 0 || h === 24) return '12am';
  return h < 12 ? `${h}am` : `${h - 12}pm`;
}

/**
 * Hourly bars of what exported power earns today, with what the same hour
 * costs to buy as a line. Bars hang below the zero line on a negative price.
 */
export class HmExportRateChart extends LitElement {
  static override styles = css`
    :host {
      display: block;
      width: 100%;
      font-family: var(--hm-font-body, sans-serif);
      color: var(--hm-text, #0F172A);
    }
    svg {
      display: block;
      width: 100%;
      height: auto;
    }
    .bar {
      fill: var(--hm-secondary, #0F766E);
      opacity: 0.7;
    }
    .buy-line {
      fill: none;
      stroke: var(--hm-accent, #F59E0B);
      stroke-width: 2.5;
    }
    .zero {
      stroke: var(--hm-muted, #64748B);
      stroke-width: 1;
    }
    .axis {
      fill: var(--hm-muted, #64748B);
      font-size: 12px;
    }
    .legend {
      display: flex;
      flex-wrap: wrap;
      gap: 16px;
      margin-top: 6px;
      font-size: 13px;
      color: var(--hm-muted, #64748B);
    }
    .legend span {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .swatch {
      width: 16px;
      height: 10px;
      border-radius: 2px;
    }
    .swatch-export {
      background: var(--hm-secondary, #0F766E);
      opacity: 0.7;
    }
    .swatch-buy {
      height: 3px;
      background: var(--hm-accent, #F59E0B);
    }
  `;

  static override properties = {
    exportRates: { attribute: false },
    buyRates: { attribute: false },
    unitLabel: { attribute: false },
  };

  exportRates: number[] | null = null;
  buyRates: number[] | null = null;
  unitLabel = '¢/kWh';

  override render(): TemplateResult {
    if (!isCurve(this.exportRates)) return html``;
    return html`
      <div class="chart"></div>
      <div class="legend">
        <span><i class="swatch swatch-export"></i>Export price (${this.unitLabel})</span>
        ${isCurve(this.buyRates)
          ? html`<span><i class="swatch swatch-buy"></i>Your buy price</span>`
          : null}
      </div>
    `;
  }

  override updated(_changed: PropertyValues): void {
    const container = this.shadowRoot?.querySelector<HTMLDivElement>('.chart');
    if (!container || !isCurve(this.exportRates)) return;
    const bars = hourly(this.exportRates);
    const buy = isCurve(this.buyRates) ? hourly(this.buyRates) : null;
    const all = buy ? [...bars, ...buy] : bars;
    const top = Math.max(1, ...all) * 1.1;
    const bottom = Math.min(0, ...all) * 1.1;
    const y = (v: number): number => PAD.top + ((top - v) / (top - bottom)) * PLOT_H;
    const barW = PLOT_W / HOURS;
    const zero = y(0);

    const root = document.createElementNS(SVG_NS, 'svg');
    root.setAttribute('viewBox', `0 0 ${WIDTH} ${HEIGHT}`);
    root.setAttribute('role', 'img');
    root.setAttribute(
      'aria-label',
      `Export price today, from ${Math.min(...bars).toFixed(1)} to ` +
        `${Math.max(...bars).toFixed(1)} ${this.unitLabel}`,
    );
    const add = (tag: string, cls: string, attrs: Record<string, string | number>): SVGElement => {
      const node = document.createElementNS(SVG_NS, tag);
      node.setAttribute('class', cls);
      for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
      root.appendChild(node);
      return node;
    };

    bars.forEach((v, h) => {
      const yv = y(v);
      add('rect', 'bar', {
        'data-hour': h,
        x: PAD.left + h * barW + 1,
        y: Math.min(yv, zero),
        width: Math.max(barW - 2, 1),
        height: Math.abs(zero - yv),
      });
    });
    if (buy) {
      add('polyline', 'buy-line', {
        points: buy.map((v, h) => `${PAD.left + (h + 0.5) * barW},${y(v)}`).join(' '),
      });
    }
    add('line', 'zero', { x1: PAD.left, x2: WIDTH - PAD.right, y1: zero, y2: zero });

    const label = (text: string, attrs: Record<string, string | number>): void => {
      add('text', 'axis', attrs).textContent = text;
    };
    const yLabel = { x: PAD.left - 6, 'text-anchor': 'end' };
    label(top.toFixed(0), { ...yLabel, y: y(top) + 10 });
    label('0', { ...yLabel, y: zero + 4 });
    if (bottom < 0) label(bottom.toFixed(0), { ...yLabel, y: y(bottom) });
    for (const h of AXIS_HOURS) {
      label(hourLabel(h), {
        x: PAD.left + (h / HOURS) * PLOT_W,
        y: HEIGHT - 6,
        'text-anchor': h === 0 ? 'start' : h === 24 ? 'end' : 'middle',
      });
    }
    container.replaceChildren(root);
  }
}
