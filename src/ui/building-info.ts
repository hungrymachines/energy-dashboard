import { LitElement, html, css } from 'lit';
import type { TemplateResult } from 'lit';
import { getDailyMetrics, getMetricsSummary } from '../api/me-metrics.js';
import type { DailyResponse, MetricsSummary } from '../api/me-metrics.js';
import { ALL_TYPES, TYPE_NAMES } from '../utils/appliance-types.js';
import { formatDelta, temperatureUnitStore } from '../utils/temperature.js';
import type { TempUnit } from '../utils/temperature.js';

/** A missing metric shows a dash, never a made-up zero. */
const EM_DASH = '—';
const WINDOW_DAYS = 30;
const SVG_NS = 'http://www.w3.org/2000/svg';

/** The machine types the coverage list reports against (dehumidifier is data-only). */
const MACHINE_TYPES: ReadonlyArray<{ key: string; label: string }> = ALL_TYPES.map((t) => ({
  key: t,
  label: TYPE_NAMES[t] ?? t,
}));

const money = (n: number | null): string => (n === null ? EM_DASH : `$${n.toFixed(2)}`);
const percent = (n: number | null): string => (n === null ? EM_DASH : `${n.toFixed(1)}%`);
const hours = (n: number | null): string => (n === null ? EM_DASH : `${n.toFixed(1)} h`);
const degreeHours = (n: number | null, unit: TempUnit): string =>
  n === null ? EM_DASH : `${formatDelta(n, unit, 0)}·h`;

/** "6 PM", "12 AM", "12 PM". */
export function formatHour(h: number): string {
  if (h === 0) return '12 AM';
  if (h === 12) return '12 PM';
  return h < 12 ? `${h} AM` : `${h - 12} PM`;
}

