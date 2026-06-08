import { LitElement, html, css } from 'lit';
import * as diagnostics from '../api/diagnostics.js';
import type {
  DivergenceReport,
  ConfiguredSensor,
} from '../api/diagnostics.js';

/**
 * `<hm-diagnostics-panel>` — three-signal divergence renderer.
 *
 * Renders the verdict from `/api/v1/integration/health/divergence` as
 * a status banner plus a per-signal coverage / agreement table. The
 * panel embeds it under the integration-health badge so users with
 * misbehaving thermostats (the Tuya / mini-split scenario the
 * reconciler was built for) get a one-line "your thermostat reports
 * unreliable state" explanation without having to mine SQL.
 *
 * Pulls its own data on connect; emits no events. Re-fetch by setting
 * the `refresh-key` attribute (the panel bumps this when it
 * re-pulls schedules).
 */
export class HmDiagnosticsPanel extends LitElement {
  static override styles = css`
    :host {
      display: block;
      font-family: var(--hm-font-body, sans-serif);
      color: var(--hm-text, #0F172A);
    }
    .banner {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 12px 14px;
      border-radius: 8px;
      border: 1px solid transparent;
    }
    .banner.healthy {
      background: rgba(15, 118, 110, 0.08);
      border-color: rgba(15, 118, 110, 0.35);
      color: #115E59;
    }
    .banner.warn {
      background: rgba(245, 158, 11, 0.10);
      border-color: rgba(245, 158, 11, 0.50);
      color: #92400E;
    }
    .banner.error {
      background: rgba(220, 38, 38, 0.08);
      border-color: rgba(220, 38, 38, 0.45);
      color: #991B1B;
    }
    .banner.muted {
      background: rgba(100, 116, 139, 0.08);
      border-color: rgba(100, 116, 139, 0.35);
      color: #475569;
    }
    .badge {
      font-weight: 600;
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      white-space: nowrap;
    }
    .msg {
      flex: 1;
      font-size: 14px;
      line-height: 1.4;
    }
    .details {
      margin-top: 10px;
      display: grid;
      grid-template-columns: auto auto;
      gap: 4px 16px;
      font-size: 13px;
      color: var(--hm-muted, #64748B);
    }
    .details .label {
      color: var(--hm-text, #0F172A);
    }
    .details .ok {
      color: #115E59;
    }
    .details .bad {
      color: #991B1B;
    }
    summary {
      cursor: pointer;
      font-size: 13px;
      color: var(--hm-muted, #64748B);
      margin-top: 10px;
    }
    .sensor-grid {
      margin-top: 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .sensor-row {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 8px 10px;
      border-radius: 6px;
      border: 1px solid rgba(100, 116, 139, 0.2);
      background: #fafbfc;
      font-size: 13px;
    }
    .sensor-row.healthy {
      border-color: rgba(15, 118, 110, 0.35);
      background: rgba(15, 118, 110, 0.04);
    }
    .sensor-row.intermittent {
      border-color: rgba(245, 158, 11, 0.45);
      background: rgba(245, 158, 11, 0.06);
    }
    .sensor-row.bad {
      border-color: rgba(220, 38, 38, 0.45);
      background: rgba(220, 38, 38, 0.05);
    }
    .sensor-icon {
      font-weight: 700;
      font-size: 14px;
      line-height: 1;
      flex: 0 0 auto;
      padding-top: 2px;
    }
    .sensor-icon.ok { color: #115E59; }
    .sensor-icon.warn { color: #92400E; }
    .sensor-icon.bad { color: #991B1B; }
    .sensor-body {
      flex: 1;
      line-height: 1.35;
    }
    .sensor-label {
      font-weight: 600;
      color: var(--hm-text, #0F172A);
    }
    .sensor-entity {
      font-family: monospace;
      font-size: 12px;
      color: var(--hm-muted, #64748B);
    }
    .sensor-msg {
      margin-top: 4px;
      color: var(--hm-muted, #64748B);
    }
    .section-title {
      margin: 14px 0 4px;
      font-size: 13px;
      font-weight: 600;
      color: var(--hm-text, #0F172A);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .sensor-details {
      margin-top: 10px;
    }
    .sensor-details > summary {
      cursor: pointer;
      font-size: 13px;
      font-weight: 600;
      color: var(--hm-text, #0F172A);
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 6px 0;
    }
    .sensor-details > summary > .summary-badge {
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 999px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .summary-badge.healthy {
      background: rgba(15, 118, 110, 0.12);
      color: #115E59;
    }
    .summary-badge.intermittent {
      background: rgba(245, 158, 11, 0.15);
      color: #92400E;
    }
    .summary-badge.bad {
      background: rgba(220, 38, 38, 0.12);
      color: #991B1B;
    }
    .sensor-details[open] > .sensor-grid {
      margin-top: 8px;
    }
  `;

