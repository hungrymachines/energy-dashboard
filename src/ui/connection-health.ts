import { LitElement, html, css } from 'lit';
import type { TemplateResult } from 'lit';
import { getAppliancesHealth } from '../api/appliance-health.js';
import type { ApplianceHealthEntry, AppliancesHealth } from '../api/appliance-health.js';
import type { ApplianceType } from '../api/appliances.js';
import { ALL_TYPES, TYPE_NAMES } from '../utils/appliance-types.js';
import { formatDelta, temperatureUnitStore } from '../utils/temperature.js';
import type { TempUnit } from '../utils/temperature.js';

/** How far a setpoint may sit from the one sent and still count as held, °F. */
const SETPOINT_TOLERANCE_F = 2;
/** Share of readings off by more than that which flags a unit. */
const SETPOINT_FAIL_PCT = 30;

type Tone = 'healthy' | 'intermittent' | 'bad' | 'muted';
type Row = [string, string, string];

/**
 * `<hm-connection-health>` - one row per machine. The left column holds the
 * connection and control checks (readings, command, sensors, notes); the
 * right column holds power. Types the home has not added follow, greyed.
 */
export class HmConnectionHealth extends LitElement {
  static override styles = css`
    :host { display: block; font-family: var(--hm-font-body, sans-serif); color: var(--hm-text, #0F172A); }
    .banner { padding: 12px 14px; border-radius: 8px; font-size: 14px; background: rgba(100,116,139,0.08); color: #475569; }
    .rows { display: flex; flex-direction: column; gap: 12px; }
    .machine { display: grid; grid-template-columns: 1fr; gap: 12px; padding: 12px 14px; border-radius: 8px; border: 1px solid rgba(100,116,139,0.25); background: #fafbfc; }
    .machine.healthy { border-color: rgba(15,118,110,0.35); }
    .machine.bad { border-color: rgba(220,38,38,0.45); }
    .machine.intermittent { border-color: rgba(245,158,11,0.5); }
    .machine.example { opacity: 0.55; border-style: dashed; }
    @media (min-width: 700px) { .machine { grid-template-columns: 2fr 1fr; } }
    .head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .name { font-weight: 600; }
    .type, .badge { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; text-transform: uppercase; letter-spacing: 0.04em; background: rgba(100,116,139,0.12); color: #475569; }
    .badge.healthy { background: rgba(15,118,110,0.12); color: #115E59; }
    .badge.intermittent { background: rgba(245,158,11,0.15); color: #92400E; }
    .badge.bad { background: rgba(220,38,38,0.12); color: #991B1B; }
    .msg { margin-top: 6px; font-size: 13px; line-height: 1.4; color: var(--hm-muted, #64748B); }
    .details { margin-top: 6px; display: grid; grid-template-columns: minmax(0, 15em) auto; gap: 4px 16px; font-size: 13px; color: var(--hm-muted, #64748B); }
    .details .label { color: var(--hm-text, #0F172A); }
    .ok { color: #115E59; }
    .bad-text { color: #991B1B; }
    .group-title { margin-top: 10px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--hm-muted, #64748B); }
    .power { border-top: 1px dashed rgba(100,116,139,0.3); padding-top: 8px; }
    @media (min-width: 700px) { .power { border-top: 0; padding-top: 0; border-left: 1px dashed rgba(100,116,139,0.3); padding-left: 12px; } }
    .muted-line { font-size: 13px; line-height: 1.4; color: var(--hm-muted, #64748B); }
    .section-title { margin: 18px 0 8px; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
    .about { margin-top: 16px; font-size: 13px; color: var(--hm-muted, #64748B); }
    .about > summary { cursor: pointer; font-weight: 600; }
    .about h4 { margin: 12px 0 0; font-size: 13px; color: var(--hm-text, #0F172A); }
    .about p { margin: 6px 0 0; line-height: 1.45; }
    .about dl { margin: 6px 0 0; display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; line-height: 1.4; }
    .about dt { color: var(--hm-text, #0F172A); font-weight: 600; }
    .about dd { margin: 0; }
  `;

  static override properties = {
    _data: { state: true },
    _loading: { state: true },
    _error: { state: true },
    refreshKey: { type: Number, attribute: 'refresh-key', reflect: true },
  };

