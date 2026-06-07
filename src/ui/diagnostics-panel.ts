import { LitElement, html, css } from 'lit';
import * as diagnostics from '../api/diagnostics.js';
import type { DivergenceReport } from '../api/diagnostics.js';

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
  `;

  static override properties = {
    _report: { state: true },
    _loading: { state: true },
    _error: { state: true },
    refreshKey: { type: Number, attribute: 'refresh-key', reflect: true },
  };

  _report: DivergenceReport | null = null;
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
    try {
      this._report = await diagnostics.getDivergenceReport();
    } catch (e) {
      this._error = e instanceof Error ? e.message : String(e);
      this._report = null;
    } finally {
      this._loading = false;
    }
  }

  override render() {
    if (this._loading && !this._report) {
      return html`<div class="banner muted"><span class="msg">Checking integration health…</span></div>`;
    }
    if (this._error) {
      return html`<div class="banner muted"><span class="msg">Couldn't load diagnostics: ${this._error}</span></div>`;
    }
    if (!this._report) {
      return html``;
    }
    return this._renderReport(this._report);
  }

  private _renderReport(r: DivergenceReport) {
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
    `;
  }
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
