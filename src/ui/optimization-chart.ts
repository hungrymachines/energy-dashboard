import { LitElement, html, css, type PropertyValues } from 'lit';

/**
 * `<hm-optimization-chart>`
 *
 * User-facing 24-hour optimization plot. Renders three line series over a
 * background bar chart of hourly electricity prices:
 *
 *   • `highLimits`   — upper bound (dashed red) — e.g. comfort high or tank max
 *   • `lowLimits`    — lower bound (dashed teal) — e.g. comfort low, tank min,
 *                      or the EV/battery minimum-charge line
 *   • `targetValues` — the optimizer's predicted state trajectory (solid blue):
 *                      indoor temp for HVAC, tank temp for water heater,
 *                      state-of-charge % for EV / battery
 *
 * Optional `targetMarker` annotates a single (interval, value) point — used
 * for EV/battery to draw "70% by 08:00" at the user's deadline.
 *
 * `unit` controls y-axis formatting and legend wording:
 *   • `'fahrenheit'` (default) — °F axis, "Optimized Temperature" wording
 *   • `'percent'`    — 0-100 % axis, "Optimized Charge" wording
 *
 * Inputs are 48-element half-hourly arrays (matching the API schedule shape).
 * The rate bars are decimated to 24 hourly bars for visual clarity. Built
 * with native SVG (no Chart.js dep) to keep the bundle tiny.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const HALF_HOUR_SLOTS = 48;
const HOURLY_BARS = 24;

export type OptimizationChartUnit = 'fahrenheit' | 'percent';

export interface OptimizationChartMarker {
  /** 0-47 half-hour slot of the deadline (e.g. 16 = 08:00). */
  interval: number;
  /** Target value (e.g. 70 for "70%"). */
  value: number;
  /** Optional callout text. Auto-generated from unit + interval if omitted. */
  label?: string;
}

export class HmOptimizationChart extends LitElement {
  static override styles = css`
    :host {
      display: block;
      width: 100%;
      font-family: var(--hm-font-body, sans-serif);
      color: var(--hm-text, #0F172A);
    }
    .chart {
      width: 100%;
    }
    svg {
      display: block;
      width: 100%;
      height: auto;
      overflow: visible;
    }
    .price-bar {
      fill: var(--hm-accent, #F59E0B);
      fill-opacity: 0.32;
    }
    .grid {
      stroke: rgba(100, 116, 139, 0.18);
      stroke-width: 0.5;
    }
    .axis-label {
      fill: var(--hm-muted, #64748B);
      font-size: 10px;
    }
    .axis-title {
      fill: var(--hm-muted, #64748B);
      font-size: 10px;
      font-weight: 600;
    }
    .high-limit {
      fill: none;
      stroke: var(--hm-error, #DC2626);
      stroke-width: 1.5;
      stroke-dasharray: 4 3;
    }
    .low-limit {
      fill: none;
      stroke: var(--hm-secondary, #0F766E);
      stroke-width: 1.5;
      stroke-dasharray: 4 3;
    }
    .target {
      fill: none;
      stroke: var(--hm-primary, #1E3A8A);
      stroke-width: 2;
    }
    .marker-dot {
      fill: var(--hm-primary, #1E3A8A);
      stroke: var(--hm-bg, #FFFFFF);
      stroke-width: 1.5;
    }
    .marker-line {
      stroke: var(--hm-primary, #1E3A8A);
      stroke-width: 1;
      stroke-dasharray: 2 2;
      opacity: 0.6;
    }
    .marker-label {
      fill: var(--hm-primary, #1E3A8A);
      font-size: 10px;
      font-weight: 600;
    }
    .legend {
      display: flex;
      flex-wrap: wrap;
      gap: 16px;
      justify-content: center;
      margin-top: 8px;
      font-size: 12px;
      color: var(--hm-text, #0F172A);
    }
    .legend-item {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .legend-swatch {
      display: inline-block;
      width: 14px;
      height: 4px;
      border-radius: 1px;
    }
    .swatch-target {
      background: var(--hm-primary, #1E3A8A);
    }
    .swatch-high {
      background: repeating-linear-gradient(
        to right,
        var(--hm-error, #DC2626) 0 4px,
        transparent 4px 7px
      );
    }
    .swatch-low {
      background: repeating-linear-gradient(
        to right,
        var(--hm-secondary, #0F766E) 0 4px,
        transparent 4px 7px
      );
    }
    .swatch-price {
      width: 14px;
      height: 10px;
      background: var(--hm-accent, #F59E0B);
      opacity: 0.4;
      border-radius: 2px;
    }
    .empty {
      padding: 12px;
      color: var(--hm-muted, #64748B);
      font-size: 13px;
    }
  `;