  _data: AppliancesHealth | null = null;
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
      const first = this._lastRefreshKey === -1;
      this._lastRefreshKey = this.refreshKey;
      if (!first) void this._load();
    }
  }

  private async _load(): Promise<void> {
    this._loading = true;
    this._error = null;
    try {
      this._data = await getAppliancesHealth();
    } catch (e) {
      this._error = e instanceof Error ? e.message : String(e);
      this._data = null;
    }
    this._loading = false;
  }

  override render() {
    const unit = temperatureUnitStore.state.unit;
    return html`
      <div class="body">${this._renderBody(unit)}</div>
      <div class="about-wrap">${_about(unit)}</div>
    `;
  }

  private _renderBody(unit: TempUnit): TemplateResult {
    if (this._loading && !this._data) {
      return html`<div class="banner" role="status">Checking connections…</div>`;
    }
    if (this._error && !this._data) {
      return html`<div class="banner">Couldn't load connection health: ${this._error}</div>`;
    }
    const machines = this._data?.appliances ?? [];
    const have = new Set(machines.map((m) => m.appliance_type));
    const missing = ALL_TYPES.filter((t) => !have.has(t));
    return html`
      <div class="rows">${machines.map((m) => _renderMachine(m, unit))}</div>
      <div class="section-title" ?hidden=${missing.length === 0}>Not added yet</div>
      <div class="rows">${missing.map(_renderExample)}</div>
    `;
  }
}

function _tone(m: ApplianceHealthEntry): Tone {
  if (m.status === 'attention') return 'bad';
  if (m.status === 'nothing_to_check') return 'muted';
  const sensorWarn = m.sensors.some((s) => s.verdict !== 'healthy');
  return sensorWarn || m.notes.length > 0 ? 'intermittent' : 'healthy';
}

function _badge(m: ApplianceHealthEntry): string {
  if (m.status === 'attention') return 'Needs attention';
  if (m.status === 'nothing_to_check') return 'Nothing to check';
  return 'OK';
}

function _renderMachine(m: ApplianceHealthEntry, unit: TempUnit): TemplateResult {
  const tone = _tone(m);
  const typeName = TYPE_NAMES[m.appliance_type as ApplianceType] ?? m.appliance_type;
  const cmdRows = _commandRows(m, unit);
  const cmd = m.command;
  const cmdText = cmd?.human_readable ?? cmd?.message ?? '';
  return html`
    <div class="machine ${tone}" data-appliance=${m.appliance_id}>
      <div class="control">
        <div class="head">
          <span class="name">${m.name || typeName}</span>
          <span class="type">${typeName}</span>
          <span class="badge ${tone}">${_badge(m)}</span>
        </div>
        <div class="group-title">Readings</div>
        <div class="msg">${m.readings.message || 'No readings message.'}</div>
        <div class="group-title" ?hidden=${cmd === null}>Command</div>
        <div class="msg" ?hidden=${cmdText === ''}>${cmdText}</div>
        <div class="details" ?hidden=${cmdRows.length === 0}>${cmdRows.map(_detailRow)}</div>
        <div class="group-title" ?hidden=${m.sensors.length === 0}>Sensors</div>
        <div class="details" ?hidden=${m.sensors.length === 0}>
          ${m.sensors.map(
            (s) => html`<span class="label">${s.label}</span
              ><span class=${s.verdict === 'healthy' ? 'ok' : 'bad-text'}>${s.message || s.verdict}</span>`,
          )}
        </div>
        <div class="msg" ?hidden=${m.notes.length === 0}>${m.notes.join(' ')}</div>
      </div>
      <div class="power">
        <div class="group-title" style="margin-top:0">Power</div>
        ${_renderPower(m)}
      </div>
    </div>
  `;
}

function _renderPower(m: ApplianceHealthEntry): TemplateResult {
  if (!m.power.mapped) {
    return html`<div class="muted-line">
      No power sensor. One that measures this machine alone lets the check confirm it ran when told
      to run and stopped when told to stop.
    </div>`;
  }
  const rows: Row[] = [];
  if (m.power.coverage_pct !== null) {
    rows.push(['Readings with power', _pct(m.power.coverage_pct), _cls(m.power.coverage_pct, 80)]);
  }
  if (m.power.matched_pct !== null) {
    rows.push(['Matched commands', _pct(m.power.matched_pct), _cls(m.power.matched_pct, 70)]);
  }
  if (rows.length === 0) return html`<div class="muted-line">No power readings yet.</div>`;
  return html`<div class="details">${rows.map(_detailRow)}</div>`;
}

function _renderExample(t: ApplianceType): TemplateResult {
  return html`
    <div class="machine example" data-example=${t}>
      <div class="head">
        <span class="name">${TYPE_NAMES[t] ?? t}</span>
        <span class="badge">Not added</span>
      </div>
      <div class="muted-line">Add this machine from the Dashboard to see its connection checks here.</div>
    </div>
  `;
}

function _detailRow([label, value, cls]: Row): TemplateResult {
  return html`<span class="label">${label}</span><span class=${cls}>${value}</span>`;
}