function svgEl(name: string, attrs: Record<string, string | number>): SVGElement {
  const el = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/**
 * `<hm-building-info>` - the customer's own savings and performance numbers:
 * the same tiles, wording and charts the website shows, without a second
 * sign-in. Charts are drawn with createElementNS in `updated()` because
 * happy-dom drops SVG inside Lit templates.
 */
export class HmBuildingInfo extends LitElement {
  static override styles = css`
    :host { display: block; font-family: var(--hm-font-body, sans-serif); color: var(--hm-text, #0F172A); }
    .banner { padding: 12px 14px; border-radius: 8px; font-size: 14px; background: rgba(100,116,139,0.08); color: #475569; }
    .banner button { margin-left: 8px; }
    h2 { margin: 0; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--hm-muted, #64748B); }
    .window { margin: 4px 0 12px; font-size: 12px; color: var(--hm-muted, #64748B); }
    .tiles { display: grid; grid-template-columns: 1fr; gap: 12px; }
    @media (min-width: 700px) { .tiles { grid-template-columns: 1fr 1fr; } }
    .tile, .panel { padding: 14px; border-radius: 8px; border: 1px solid rgba(100,116,139,0.25); background: #fafbfc; }
    .panel { margin-top: 12px; }
    h3 { margin: 0; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: var(--hm-muted, #64748B); }
    .big { margin: 8px 0 0; font-size: 24px; font-weight: 600; font-variant-numeric: tabular-nums; }
    .pair { margin-top: 8px; display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .pair .v { font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; }
    .label { font-size: 12px; color: var(--hm-muted, #64748B); }
    .note { margin: 6px 0 0; font-size: 12px; line-height: 1.45; color: var(--hm-muted, #64748B); }
    .note.warn { color: #92400E; }
    .missing { color: var(--hm-muted, #64748B); }
    ul { margin: 10px 0 0; padding: 0; list-style: none; font-size: 14px; }
    li { display: flex; justify-content: space-between; padding: 2px 0; }
    li.off { color: var(--hm-muted, #64748B); }
    .chart svg { display: block; width: 100%; height: auto; }
    .bars { display: flex; align-items: flex-end; gap: 2px; height: 48px; margin-top: 10px; }
    .bars svg { width: 100%; height: 48px; }
    .ticks { display: flex; justify-content: space-between; font-size: 10px; color: var(--hm-muted, #64748B); }
    .legend { margin-top: 4px; font-size: 12px; color: var(--hm-muted, #64748B); }
    .legend .sw { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin: 0 4px 0 10px; vertical-align: middle; }
  `;

  static override properties = {
    _summary: { state: true },
    _daily: { state: true },
    _loading: { state: true },
    _error: { state: true },
    _unit: { state: true },
    refreshKey: { type: Number, attribute: 'refresh-key', reflect: true },
  };

  _summary: MetricsSummary | null = null;
  _daily: DailyResponse | null = null;
  _loading = false;
  _error: string | null = null;
  _unit: TempUnit = temperatureUnitStore.state.unit;
  refreshKey = 0;

  private _lastRefreshKey = -1;
  private _unsubscribe: (() => void) | null = null;

  override async connectedCallback(): Promise<void> {
    super.connectedCallback();
    this._unit = temperatureUnitStore.state.unit;
    this._unsubscribe = temperatureUnitStore.subscribe((s) => {
      this._unit = s.unit;
    });
    await this._load();
  }

  override disconnectedCallback(): void {
    this._unsubscribe?.();
    this._unsubscribe = null;
    super.disconnectedCallback();
  }

  override willUpdate(changed: Map<string, unknown>): void {
    if (changed.has('refreshKey') && this.refreshKey !== this._lastRefreshKey) {
      const first = this._lastRefreshKey === -1;
      this._lastRefreshKey = this.refreshKey;
      if (!first) void this._load();
    }
  }

  protected override updated(): void {
    this._drawDaily();
    this._drawHistogram();
  }

  private async _load(): Promise<void> {
    this._loading = true;
    this._error = null;
    try {
      const [summary, daily] = await Promise.all([
        getMetricsSummary(WINDOW_DAYS),
        getDailyMetrics(),
      ]);
      this._summary = summary;
      this._daily = daily;
    } catch (e) {
      // Never show an earlier payload as current.
      this._summary = null;
      this._daily = null;
      this._error = e instanceof Error ? e.message : String(e);
    }
    this._loading = false;
  }

  override render() {
    if (this._error) {
      return html`<div class="banner" role="alert">
        We couldn't load your metrics just now: ${this._error}
        <button type="button" @click=${() => void this._load()}>Try again</button>
      </div>`;
    }
    if (this._loading || !this._summary) {
      return html`<div class="banner" role="status">Loading your metrics…</div>`;
    }
    const s = this._summary;
    if (s.days_counted === 0) {
      return html`<div class="banner" data-state="empty">
        No metrics yet. Your numbers appear after your first full day of plans and readings.
      </div>`;
    }
    return html`<div class="metrics">
      <h2>Your metrics</h2>
      <div class="window">Last ${s.window} days</div>
      <div class="tiles">
        ${this._savingsTile(s)} ${this._machinesTile(s)}
        ${this._simpleTile('peaks-idle', 'Peak hours idle', hours(s.peaks.peak_hours_idle),
          'Time your machines sat idle during the priciest hours of the day.')}
        ${this._simpleTile('offpeak', 'Off-peak share', percent(s.peaks.off_peak_kwh_share_pct),
          'Share of your energy used in the cheapest hours.')}
        ${this._simpleTile('flexibility', 'Flexibility offered', degreeHours(s.flexibility.degree_hours, this._unit),
          'How much comfort range you gave the optimizer to work with.')}
      </div>
      <div class="panel" data-testid="daily-chart">
        <h3>Savings per day</h3>
        <div class="chart" data-region="daily-chart"></div>
      </div>
      ${this._histogramPanel(s)}
    </div>`;
  }

  private _simpleTile(id: string, label: string, value: string, note: string): TemplateResult {
    return html`<div class="tile" data-testid="tile-${id}">
      <h3>${label}</h3>
      <p class="big ${value === EM_DASH ? 'missing' : ''}">${value}</p>
      <p class="note">${note}</p>
    </div>`;
  }

  private _savingsTile(s: MetricsSummary): TemplateResult {
    const sv = s.savings;
    return html`<div class="tile" data-testid="tile-savings">
      <h3>Savings</h3>
      <div class="pair">
        <div>
          <div class="label">Modeled</div>
          <div class="v">${money(sv.modeled_usd)}</div>
        </div>
        <div>
          <div class="label">Realized (measured)</div>
          <div class="v ${sv.realized_usd === null ? 'missing' : ''}">${money(sv.realized_usd)}</div>
          ${sv.realized_usd !== null && sv.realized_days > 0
            ? html`<div class="note" data-testid="realized-days">over ${sv.realized_days} of ${s.days_counted} ${s.days_counted === 1 ? 'day' : 'days'}</div>`
            : ''}
        </div>
      </div>
      <p class="note">Modeled is what the plan projected. Realized is measured from your meter, so it
        reflects the day as it actually ran, including any adjustments you made.</p>
      ${sv.realized_usd === null
        ? html`<p class="note" data-testid="realized-gate">Measured savings appear once your plan runs at least 80% as scheduled and your
            meter reports this machine on its own.</p>`
        : ''}
      ${sv.degenerate
        ? html`<p class="note warn">Your savings percentage looks off for this window. We're holding it back rather
            than showing a figure we don't trust.</p>`
        : sv.savings_pct !== null
          ? html`<p class="note">${sv.savings_pct.toFixed(1)}% off your baseline cost.</p>`
          : ''}
    </div>`;
  }

  private _machinesTile(s: MetricsSummary): TemplateResult {
    const by = s.machines.by_type;
    const connected = MACHINE_TYPES.filter((t) => (by[t.key] ?? 0) > 0);
    return html`<div class="tile" data-testid="tile-machines">
      <h3>Machines connected</h3>
      <p class="big">${connected.length} of ${MACHINE_TYPES.length} machine types</p>
      <ul>
        ${MACHINE_TYPES.map((t) => {
          const on = (by[t.key] ?? 0) > 0;
          return html`<li class=${on ? 'on' : 'off'}><span>${t.label}</span><span>${on ? '✓ connected' : `${EM_DASH} not connected`}</span></li>`;
        })}
      </ul>
    </div>`;
  }

  private _histogramPanel(s: MetricsSummary): TemplateResult {
    const hist = s.adherence.override_by_hour;
    const total = hist ? hist.reduce((a, b) => a + (b > 0 ? b : 0), 0) : 0;
    let body: TemplateResult;
    if (hist === null) {
      body = html`<p class="note" data-testid="override-hist-missing">Hour-of-day breakdown ${EM_DASH} appears once we have a day of data.</p>`;
    } else if (total === 0) {
      body = html`<p class="note" data-testid="override-hist-empty">You have not overridden the plan in this window.</p>`;
    } else {
      const peakHour = hist.indexOf(Math.max(...hist));
      body = html`
        <div class="chart" data-region="override-hist"></div>
        <div class="ticks"><span>12a</span><span>6a</span><span>12p</span><span>6p</span><span>11p</span></div>
        <p class="note">Most of your adjustments land around <strong>${formatHour(peakHour)}</strong>. If you
          want closer temperature control then, constrain your comfort curve more tightly for those hours.</p>`;
    }
    return html`<div class="panel" data-testid="override-histogram">
      <h3>When you adjust the plan</h3>
      <p class="note">The hours you take the wheel. This is information, not a scorecard: it just shows where your changes cluster.</p>
      ${body}
    </div>`;
  }

  /** Grouped bars per day: modeled (teal) and realized (blue). Missing values draw no bar. */
  private _drawDaily(): void {
    const host = this.renderRoot.querySelector('[data-region="daily-chart"]');
    if (!host) return;
    while (host.firstChild) host.removeChild(host.firstChild);
    const days = (this._daily?.days ?? []).slice(-WINDOW_DAYS);
    const vals = days.flatMap((d) => [d.savings.modeled_usd, d.savings.realized_usd]).filter((v): v is number => v !== null);
    if (days.length === 0 || vals.length === 0) {
      const p = document.createElement('p');
      p.className = 'note';
      p.dataset.testid = 'daily-empty';
      p.textContent = `Daily savings ${EM_DASH} appear once a day has been planned.`;
      host.appendChild(p);
      return;
    }
    const W = 480, H = 160, PL = 40, PR = 8, PT = 8, PB = 20;
    const max = Math.max(0.01, ...vals);
    const min = Math.min(0, ...vals);
    const span = max - min;
    const y = (v: number) => PT + (1 - (v - min) / span) * (H - PT - PB);
    const slot = (W - PL - PR) / days.length;
    const bw = Math.max(1, (slot - 2) / 2);
    const svg = svgEl('svg', {
      viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Savings per day, modeled and realized',
      preserveAspectRatio: 'xMidYMid meet',
    });
    for (const v of [min, (min + max) / 2, max]) {
      svg.appendChild(svgEl('line', { x1: PL, x2: W - PR, y1: y(v), y2: y(v), stroke: '#CBD5E1', 'stroke-width': 0.5 }));
      const t = svgEl('text', { x: PL - 4, y: y(v) + 4, 'text-anchor': 'end', 'font-size': 10, fill: '#475569' });
      t.textContent = `$${v.toFixed(2)}`;
      svg.appendChild(t);
    }
    days.forEach((d, i) => {
      const x0 = PL + i * slot + 1;
      const series: Array<[number | null, string, number]> = [
        [d.savings.modeled_usd, '#0F766E', 0],
        [d.savings.realized_usd, '#2563EB', 1],
      ];
      for (const [v, fill, k] of series) {
        if (v === null) continue;
        const top = Math.min(y(v), y(0));
        const bar = svgEl('rect', {
          x: x0 + k * bw, y: top, width: bw, height: Math.max(1, Math.abs(y(v) - y(0))), fill,
          'data-date': d.date, 'data-series': k === 0 ? 'modeled' : 'realized',
        });
        svg.appendChild(bar);
      }
    });
    const first = svgEl('text', { x: PL, y: H - 4, 'font-size': 10, fill: '#475569' });
    first.textContent = days[0].date;
    const last = svgEl('text', { x: W - PR, y: H - 4, 'font-size': 10, fill: '#475569', 'text-anchor': 'end' });
    last.textContent = days[days.length - 1].date;
    svg.append(first, last);
    host.appendChild(svg);
    const legend = document.createElement('div');
    legend.className = 'legend';
    legend.innerHTML = '<span class="sw" style="background:#0F766E"></span>Modeled<span class="sw" style="background:#2563EB"></span>Realized (measured)';
    host.appendChild(legend);
  }

  private _drawHistogram(): void {
    const host = this.renderRoot.querySelector('[data-region="override-hist"]');
    const hist = this._summary?.adherence.override_by_hour;
    if (!host || !hist) return;
    while (host.firstChild) host.removeChild(host.firstChild);
    const W = 240, H = 48;
    const peak = Math.max(1, ...hist);
    const slot = W / 24;
    const peakHour = hist.indexOf(Math.max(...hist));
    const svg = svgEl('svg', {
      viewBox: `0 0 ${W} ${H}`, role: 'img', preserveAspectRatio: 'none',
      'aria-label': `Overrides by hour of day; most frequent around ${formatHour(peakHour)}`,
    });
    hist.forEach((count, h) => {
      const c = count > 0 ? count : 0;
      const bh = c === 0 ? 1 : Math.max(2, Math.round((c / peak) * (H - 4)));
      const bar = svgEl('rect', {
        x: h * slot + 0.5, y: H - bh, width: slot - 1, height: bh,
        fill: c === 0 ? '#CBD5E1' : '#0F766E', 'data-region': 'override-bar', 'data-empty': c === 0 ? 'true' : 'false',
      });
      const title = svgEl('title', {});
      title.textContent = `${c} at ${formatHour(h)}`;
      bar.appendChild(title);
      svg.appendChild(bar);
    });
    host.appendChild(svg);
  }
}