  static override properties = {
    _report: { state: true },
    _sensors: { state: true },
    _loading: { state: true },
    _error: { state: true },
    refreshKey: { type: Number, attribute: 'refresh-key', reflect: true },
  };

  _report: DivergenceReport | null = null;
  _sensors: ConfiguredSensor[] | null = null;
  _loading = false;
  _error: string | null = null;
  refreshKey = 0;

  private _lastRefreshKey = -1;

  override async connectedCallback(): Promise<void> {
    super.connectedCallback();
    await this._load();
  }

  override willUpdate(changed: Map<string, unknown>): void {
    if (changed.has('refreshKey') && this.refreshKey !== this._lastRefreshKey) {
      this._lastRefreshKey = this.refreshKey;
      this._load();
    }
  }

  private async _load(): Promise<void> {
    this._loading = true;
    this._error = null;
    // Fetch divergence + sensor health in parallel — they're
    // independent endpoints and the panel renders both.
    const [report, sensors] = await Promise.allSettled([
      diagnostics.getDivergenceReport(),
      diagnostics.getSensorHealth(),
    ]);
    if (report.status === 'fulfilled') {
      this._report = report.value;
    } else {
      this._error = report.reason instanceof Error
        ? report.reason.message
        : String(report.reason);
      this._report = null;
    }
    if (sensors.status === 'fulfilled') {
      this._sensors = sensors.value.sensors;
    } else {
      // Sensor health failure shouldn't blank the whole panel — the
      // divergence report is independently useful. Just don't render
      // the section.
      this._sensors = null;
    }
    this._loading = false;
  }

  override render() {
    if (this._loading && !this._report && !this._sensors) {
      return html`<div class="banner muted"><span class="msg">Checking integration health…</span></div>`;
    }
    if (this._error && !this._sensors) {
      return html`<div class="banner muted"><span class="msg">Couldn't load diagnostics: ${this._error}</span></div>`;
    }
    // Build the report HTML inline when we have a report, otherwise
    // an empty placeholder. happy-dom has an edge case with multiple
    // sibling `${cond ? html : null}` interpolations at the top
    // level of a render — keeping just the report inline + sensors
    // as a sibling avoids it.
    if (!this._report) {
      return html`${this._renderSensorBlock()}`;
    }
    return this._renderFull(this._report);
  }

  private _renderFull(r: DivergenceReport) {
    // Inline both pieces so Lit sees one big template result, not
    // two interpolations sharing the parent.
    const tone = _toneFor(r.verdict);
    const badge = _badgeFor(r.verdict);
    return html`
      <div class="banner ${tone}">
        <span class="badge">${badge}</span>
        <span class="msg">${r.human_readable}</span>
      </div>
      ${r.sample_count > 0
        ? html`
            <details>
              <summary>Signal details (last ${r.lookback_hours} h, ${r.sample_count} readings)</summary>
              <div class="details">
                <span class="label">Commanded coverage</span>
                <span class=${_pctClass(r.commanded_coverage_pct)}>${_fmtPct(r.commanded_coverage_pct)}</span>
                <span class="label">Power coverage</span>
                <span class=${_pctClass(r.power_coverage_pct)}>${_fmtPct(r.power_coverage_pct)}</span>
                <span class="label">Entity coverage</span>
                <span class=${_pctClass(r.entity_coverage_pct)}>${_fmtPct(r.entity_coverage_pct)}</span>
                <span class="label">Commanded vs entity (mode)</span>
                <span class=${_pctClass(r.commanded_vs_entity_mode_agreement_pct, 50)}>${_fmtPct(r.commanded_vs_entity_mode_agreement_pct)}</span>
                <span class="label">Commanded vs power (mode)</span>
                <span class=${_pctClass(r.commanded_vs_power_mode_agreement_pct, 70)}>${_fmtPct(r.commanded_vs_power_mode_agreement_pct)}</span>
                <span class="label">Setpoint offset (avg / max)</span>
                <span class=${_offsetClass(r.setpoint_offset_avg_f)}>${_fmtOffset(r.setpoint_offset_avg_f)} / ${_fmtOffset(r.setpoint_offset_max_f)}</span>
                <span class="label">Fan match</span>
                <span class=${_pctClass(r.fan_match_pct, 50)}>${_fmtPct(r.fan_match_pct)}</span>
                <span class="label">Power obeyed commands</span>
                <span class=${_pctClass(r.power_obeyed_pct, 70)}>${_fmtPct(r.power_obeyed_pct)}</span>
              </div>
            </details>
          `
        : null}
      ${this._renderSensorBlock()}
    `;
  }