  static override properties = {
    rates: { attribute: false },
    highLimits: { attribute: false },
    lowLimits: { attribute: false },
    targetValues: { attribute: false },
    targetMarker: { attribute: false },
    unit: { attribute: false },
  };

  rates: number[] = [];
  highLimits: number[] | undefined = undefined;
  lowLimits: number[] | undefined = undefined;
  targetValues: number[] | undefined = undefined;
  targetMarker: OptimizationChartMarker | undefined = undefined;
  unit: OptimizationChartUnit = 'fahrenheit';

  override render() {
    const isPercent = this.unit === 'percent';
    const targetLabel = isPercent ? 'Optimized Charge' : 'Optimized Temperature';
    const highShown = this._isFiniteArray(this.highLimits);
    const lowShown = this._isFiniteArray(this.lowLimits);
    const highLabel = isPercent ? 'Maximum' : 'High Limit';
    const lowLabel = isPercent ? 'Minimum Charge' : 'Low Limit';
    return html`
      <div class="chart" aria-label="Optimization schedule"></div>
      <div class="legend" aria-hidden="false">
        <span class="legend-item">
          <span class="legend-swatch swatch-target" aria-hidden="true"></span>
          ${targetLabel}
        </span>
        ${highShown
          ? html`<span class="legend-item">
              <span class="legend-swatch swatch-high" aria-hidden="true"></span>
              ${highLabel}
            </span>`
          : ''}
        ${lowShown
          ? html`<span class="legend-item">
              <span class="legend-swatch swatch-low" aria-hidden="true"></span>
              ${lowLabel}
            </span>`
          : ''}
        <span class="legend-item">
          <span class="legend-swatch swatch-price" aria-hidden="true"></span>
          Electricity Price
        </span>
      </div>
    `;
  }

  override updated(_changed: PropertyValues): void {
    this._redraw();
  }