function _num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** The comparisons that could be made for a machine's command check. A
 * comparison with no data is left out, not shown as a blank. */
function _commandRows(m: ApplianceHealthEntry, unit: TempUnit): Row[] {
  const c = m.command;
  if (!c) return [];
  const rows: Row[] = [];
  if (m.appliance_type !== 'hvac') {
    const matched = _num(c.matched_pct);
    const compared = _num(c.compared);
    const unavailable = _num(c.unavailable_count);
    if (matched !== null) rows.push(['Matched its plan', _pct(matched), _cls(matched, 70)]);
    if (compared !== null) rows.push(['Readings compared', String(compared), '']);
    if (unavailable !== null) rows.push(['Unavailable readings', String(unavailable), unavailable > 0 ? 'bad-text' : '']);
    return rows;
  }
  const samples = _num(c.sample_count) ?? 0;
  if (samples === 0) return rows;
  const cover = _num(c.commanded_coverage_pct);
  if (cover !== null) rows.push(['Readings with a command', `${_pct(cover)} of ${samples}`, '']);
  const mode = _num(c.commanded_vs_entity_mode_agreement_pct);
  if (mode !== null) rows.push(['Mode matched', _pct(mode), _cls(mode, 50)]);
  const fail = _num(c.setpoint_hold_fail_pct);
  if (fail !== null) rows.push(['Setpoint held', _pct(100 - fail), _cls(100 - fail, 100 - SETPOINT_FAIL_PCT)]);
  const avg = _num(c.setpoint_offset_avg_f);
  if (avg !== null) {
    const max = _num(c.setpoint_offset_max_f);
    rows.push([
      'Setpoint gap (avg / max)',
      `${formatDelta(avg, unit)}${max !== null ? ` / ${formatDelta(max, unit)}` : ''}`,
      avg <= SETPOINT_TOLERANCE_F ? 'ok' : 'bad-text',
    ]);
  }
  const fan = _num(c.fan_match_pct);
  if (fan !== null) rows.push(['Fan speed matched', _pct(fan), _cls(fan, 50)]);
  return rows;
}

function _pct(v: number): string {
  return `${v.toFixed(0)}%`;
}

function _cls(v: number, threshold: number): string {
  return v >= threshold ? 'ok' : 'bad-text';
}

/** The one collapsed "About these checks" section at the bottom. */
function _about(unit: TempUnit): TemplateResult {
  const tol = formatDelta(SETPOINT_TOLERANCE_F, unit, unit === 'C' ? 1 : 0);
  return html`
    <details class="about">
      <summary>About these checks</summary>
      <h4>Readings</h4>
      <p>
        Checks that each machine's readings arrive and change, over the last 6 hours. Readings are
        taken about every 5 minutes and uploaded about once an hour, so a machine is flagged when
        its newest reading is more than 90 minutes old, or when its values have not changed at all
        for 6 hours. Readings that stop usually mean Home Assistant was offline or restarting.
        Readings that never change usually mean the device or its sensor stopped updating in Home
        Assistant.
      </p>
      <h4>Command check, heating and cooling</h4>
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
        A unit is flagged when it held the setpoint on fewer than ${100 - SETPOINT_FAIL_PCT}% of
        readings, or was in the mode it was sent on fewer than half. A flag needs at least an hour
        of commands. Idle days, pauses and a mode set at the thermostat send none, and show as
        nothing to check. If you changed the thermostat yourself, there is nothing to fix. If you
        didn't, check that no other automation or schedule is setting it, and that the thermostat
        accepts the setpoint it was sent.
      </p>
      <h4>Planned versus reported</h4>
      <p>
        EV chargers, home batteries, pool pumps and water heaters switched through a switch are
        compared with their plan: whether each reading was on or off when the plan said so. A
        machine is marked as needing attention here when it matched on too few readings, or
        reported as unavailable for a stretch; for now this does not raise an alert on the
        Dashboard. Robots, hot tubs and water heaters run through a climate entity get no such check,
        because the software does not switch them on and off on a plan the readings could confirm.
      </p>
      <h4>Power</h4>
      <p>
        A power sensor that measures one machine alone lets the check compare its draw with the
        plan. Power readings inform the check but never raise an alert on their own.
      </p>
      <h4>Sensors</h4>
      <p>
        Checks each extra sensor added to a machine over the last 6 hours, by how many readings
        carried a value from it. 80% or more is healthy. Below that it is intermittent, and under
        5% it needs attention: Home Assistant could not read a number from it. To fix one, open the
        entity in Home Assistant and check that it exists and shows a number, then check the entity
        ID in the machine's settings here.
      </p>
    </details>
  `;
}