  private _renderSensorBlock() {
    if (!this._sensors || this._sensors.length === 0) {
      return html``;
    }
    return this._renderSensorHealth(this._sensors);
  }

  private _renderSensorHealth(sensors: ConfiguredSensor[]) {
    // Show a short status pill in the summary so users see at-a-glance
    // whether any sensor is broken without opening the details. Picks
    // the worst verdict across the configured sensors.
    const counts = {
      bad: 0,
      intermittent: 0,
      no_data: 0,
      healthy: 0,
    };
    for (const s of sensors) {
      if (s.verdict === 'missing_or_broken') counts.bad++;
      else if (s.verdict === 'intermittent') counts.intermittent++;
      else if (s.verdict === 'no_data') counts.no_data++;
      else counts.healthy++;
    }
    let summaryBadge: { tone: 'bad' | 'intermittent' | 'healthy'; text: string };
    if (counts.bad > 0) {
      summaryBadge = {
        tone: 'bad',
        text: `${counts.bad} sensor${counts.bad === 1 ? '' : 's'} need${counts.bad === 1 ? 's' : ''} attention`,
      };
    } else if (counts.intermittent > 0) {
      summaryBadge = {
        tone: 'intermittent',
        text: `${counts.intermittent} intermittent`,
      };
    } else {
      summaryBadge = { tone: 'healthy', text: 'All healthy' };
    }
    return html`
      <details class="sensor-details">
        <summary>
          Sensor health
          <span class="summary-badge ${summaryBadge.tone}">${summaryBadge.text}</span>
        </summary>
        <div class="sensor-grid">
          ${sensors.map((s) => this._renderSensorRow(s))}
        </div>
      </details>
    `;
  }

  private _renderSensorRow(s: ConfiguredSensor) {
    const tone = _sensorTone(s.verdict);
    const icon = _sensorIcon(s.verdict);
    return html`
      <div class="sensor-row ${tone}">
        <span class="sensor-icon ${icon.cls}">${icon.glyph}</span>
        <div class="sensor-body">
          <span class="sensor-label">${s.label}</span>
          ·
          <span class="sensor-entity">${s.entity_id}</span>
          ${s.populated_pct !== null
            ? html` <span class="sensor-entity">(${s.populated_pct.toFixed(0)}% populated)</span>`
            : null}
          <div class="sensor-msg">${s.message}</div>
        </div>
      </div>
    `;
  }

}

function _sensorTone(v: ConfiguredSensor['verdict']): 'healthy' | 'intermittent' | 'bad' {
  if (v === 'healthy') return 'healthy';
  if (v === 'intermittent') return 'intermittent';
  return 'bad';
}

function _sensorIcon(v: ConfiguredSensor['verdict']): { glyph: string; cls: string } {
  if (v === 'healthy') return { glyph: '✓', cls: 'ok' };
  if (v === 'intermittent') return { glyph: '!', cls: 'warn' };
  if (v === 'no_data') return { glyph: '?', cls: 'warn' };
  return { glyph: '✗', cls: 'bad' };
}

function _toneFor(v: DivergenceReport['verdict']): 'healthy' | 'warn' | 'error' | 'muted' {
  if (v === 'healthy') return 'healthy';
  if (v === 'entity_unreliable' || v === 'commanded_missing') return 'warn';
  if (v === 'thermostat_ignoring_commands') return 'error';
  return 'muted';
}

function _badgeFor(v: DivergenceReport['verdict']): string {
  switch (v) {
    case 'healthy':
      return 'OK';
    case 'entity_unreliable':
      return 'Entity unreliable';
    case 'thermostat_ignoring_commands':
      return 'AC not responding';
    case 'commanded_missing':
      return 'Upgrade integration';
    case 'no_data':
      return 'No data';
    default:
      return 'Unknown';
  }
}

function _fmtPct(v: number | null): string {
  return v === null ? '—' : `${v.toFixed(0)}%`;
}

function _fmtOffset(v: number | null): string {
  return v === null ? '—' : `${v.toFixed(1)} °F`;
}

function _pctClass(v: number | null, threshold = 50): string {
  if (v === null) return '';
  return v >= threshold ? 'ok' : 'bad';
}

function _offsetClass(v: number | null): string {
  if (v === null) return '';
  return v < 1.0 ? 'ok' : 'bad';
}

if (!customElements.get('hm-diagnostics-panel')) {
  customElements.define('hm-diagnostics-panel', HmDiagnosticsPanel);
}
