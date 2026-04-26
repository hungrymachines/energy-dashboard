import { LitElement, html, css, type PropertyValues } from 'lit';

type Tier = 'low' | 'mid' | 'high';

const INTERVAL_COUNT = 48;
const SVG_NS = 'http://www.w3.org/2000/svg';

export class HmScheduleChart extends LitElement {
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
      max-width: 100%;
      overflow: visible;
    }
    .rate-bar[data-tier='low'] {
      fill: var(--hm-secondary, #0F766E);
    }
    .rate-bar[data-tier='mid'] {
      fill: var(--hm-muted, #64748B);
    }
    .rate-bar[data-tier='high'] {
      fill: var(--hm-error, #DC2626);
    }
    .boolean-active {
      fill: var(--hm-accent, #F59E0B);
    }
    .temp-band {
      fill: var(--hm-secondary, #0F766E);
      fill-opacity: 0.18;
    }
    .comfort-band {
      fill: var(--hm-accent, #F59E0B);
      fill-opacity: 0.25;
      stroke: var(--hm-accent, #F59E0B);
      stroke-opacity: 0.5;
      stroke-width: 0.5;
    }
    .trajectory {
      fill: none;
      stroke: var(--hm-primary, #1E3A8A);
      stroke-width: 1.5;
      stroke-linejoin: round;
    }
    .axis-label {
      fill: var(--hm-muted, #64748B);
      font-size: 10px;
    }
    .axis-label-y {
      fill: var(--hm-muted, #64748B);
      font-size: 9px;
    }
    .empty {
      padding: 12px;
      color: var(--hm-muted, #64748B);
      font-size: 13px;
    }
  `;

  static override properties = {
    rates: { attribute: false },
    highTemps: { attribute: false },
    lowTemps: { attribute: false },
    comfortHighs: { attribute: false },
    comfortLows: { attribute: false },
    booleanSchedule: { attribute: false },
    trajectory: { attribute: false },
    unit: { attribute: false },
  };

  rates: number[] = [];
  highTemps: number[] | undefined = undefined;
  lowTemps: number[] | undefined = undefined;
  comfortHighs: number[] | undefined = undefined;
  comfortLows: number[] | undefined = undefined;
  booleanSchedule: boolean[] | undefined = undefined;
  trajectory: number[] | undefined = undefined;
  unit: string | undefined = undefined;

  private _lastWarnedLength: number | null = null;
  private _lastWarnedComfortLength: number | null = null;

  override render() {
    return html`<div class="chart" aria-live="polite"></div>`;
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

    if (!Array.isArray(this.rates) || this.rates.length !== INTERVAL_COUNT) {
      const reported = Array.isArray(this.rates) ? this.rates.length : -1;
      if (reported !== this._lastWarnedLength) {
        this._lastWarnedLength = reported;
        const got = Array.isArray(this.rates)
          ? `length ${this.rates.length}`
          : typeof this.rates;
        console.warn(
          `hm-schedule-chart: rates must be an array of length 48 (got ${got})`,
        );
      }
      return;
    }
    this._lastWarnedLength = null;

    const width = 480;
    const barWidth = width / INTERVAL_COUNT;
    const barInner = Math.max(barWidth - 0.5, 0.5);

    const hasTemps =
      Array.isArray(this.highTemps) &&
      Array.isArray(this.lowTemps) &&
      this.highTemps.length === INTERVAL_COUNT &&
      this.lowTemps.length === INTERVAL_COUNT;
    const hasTrajectory =
      Array.isArray(this.trajectory) &&
      this.trajectory.length === INTERVAL_COUNT;
    const hasBoolean =
      Array.isArray(this.booleanSchedule) &&
      this.booleanSchedule.length === INTERVAL_COUNT;

    const comfortDefined =
      Array.isArray(this.comfortHighs) || Array.isArray(this.comfortLows);
    const comfortLenOk =
      Array.isArray(this.comfortHighs) &&
      Array.isArray(this.comfortLows) &&
      this.comfortHighs.length === INTERVAL_COUNT &&
      this.comfortLows.length === INTERVAL_COUNT;
    const hasComfort = comfortLenOk;
    if (comfortDefined && !comfortLenOk) {
      const reportedLen = Array.isArray(this.comfortHighs)
        ? this.comfortHighs.length
        : Array.isArray(this.comfortLows)
          ? this.comfortLows.length
          : -1;
      if (reportedLen !== this._lastWarnedComfortLength) {
        this._lastWarnedComfortLength = reportedLen;
        console.warn(
          `hm-schedule-chart: comfortHighs and comfortLows must each be arrays of length 48 (got ${reportedLen})`,
        );
      }
    } else if (hasComfort) {
      this._lastWarnedComfortLength = null;
    }

    const hasOverlay = hasTemps || hasTrajectory || hasComfort;

    const overlayHeight = hasOverlay ? 60 : 0;
    const booleanHeight = hasBoolean ? 6 : 0;
    const booleanGap = hasBoolean ? 2 : 0;
    const rateHeight = 24;
    const axisHeight = 18;
    const leftPad = hasOverlay ? 28 : 0;
    const viewWidth = width + leftPad;

    const overlayTop = 0;
    const booleanTop = overlayTop + overlayHeight;
    const rateTop = booleanTop + booleanHeight + booleanGap;
    const axisTop = rateTop + rateHeight;
    const totalHeight = axisTop + axisHeight;

    const overlayValues: number[] = [];
    if (hasTemps) {
      for (const v of this.highTemps!) overlayValues.push(v);
      for (const v of this.lowTemps!) overlayValues.push(v);
    }
    if (hasTrajectory) {
      for (const v of this.trajectory!) overlayValues.push(v);
    }
    if (hasComfort) {
      for (const v of this.comfortHighs!) overlayValues.push(v);
      for (const v of this.comfortLows!) overlayValues.push(v);
    }
    let overlayMin = 0;
    let overlayMax = 1;
    if (overlayValues.length > 0) {
      overlayMin = Math.min(...overlayValues);
      overlayMax = Math.max(...overlayValues);
      if (overlayMin === overlayMax) overlayMax = overlayMin + 1;
    }

    const scaleY = (value: number): number =>
      overlayTop +
      overlayHeight -
      ((value - overlayMin) / (overlayMax - overlayMin)) * overlayHeight;

    const minRate = Math.min(...this.rates);
    const maxRate = Math.max(...this.rates);
    const range = maxRate - minRate;
    const lowThreshold = minRate + range / 3;
    const highThreshold = minRate + (range * 2) / 3;
    const tierOf = (v: number): Tier => {
      if (range === 0) return 'mid';
      if (v <= lowThreshold) return 'low';
      if (v >= highThreshold) return 'high';
      return 'mid';
    };

    const svgEl = document.createElementNS(SVG_NS, 'svg');
    svgEl.setAttribute('viewBox', `0 0 ${viewWidth} ${totalHeight}`);
    svgEl.setAttribute('role', 'img');
    svgEl.setAttribute('aria-label', 'Schedule timeline');
    svgEl.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svgEl.setAttribute('xmlns', SVG_NS);

    if (hasComfort) {
      for (let i = 0; i < INTERVAL_COUNT; i++) {
        const hi = this.comfortHighs![i]!;
        const lo = this.comfortLows![i]!;
        const yTop = scaleY(Math.max(hi, lo));
        const yBot = scaleY(Math.min(hi, lo));
        const rect = document.createElementNS(SVG_NS, 'rect');
        rect.setAttribute('class', 'comfort-band');
        rect.setAttribute('data-index', String(i));
        rect.setAttribute('x', String(leftPad + i * barWidth));
        rect.setAttribute('y', String(yTop));
        rect.setAttribute('width', String(barInner));
        rect.setAttribute('height', String(Math.max(yBot - yTop, 1)));
        svgEl.appendChild(rect);
      }
    }

    if (hasTemps) {
      for (let i = 0; i < INTERVAL_COUNT; i++) {
        const hi = this.highTemps![i]!;
        const lo = this.lowTemps![i]!;
        const yTop = scaleY(Math.max(hi, lo));
        const yBot = scaleY(Math.min(hi, lo));
        const rect = document.createElementNS(SVG_NS, 'rect');
        rect.setAttribute('class', 'temp-band');
        rect.setAttribute('data-index', String(i));
        rect.setAttribute('x', String(leftPad + i * barWidth));
        rect.setAttribute('y', String(yTop));
        rect.setAttribute('width', String(barInner));
        rect.setAttribute('height', String(Math.max(yBot - yTop, 1)));
        svgEl.appendChild(rect);
      }
    }

    if (hasTrajectory) {
      const line = document.createElementNS(SVG_NS, 'polyline');
      line.setAttribute('class', 'trajectory');
      const points = this.trajectory!
        .map(
          (v, i) =>
            `${leftPad + i * barWidth + barInner / 2},${scaleY(v)}`,
        )
        .join(' ');
      line.setAttribute('points', points);
      svgEl.appendChild(line);
    }

    if (hasBoolean) {
      for (let i = 0; i < INTERVAL_COUNT; i++) {
        if (!this.booleanSchedule![i]) continue;
        const rect = document.createElementNS(SVG_NS, 'rect');
        rect.setAttribute('class', 'boolean-active');
        rect.setAttribute('data-index', String(i));
        rect.setAttribute('x', String(leftPad + i * barWidth));
        rect.setAttribute('y', String(booleanTop));
        rect.setAttribute('width', String(barInner));
        rect.setAttribute('height', String(booleanHeight));
        svgEl.appendChild(rect);
      }
    }

    for (let i = 0; i < INTERVAL_COUNT; i++) {
      const v = this.rates[i]!;
      const rect = document.createElementNS(SVG_NS, 'rect');
      rect.setAttribute('class', 'rate-bar');
      rect.setAttribute('data-tier', tierOf(v));
      rect.setAttribute('data-index', String(i));
      rect.setAttribute('x', String(leftPad + i * barWidth));
      rect.setAttribute('y', String(rateTop));
      rect.setAttribute('width', String(barInner));
      rect.setAttribute('height', String(rateHeight));
      svgEl.appendChild(rect);
    }

    const hours = [0, 6, 12, 18, 24];
    for (const h of hours) {
      const cx = leftPad + (h / 24) * width;
      const text = document.createElementNS(SVG_NS, 'text');
      text.setAttribute('class', 'axis-label');
      text.setAttribute('x', String(cx));
      text.setAttribute('y', String(axisTop + 12));
      text.setAttribute(
        'text-anchor',
        h === 0 ? 'start' : h === 24 ? 'end' : 'middle',
      );
      text.textContent = String(h);
      svgEl.appendChild(text);
    }

    if (hasOverlay) {
      const labelHigh = document.createElementNS(SVG_NS, 'text');
      labelHigh.setAttribute('class', 'axis-label-y');
      labelHigh.setAttribute('x', String(leftPad - 4));
      labelHigh.setAttribute('y', String(overlayTop + 8));
      labelHigh.setAttribute('text-anchor', 'end');
      labelHigh.textContent = this._formatY(overlayMax);
      svgEl.appendChild(labelHigh);

      const labelLow = document.createElementNS(SVG_NS, 'text');
      labelLow.setAttribute('class', 'axis-label-y');
      labelLow.setAttribute('x', String(leftPad - 4));
      labelLow.setAttribute('y', String(overlayTop + overlayHeight));
      labelLow.setAttribute('text-anchor', 'end');
      labelLow.textContent = this._formatY(overlayMin);
      svgEl.appendChild(labelLow);
    }

    container.appendChild(svgEl);
  }

  private _formatY(v: number): string {
    if (this.unit === 'percent') return `${Math.round(v)}%`;
    return `${Math.round(v)}`;
  }
}
