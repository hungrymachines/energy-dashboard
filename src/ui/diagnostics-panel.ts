import { LitElement, html, css } from 'lit';
import type { TemplateResult } from 'lit';
import * as diagnostics from '../api/diagnostics.js';
import type {
  ApplianceHealth,
  DivergenceReport,
  ConfiguredSensor,
  UnitDivergence,
} from '../api/diagnostics.js';
import { offsetNote, runLabel } from '../utils/band-check.js';
import { formatDelta, temperatureUnitStore } from '../utils/temperature.js';
import type { TempUnit } from '../utils/temperature.js';
import { getIntegrationVersion } from '../utils/version.js';

/**
 * `<hm-diagnostics-panel>` — three-signal divergence renderer.
 *
 * Renders the verdict from `/api/v1/integration/health/divergence` as
 * a small badge on a collapsed "Command check" row, with one line per
 * unit inside it: its verdict, the one-line explanation, and the
 * comparisons that could be made for it. The verdict is diagnostic, so
 * it never leads the dashboard as a banner — the same treatment the
 * "Sensor health" row gets.
 *
 * One collapsed "About these checks" section closes the panel: what
 * each row compares, when it flags a unit and what to do about it.
 *
 * Two more collapsed rows come from `/api/v1/integration/health`, one
 * line per heating or cooling unit: "Readings" (are they arriving, and
 * do they change) and "Comfort ranges" (hours whose range is narrower
 * than the unit can hold). Each is left out when the server sends
 * nothing for it.
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
    .sensor-details,
    .check-details {
      margin-top: 10px;
    }
    .sensor-details > summary,
    .check-details > summary {
      cursor: pointer;
      font-size: 13px;
      font-weight: 600;
      color: var(--hm-text, #0F172A);
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 6px 0;
    }
    .sensor-details > summary > .summary-badge,
    .check-details > summary > .summary-badge {
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
    .summary-badge.muted {
      background: rgba(100, 116, 139, 0.12);
      color: #475569;
    }
    .check-details > summary > .window {
      font-weight: 400;
      color: var(--hm-muted, #64748B);
    }
    .check-msg {
      margin: 6px 0 0;
      font-size: 13px;
      line-height: 1.4;
      color: var(--hm-muted, #64748B);
    }
    .sensor-details[open] > .sensor-grid {
      margin-top: 8px;
    }
    .diag-body,
    .diag-part {
      display: contents;
    }
    .sensor-row .summary-badge {
      margin-left: 8px;
      font-size: 11px;
      font-weight: 600;
      padding: 1px 7px;
      border-radius: 999px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .sensor-row .details {
      margin-top: 6px;
      /* One label width for both groups, so their values line up. */
      grid-template-columns: minmax(0, 15em) auto;
    }
    .power-group {
      margin-top: 8px;
      padding-top: 6px;
      border-top: 1px dashed rgba(100, 116, 139, 0.3);
    }
    .group-title {
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--hm-muted, #64748B);
    }
    .power-group .details {
      margin-top: 4px;
    }
    .group-note {
      margin-top: 4px;
      font-size: 13px;
      line-height: 1.4;
      color: var(--hm-muted, #64748B);
    }
    .about {
      margin-top: 14px;
      font-size: 13px;
      color: var(--hm-muted, #64748B);
    }
    .about > summary {
      margin-top: 0;
      font-size: 13px;
      font-weight: 600;
    }
    .about h4 {
      margin: 12px 0 0;
      font-size: 13px;
      color: var(--hm-text, #0F172A);
    }
    .about p {
      margin: 6px 0 0;
      line-height: 1.45;
    }
    .about dl {
      margin: 6px 0 0;
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 4px 12px;
      line-height: 1.4;
    }
    .about dt {
      color: var(--hm-text, #0F172A);
      font-weight: 600;
    }
    .about dd {
      margin: 0;
    }
    .versions {
      margin-top: 12px;
      display: flex;
      flex-wrap: wrap;
      gap: 4px 16px;
      font-size: 12px;
      color: var(--hm-muted, #64748B);
    }
  `;

  static override properties = {
    _report: { state: true },
    _sensors: { state: true },
    _units: { state: true },
    _apiBuild: { state: true },
    _loading: { state: true },
    _error: { state: true },
    refreshKey: { type: Number, attribute: 'refresh-key', reflect: true },
  };

  _report: DivergenceReport | null = null;
  _sensors: ConfiguredSensor[] | null = null;
  _units: ApplianceHealth[] | null = null;
  _apiBuild: string | null = null;
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
    // Fetch divergence + sensor health + the API build + per-unit
    // health in parallel — they're independent endpoints.
    const [report, sensors, health, link] = await Promise.allSettled([
      diagnostics.getDivergenceReport(),
      diagnostics.getSensorHealth(),
      diagnostics.getApiHealth(),
      diagnostics.getIntegrationHealth(),
    ]);
    // Per-unit rows are optional in every way: a failed call, an older
    // server or a home with no such unit all render nothing.
    this._units =
      link.status === 'fulfilled' && Array.isArray(link.value?.appliances)
        ? link.value.appliances
        : null;
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
    // Same rule for the build stamp: a missing one renders as '—',
    // it never turns into an error banner.
    this._apiBuild =
      health.status === 'fulfilled' && typeof health.value?.api_build === 'string'
        ? health.value.api_build
        : null;
    this._loading = false;
  }

  override render() {
    // The version footer sits below whatever the body renders, in every
    // state — a user who can't load diagnostics at all is exactly the
    // user being asked "which version are you on?".
    //
    // The body is wrapped in a real element rather than interpolated
    // straight into the fragment root: happy-dom drops a marker comment
    // that leads the template, which shifts every following part by one
    // (the body's HTML lands in the Integration slot, the version in the
    // API-build slot). Same family as the `${cond ? html : null}` edge
    // case noted in `_renderBody`. One wrapper div costs nothing and
    // keeps the parts aligned.
    return html`
      <div class="diag-body">${this._renderBody()}</div>
      <div class="about-wrap">${_about(temperatureUnitStore.state.unit)}</div>
      <div class="versions">
        <span class="version-line">Integration ${_fmtVersion(getIntegrationVersion())}</span>
        <span class="version-line">API build ${this._apiBuild || '—'}</span>
      </div>
    `;
  }

  private _renderBody() {
    if (this._loading && !this._report && !this._sensors && !this._units) {
      return html`<div class="banner muted"><span class="msg">Checking integration health…</span></div>`;
    }
    if (this._error && !this._sensors && !this._units) {
      return html`<div class="banner muted"><span class="msg">Couldn't load diagnostics: ${this._error}</span></div>`;
    }
    // Build the report HTML inline when we have a report, otherwise
    // an empty placeholder. happy-dom has an edge case with multiple
    // sibling `${cond ? html : null}` interpolations at the top
    // level of a render — keeping just the report inline + sensors
    // as a sibling avoids it.
    if (!this._report) {
      return html`<div class="diag-part">${this._renderSensorBlock()}</div>
        <div class="diag-part">${this._renderUnitBlocks()}</div>`;
    }
    return this._renderFull(this._report);
  }

  private _renderFull(r: DivergenceReport) {
    // Inline both pieces so Lit sees one big template result, not
    // two interpolations sharing the parent.
    const tone = _toneFor(r.verdict);
    const badge = _badgeFor(r.verdict);
    // One line per unit; an older server, or one that can't name the
    // units, sends a single report, which renders as one unnamed line.
    const named = Array.isArray(r.appliances) && r.appliances.length > 0;
    const units: Array<DivergenceReport | UnitDivergence> = named ? r.appliances! : [r];
    return html`
      <details class="check-details">
        <summary>
          Command check
          <span class="summary-badge ${tone}">${badge}</span>
          <span class="window">last ${r.lookback_hours} h</span>
        </summary>
        <div class="sensor-grid">${units.map((u) => _renderCheckUnit(u, named))}</div>
      </details>
      <div class="diag-part">${this._renderSensorBlock()}</div>
      <div class="diag-part">${this._renderUnitBlocks()}</div>
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

  /** "Readings" and "Comfort ranges", one row per unit. Always one
   * template so the surrounding parts stay aligned (see `render`). */
  private _renderUnitBlocks() {
    const units = this._units ?? [];
    if (units.length === 0) return html``;
    const unit = temperatureUnitStore.state.unit;

    const offline = units.filter((u) => u.status !== 'healthy');
    const readingsBadge =
      offline.length === 0
        ? { tone: 'healthy', text: 'OK' }
        : {
            tone: offline.some((u) => u.status === 'no_data') ? 'bad' : 'intermittent',
            text: `${offline.length} unit${offline.length === 1 ? '' : 's'} need${offline.length === 1 ? 's' : ''} attention`,
          };

    const checked = units.filter((u) => u.band_check);
    const flagged = checked.filter(
      (u) => u.band_check?.offset_capped || (u.band_check?.narrow ?? []).length > 0,
    );
    const rangeBadge =
      flagged.length === 0
        ? { tone: 'healthy', text: 'OK' }
        : { tone: 'intermittent', text: `${flagged.length} to review` };

    return html`
      <details class="sensor-details readings-details">
        <summary>
          Readings
          <span class="summary-badge ${readingsBadge.tone}">${readingsBadge.text}</span>
        </summary>
        <div class="sensor-grid">
          ${units.map((u) => {
            const ok = u.status === 'healthy';
            const tone = ok ? 'healthy' : u.status === 'no_data' ? 'bad' : 'intermittent';
            return html`
              <div class="sensor-row ${tone}">
                <span class="sensor-icon ${ok ? 'ok' : tone === 'bad' ? 'bad' : 'warn'}">${ok ? '✓' : '!'}</span>
                <div class="sensor-body">
                  <span class="sensor-label">${u.name || 'Unit'}</span>
                  <div class="sensor-msg">${ok ? 'Readings are arriving and changing.' : u.message}</div>
                </div>
              </div>
            `;
          })}
        </div>
      </details>
      <details class="sensor-details range-details" ?hidden=${checked.length === 0}>
        <summary>
          Comfort ranges
          <span class="summary-badge ${rangeBadge.tone}">${rangeBadge.text}</span>
        </summary>
        <div class="sensor-grid">
          ${checked.map((u) => {
            const check = u.band_check!;
            const runs = check.narrow ?? [];
            const ok = runs.length === 0 && !check.offset_capped;
            const wide = check.wide_setpoint_offset === true;
            const narrowText =
              runs.length > 0
                ? ` Narrower than this unit can hold now: ${runs
                    .map((r) => `${runLabel(r)} (${formatDelta(r.width_f, unit)} wide)`)
                    .join(', ')}.`
                : '';
            const message = `${offsetNote(check, wide, unit)}${narrowText}`;
            return html`
              <div class="sensor-row ${ok ? 'healthy' : 'intermittent'}">
                <span class="sensor-icon ${ok ? 'ok' : 'warn'}">${ok ? '✓' : '!'}</span>
                <div class="sensor-body">
                  <span class="sensor-label">${u.name || 'Unit'}</span>
                  <div class="sensor-msg">${message}</div>
                </div>
              </div>
            `;
          })}
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

/** `3.6.0` -> `v3.6.0`; unknown -> the em dash the panel uses for "no value". */
function _fmtVersion(v: string | null): string {
  if (!v) return '—';
  return v.startsWith('v') ? v : `v${v}`;
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

/** Tone names match the `.summary-badge` classes the sensor row uses. */
function _toneFor(v: DivergenceReport['verdict']): 'healthy' | 'intermittent' | 'bad' | 'muted' {
  if (v === 'healthy') return 'healthy';
  if (v === 'entity_unreliable' || v === 'commanded_missing') return 'intermittent';
  if (v === 'thermostat_ignoring_commands') return 'bad';
  return 'muted';
}

function _badgeFor(v: DivergenceReport['verdict']): string {
  switch (v) {
    case 'healthy':
      return 'OK';
    case 'entity_unreliable':
      return 'Mode differs';
    case 'thermostat_ignoring_commands':
      return 'Setpoint not held';
    case 'commanded_missing':
      return 'Upgrade integration';
    case 'no_data':
      return 'Nothing to check';
    default:
      return 'Unknown';
  }
}

/** One unit's line in the Command check. The unit's name and badge show
 * only when the server sent one report per unit. */
function _renderCheckUnit(u: DivergenceReport | UnitDivergence, named: boolean): TemplateResult {
  const tone = _toneFor(u.verdict);
  const glyph = tone === 'healthy' ? '✓' : tone === 'muted' ? '–' : '!';
  const icon = tone === 'healthy' ? 'ok' : tone === 'bad' ? 'bad' : 'warn';
  const name = 'name' in u ? u.name : null;
  const rows = _checkRows(u);
  const power = _powerRows(u);
  const hasPower = u.power_coverage_pct > 0;
  return html`
    <div class="sensor-row ${tone}">
      <span class="sensor-icon ${icon}">${glyph}</span>
      <div class="sensor-body">
        <span class="sensor-label" ?hidden=${!named}>${name || 'Unit'}</span>
        <span class="summary-badge ${tone}" ?hidden=${!named}>${_badgeFor(u.verdict)}</span>
        <div class="sensor-msg">${u.human_readable}</div>
        <div class="details" ?hidden=${rows.length === 0}>${rows.map(_detailRow)}</div>
        <div class="power-group" ?hidden=${u.sample_count === 0}>
          <div class="group-title">Power sensor</div>
          <div class="details" ?hidden=${!hasPower}>${power.map(_detailRow)}</div>
          <div class="group-note" ?hidden=${hasPower}>
            No power readings from this unit. A power sensor that measures this unit alone lets the
            check confirm it ran when told to run and stopped when told to stop.
          </div>
        </div>
      </div>
    </div>
  `;
}

function _detailRow([label, value, cls]: [string, string, string]): TemplateResult {
  return html`<span class="label">${label}</span><span class=${cls}>${value}</span>`;
}

/** The comparisons a power sensor makes possible, kept apart from the
 * thermostat's own so it is plain they all come from the meter. */
function _powerRows(u: DivergenceReport | UnitDivergence): Array<[string, string, string]> {
  const rows: Array<[string, string, string]> = [];
  if (u.sample_count === 0 || !(u.power_coverage_pct > 0)) return rows;
  rows.push(['Readings with power', _fmtPct(u.power_coverage_pct), _pctClass(u.power_coverage_pct, 80)]);
  if (u.power_obeyed_pct !== null) {
    rows.push(['Power draw matched commands', _fmtPct(u.power_obeyed_pct), _pctClass(u.power_obeyed_pct, 70)]);
  }
  return rows;
}

/** The thermostat comparisons that could be made for a unit, as
 * [label, value, class]. A comparison the unit has no data for is left
 * out, not shown as a blank. Power comparisons are `_powerRows`. */
function _checkRows(u: DivergenceReport | UnitDivergence): Array<[string, string, string]> {
  const unit = temperatureUnitStore.state.unit;
  const rows: Array<[string, string, string]> = [];
  if (u.sample_count === 0) return rows;
  rows.push(['Readings with a command', `${_fmtPct(u.commanded_coverage_pct)} of ${u.sample_count}`, '']);
  const mode = u.commanded_vs_entity_mode_agreement_pct;
  if (mode !== null) rows.push(['Mode matched', _fmtPct(mode), _pctClass(mode, 50)]);
  const fail = u.setpoint_hold_fail_pct;
  if (typeof fail === 'number') {
    rows.push(['Setpoint held', _fmtPct(100 - fail), _pctClass(100 - fail, 100 - SETPOINT_FAIL_PCT)]);
  }
  if (u.setpoint_offset_avg_f !== null) {
    const max = u.setpoint_offset_max_f;
    rows.push([
      'Setpoint gap (avg / max)',
      `${formatDelta(u.setpoint_offset_avg_f, unit)}${max !== null ? ` / ${formatDelta(max, unit)}` : ''}`,
      u.setpoint_offset_avg_f <= SETPOINT_TOLERANCE_F ? 'ok' : 'bad',
    ]);
  }
  if (u.fan_match_pct !== null) rows.push(['Fan speed matched', _fmtPct(u.fan_match_pct), _pctClass(u.fan_match_pct, 50)]);
  return rows;
}

/** How far a setpoint may sit from the one sent and still count as held, °F. */
const SETPOINT_TOLERANCE_F = 2;
/** Share of readings off by more than that which flags a unit. */
const SETPOINT_FAIL_PCT = 30;

function _fmtPct(v: number): string {
  return `${v.toFixed(0)}%`;
}

function _pctClass(v: number, threshold = 50): string {
  return v >= threshold ? 'ok' : 'bad';
}

/** The one collapsed "About these checks" section under every row. */
function _about(unit: TempUnit): TemplateResult {
  const tol = formatDelta(SETPOINT_TOLERANCE_F, unit, 0);
  return html`
    <details class="about">
      <summary>About these checks</summary>
      <h4>Command check</h4>
      <p>
        Compares what Hungry Machines sent each unit with what its thermostat reports, over the
        last 24 hours.
      </p>
      <dl>
        <dt>Readings with a command</dt>
        <dd>How many readings were taken while a command was in force.</dd>
        <dt>Mode matched</dt>
        <dd>How often the thermostat was set to the mode it was sent. Heat-cool and auto count for heat or cool.</dd>
        <dt>Setpoint held</dt>
        <dd>How often its setpoint was within ${tol} of the one sent.</dd>
        <dt>Setpoint gap</dt>
        <dd>The average and the largest difference between the two.</dd>
        <dt>Fan speed matched</dt>
        <dd>Shown only for a unit whose thermostat reports its fan speed.</dd>
      </dl>
      <p>
        The <strong>Power sensor</strong> group needs a power sensor that measures this unit alone.
        Without one it says so, and the rest of the check still runs.
      </p>
      <dl>
        <dt>Readings with power</dt>
        <dd>How many readings carried a power value.</dd>
        <dt>Power draw matched commands</dt>
        <dd>
          How often the unit drew power when told to heat or cool, and drew none when told to turn
          off. A unit sitting idle because the room has already reached its setpoint counts as
          matched.
        </dd>
      </dl>
      <p>
        A unit is flagged when it held the setpoint on fewer than ${100 - SETPOINT_FAIL_PCT}% of readings
        (Setpoint not held), or was in the mode it was sent on fewer than half (Mode differs). A
        flag needs at least an hour of commands. Idle days, pauses and a mode set at the thermostat
        send none, and show as Nothing to check. If you changed the thermostat yourself, there is
        nothing to fix. If you didn't, check that no other automation or schedule is setting it, and
        that the thermostat accepts the setpoint it was sent.
      </p>
      <h4>Sensor health</h4>
      <p>
        Checks each extra sensor added to a unit (indoor temperature, humidity or power) over the
        last 6 hours, by how many readings carried a value from it. 80% or more is healthy. Below
        that it is intermittent, and under 5% it needs attention: Home Assistant could not read a
        number from it. To fix one, open the entity in Home Assistant and check that it exists and
        shows a number, then check the entity ID in the unit's settings here.
      </p>
      <h4>Readings</h4>
      <p>
        Checks that each unit's readings arrive and change, over the last 6 hours. Readings are
        taken about every 5 minutes and uploaded about once an hour, so a unit is flagged when its
        newest reading is more than 90 minutes old, or when its temperature, humidity, mode and
        setpoint have not changed at all for 6 hours. Readings that stop usually mean Home Assistant
        was offline or restarting. Readings that never change usually mean the thermostat or its
        sensor stopped updating in Home Assistant.
      </p>
      <h4>Comfort ranges</h4>
      <p>
        Some units read the room with their own built-in sensor, which can read differently from
        the room sensor your comfort range is written for. Hungry Machines learns that difference
        from your readings and moves the unit's setpoint to hold the room in range, by up to
        ${formatDelta(3, unit, 0)} outside it (${formatDelta(6, unit, 0)} with the wider offset on).
        A unit is marked when the difference is more than that, or when some hours have a range
        narrower than the unit can hold. In those hours it can stop while the room is still outside
        the range. This is advice, not a fault: widen those hours, map a different temperature
        sensor to the unit, or leave them as they are.
      </p>
    </details>
  `;
}

if (!customElements.get('hm-diagnostics-panel')) {
  customElements.define('hm-diagnostics-panel', HmDiagnosticsPanel);
}