  private _redraw(): void {
    const root = this.shadowRoot;
    if (!root) return;
    const container = root.querySelector<HTMLDivElement>('.chart');
    if (!container) return;
    container.replaceChildren();

    if (!Array.isArray(this.rates) || this.rates.length !== HALF_HOUR_SLOTS) {
      const msg = document.createElement('div');
      msg.className = 'empty';
      msg.textContent = 'Optimization data not yet available.';
      container.appendChild(msg);
      return;
    }

    const hasLines =
      this._isFiniteArray(this.highLimits) ||
      this._isFiniteArray(this.lowLimits) ||
      this._isFiniteArray(this.targetValues);
    if (!hasLines) {
      const msg = document.createElement('div');
      msg.className = 'empty';
      msg.textContent =
        this.unit === 'percent'
          ? 'No charge plan available yet — try again after the next nightly run.'
          : 'No temperature plan available yet — try again after the next nightly run.';
      container.appendChild(msg);
      return;
    }

    // SVG layout. Use a viewBox so the chart scales fluidly with the host.
    const width = 600;
    const height = 220;
    const padTop = 16;
    const padBottom = 28;
    const padLeft = 36;
    const padRight = 40;
    const plotWidth = width - padLeft - padRight;
    const plotHeight = height - padTop - padBottom;

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('role', 'img');
    svg.setAttribute(
      'aria-label',
      this.unit === 'percent'
        ? 'Optimized charge schedule'
        : 'Optimized temperature schedule',
    );
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.setAttribute('xmlns', SVG_NS);

    // --- Y-axis ranges --------------------------------------------------
    // For percent: pin to [0, 100] so charge curves are interpretable
    // across appliances. For fahrenheit: derive from the union of all
    // plotted line values, padded ±2°F.
    let yMin: number;
    let yMax: number;
    if (this.unit === 'percent') {
      yMin = 0;
      yMax = 100;
    } else {
      const tempValues: number[] = [];
      for (const arr of [this.highLimits, this.lowLimits, this.targetValues]) {
        if (this._isFiniteArray(arr)) tempValues.push(...arr);
      }
      yMin = Math.min(...tempValues);
      yMax = Math.max(...tempValues);
      if (yMax - yMin < 4) {
        const center = (yMax + yMin) / 2;
        yMin = center - 4;
        yMax = center + 4;
      } else {
        yMin -= 2;
        yMax += 2;
      }
    }

    // Price range — clamp to non-negative; pad top so bars never reach the
    // chart ceiling.
    const priceMax = Math.max(...this.rates) / 100; // cents → dollars/kWh
    const priceTop = Math.max(0.1, priceMax * 1.15);

    const valueY = (v: number): number =>
      padTop + plotHeight - ((v - yMin) / (yMax - yMin)) * plotHeight;
    const priceY = (v: number): number =>
      padTop + plotHeight - (v / priceTop) * plotHeight;

    // --- Hourly price bars ---------------------------------------------
    const barWidth = plotWidth / HOURLY_BARS;
    const barInner = Math.max(barWidth - 1.5, 1);
    for (let h = 0; h < HOURLY_BARS; h++) {
      // Average the two half-hour slots in this hour for the display value.
      const a = this.rates[h * 2] ?? 0;
      const b = this.rates[h * 2 + 1] ?? a;
      const dollars = ((a + b) / 2) / 100;
      const yTop = priceY(dollars);
      const rect = document.createElementNS(SVG_NS, 'rect');
      rect.setAttribute('class', 'price-bar');
      rect.setAttribute('data-hour', String(h));
      rect.setAttribute('x', String(padLeft + h * barWidth + (barWidth - barInner) / 2));
      rect.setAttribute('y', String(yTop));
      rect.setAttribute('width', String(barInner));
      rect.setAttribute('height', String(padTop + plotHeight - yTop));
      svg.appendChild(rect);
    }

    // --- Gridlines (subtle) --------------------------------------------
    for (let h = 0; h <= 24; h += 4) {
      const x = padLeft + (h / 24) * plotWidth;
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('class', 'grid');
      line.setAttribute('x1', String(x));
      line.setAttribute('x2', String(x));
      line.setAttribute('y1', String(padTop));
      line.setAttribute('y2', String(padTop + plotHeight));
      svg.appendChild(line);
    }

    // --- Line series ----------------------------------------------------
    // Lines are plotted using all 48 half-hour points for smoothness.
    // Each x-coordinate is centered in its half-hour slot.
    const slotX = (i: number): number =>
      padLeft + ((i + 0.5) / HALF_HOUR_SLOTS) * plotWidth;

    const drawLine = (
      values: number[] | undefined,
      cls: 'high-limit' | 'low-limit' | 'target',
    ): void => {
      if (!this._isFiniteArray(values)) return;
      const points: string[] = [];
      // Pad / decimate to 48 points if the input is 24-hourly.
      const expanded = values.length === HALF_HOUR_SLOTS ? values : this._expand24To48(values);
      if (expanded.length !== HALF_HOUR_SLOTS) return;
      for (let i = 0; i < HALF_HOUR_SLOTS; i++) {
        points.push(`${slotX(i)},${valueY(expanded[i])}`);
      }
      const polyline = document.createElementNS(SVG_NS, 'polyline');
      polyline.setAttribute('class', cls);
      polyline.setAttribute('data-series', cls);
      polyline.setAttribute('points', points.join(' '));
      svg.appendChild(polyline);
    };

    drawLine(this.highLimits, 'high-limit');
    drawLine(this.lowLimits, 'low-limit');
    drawLine(this.targetValues, 'target');

    // --- Optional target marker (e.g. "70% at 08:00") -------------------
    if (this._isMarkerValid(this.targetMarker)) {
      const m = this.targetMarker as OptimizationChartMarker;
      const cx = slotX(m.interval);
      const cy = valueY(m.value);

      const drop = document.createElementNS(SVG_NS, 'line');
      drop.setAttribute('class', 'marker-line');
      drop.setAttribute('x1', String(cx));
      drop.setAttribute('x2', String(cx));
      drop.setAttribute('y1', String(cy));
      drop.setAttribute('y2', String(padTop + plotHeight));
      svg.appendChild(drop);

      const dot = document.createElementNS(SVG_NS, 'circle');
      dot.setAttribute('class', 'marker-dot');
      dot.setAttribute('data-marker', 'target');
      dot.setAttribute('cx', String(cx));
      dot.setAttribute('cy', String(cy));
      dot.setAttribute('r', '3.5');
      svg.appendChild(dot);

      const labelText = m.label ?? this._defaultMarkerLabel(m);
      const label = document.createElementNS(SVG_NS, 'text');
      label.setAttribute('class', 'marker-label');
      // Anchor right of midline, left of right edge. Flip if too close.
      const anchorRight = cx > padLeft + plotWidth * 0.7;
      label.setAttribute('x', String(anchorRight ? cx - 6 : cx + 6));
      label.setAttribute('y', String(Math.max(cy - 6, padTop + 8)));
      label.setAttribute('text-anchor', anchorRight ? 'end' : 'start');
      label.textContent = labelText;
      svg.appendChild(label);
    }

    // --- X axis: hour labels every 4 hours -----------------------------
    for (const h of [0, 4, 8, 12, 16, 20, 24]) {
      const x = padLeft + (h / 24) * plotWidth;
      const lbl = document.createElementNS(SVG_NS, 'text');
      lbl.setAttribute('class', 'axis-label');
      lbl.setAttribute('x', String(x));
      lbl.setAttribute('y', String(padTop + plotHeight + 16));
      lbl.setAttribute('text-anchor', h === 0 ? 'start' : h === 24 ? 'end' : 'middle');
      lbl.textContent = `${String(h % 24).padStart(2, '0')}:00`;
      svg.appendChild(lbl);
    }

    // --- Y axis labels -------------------------------------------------
    // Left axis: temperature/percent (3 ticks). Right axis: price (3 ticks).
    const yTicks = 3;
    for (let t = 0; t <= yTicks; t++) {
      const v = yMin + ((yMax - yMin) * t) / yTicks;
      const y = valueY(v);
      const lbl = document.createElementNS(SVG_NS, 'text');
      lbl.setAttribute('class', 'axis-label');
      lbl.setAttribute('x', String(padLeft - 4));
      lbl.setAttribute('y', String(y + 3));
      lbl.setAttribute('text-anchor', 'end');
      lbl.textContent = this.unit === 'percent' ? `${Math.round(v)}%` : `${Math.round(v)}`;
      svg.appendChild(lbl);
    }

    const priceTicks = 3;
    for (let t = 0; t <= priceTicks; t++) {
      const v = (priceTop * t) / priceTicks;
      const y = priceY(v);
      const lbl = document.createElementNS(SVG_NS, 'text');
      lbl.setAttribute('class', 'axis-label');
      lbl.setAttribute('x', String(padLeft + plotWidth + 4));
      lbl.setAttribute('y', String(y + 3));
      lbl.setAttribute('text-anchor', 'start');
      lbl.textContent = `$${v.toFixed(2)}`;
      svg.appendChild(lbl);
    }

    // Axis titles
    const yTitle = document.createElementNS(SVG_NS, 'text');
    yTitle.setAttribute('class', 'axis-title');
    yTitle.setAttribute('x', String(padLeft - 24));
    yTitle.setAttribute('y', String(padTop - 4));
    yTitle.setAttribute('text-anchor', 'start');
    yTitle.textContent = this.unit === 'percent' ? '%' : '°F';
    svg.appendChild(yTitle);

    const priceTitle = document.createElementNS(SVG_NS, 'text');
    priceTitle.setAttribute('class', 'axis-title');
    priceTitle.setAttribute('x', String(padLeft + plotWidth + 4));
    priceTitle.setAttribute('y', String(padTop - 4));
    priceTitle.setAttribute('text-anchor', 'start');
    priceTitle.textContent = '$/kWh';
    svg.appendChild(priceTitle);

    container.appendChild(svg);
  }

  private _isFiniteArray(v: unknown): v is number[] {
    return (
      Array.isArray(v) &&
      v.length > 0 &&
      v.every((n) => typeof n === 'number' && Number.isFinite(n))
    );
  }

  private _expand24To48(values: number[]): number[] {
    if (values.length !== 24) return [];
    const out: number[] = new Array(48);
    for (let i = 0; i < 24; i++) {
      out[i * 2] = values[i];
      out[i * 2 + 1] = values[i];
    }
    return out;
  }

  private _isMarkerValid(m: OptimizationChartMarker | undefined): boolean {
    if (!m) return false;
    return (
      Number.isInteger(m.interval) &&
      m.interval >= 0 &&
      m.interval < HALF_HOUR_SLOTS &&
      typeof m.value === 'number' &&
      Number.isFinite(m.value)
    );
  }

  private _defaultMarkerLabel(m: OptimizationChartMarker): string {
    const hour = Math.floor(m.interval / 2);
    const minute = m.interval % 2 === 0 ? '00' : '30';
    const time = `${String(hour).padStart(2, '0')}:${minute}`;
    if (this.unit === 'percent') {
      return `${Math.round(m.value)}% by ${time}`;
    }
    return `${Math.round(m.value)}° by ${time}`;
  }
}
