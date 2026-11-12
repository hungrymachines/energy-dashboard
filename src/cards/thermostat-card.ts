import { LitElement, html, css, type TemplateResult } from 'lit';
import { authStore, type AuthState } from '../store.js';
import { haUnitFrom, liveTemp, temperatureUnitStore } from '../utils/temperature.js';
import { chartScaleStore } from '../utils/chart-scale.js';
import {
  getAllSchedules,
  type ApplianceScheduleEntry,
  type SchedulesResponse,
} from '../api/schedules.js';
import { get as getPreferences, type Preferences } from '../api/preferences.js';
import {
  get as getAppliancePreferences,
  pause as pauseUnit,
  resume as resumeUnit,
  type AppliancePreferences,
} from '../api/appliance-preferences.js';
import { get as getRates, type RatesResponse } from '../api/rates.js';
import { expandHourlyTo48, hasHourlyComfortBands } from '../utils/hourly.js';
import { resolveDayBand, todayIsoLocal, weekdayKeyOf } from '../utils/day-bands.js';
import { formatSavingsEstimate, savingsEstimateTitle } from '../utils/savings.js';
import {
  CARD_REFRESH_MS,
  CARD_RETRY_MS,
  PANEL_PATH,
  healthLabel,
  openPanel,
  pausedUntilLabel,
} from '../utils/cards.js';

export interface HmThermostatCardConfig {
  type?: string;
  /**
   * UUID of the HVAC appliance this card represents. Required when the
   * user has more than one HVAC registered; with exactly one HVAC the
   * card resolves to it automatically.
   */
  appliance_id?: string;
  /**
   * Both optional. The indoor reading defaults to the sensor mapped to
   * the appliance in the panel, else the thermostat's own reading; set
   * `indoor_temp` to show a different one. There is no default outdoor
   * reading.
   */
  entities?: {
    indoor_temp?: string;
    outdoor_temp?: string;
  };
}

type HassStateLike = {
  entity_id?: string;
  state?: unknown;
  attributes?: Record<string, unknown>;
};
type HassLike = {
  states?: Record<string, HassStateLike>;
  config?: { unit_system?: { temperature?: string } };
  callService?: (domain: string, service: string, data?: Record<string, unknown>) => Promise<unknown>;
};

/**
 * Lovelace card that mirrors one HVAC card from the Hungry Machines
 * panel: the same chrome, the savings estimate, the timed-pause row and
 * the optimization chart (price bars, comfort band, planned setpoints).
 *
 * It adds what a dashboard has and the panel card does not: the live
 * indoor temperature and what the thermostat is set to right now, read
 * from `hass.states`. Editing stays in the panel, one tap away.
 */
export class HmThermostatCard extends LitElement {
  static override styles = css`
    :host {
      display: block;
      font-family: var(--hm-font-body, system-ui, sans-serif);
      color: var(--hm-text, #0F172A);
    }
    .stub {
      padding: 24px;
      color: var(--hm-muted, #64748B);
      font-size: 14px;
      background: #ffffff;
      border: 1px solid rgba(100, 116, 139, 0.2);
      border-radius: 14px;
    }
    /* Matches .card from hungry-machines-panel.ts so the overview card
       and the panel card read as siblings. */
    .card {
      background: #ffffff;
      border: 1px solid rgba(100, 116, 139, 0.2);
      border-radius: 14px;
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .card-head {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .card-head .badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 44px;
      height: 44px;
      border-radius: 10px;
      background: var(--hm-primary, #1E3A8A);
      color: #ffffff;
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.02em;
      flex-shrink: 0;
    }
    .card-head .name {
      font-family: var(--hm-font-heading, Lora, serif);
      font-weight: 600;
      color: var(--hm-text, #0F172A);
      font-size: 1.15rem;
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .card-head .mode-badge {
      display: inline-flex;
      align-items: center;
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      background: var(--hm-muted, #64748B);
      color: #ffffff;
    }
    .card-head .mode-badge[data-mode='cool'] {
      background: var(--hm-secondary, #0F766E);
    }
    .card-head .mode-badge[data-mode='heat'] {
      background: var(--hm-error, #DC2626);
    }
    /* Current temp + savings row, two metrics side-by-side. */
    .metrics {
      display: grid;
      grid-template-columns: 1fr auto;
      align-items: end;
      gap: 16px;
    }
    .indoor-wrap {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .indoor {
      font-family: var(--hm-font-heading, Lora, serif);
      font-size: 2.2rem;
      font-weight: 600;
      color: var(--hm-primary, #1E3A8A);
      line-height: 1;
    }
    .outdoor {
      font-size: 0.85rem;
      color: var(--hm-muted, #64748B);
    }
    .savings {
      color: var(--hm-secondary, #0F766E);
      font-weight: 600;
      font-size: 1.1rem;
      text-align: right;
    }
    .chart-error {
      color: var(--hm-error, #DC2626);
      font-size: 12px;
      padding: 12px;
      background: rgba(220, 38, 38, 0.06);
      border-radius: 8px;
    }
    /* Sensor-health badge. Hidden when the status is 'healthy' or
       missing, so a working card stays clean. */
    .health-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      background: rgba(220, 38, 38, 0.08);
      color: var(--hm-error, #DC2626);
      align-self: flex-start;
    }
    .health-badge[hidden] {
      display: none;
    }
    .health-badge[data-status='stale_data'] {
      background: rgba(245, 158, 11, 0.12);
      color: var(--hm-accent, #B45309);
    }
    .pause-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      font-size: 12px;
    }
    .pause-row button {
      padding: 3px 10px;
      border-radius: 999px;
      border: 1px solid rgba(100, 116, 139, 0.25);
      background: var(--hm-bg, #F8FAFC);
      color: var(--hm-text, #0F172A);
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
    }
    .pause-row button:disabled {
      opacity: 0.6;
      cursor: wait;
    }
    .pause-row .paused-until {
      color: var(--hm-muted, #64748B);
    }
    .pause-row .pause-error {
      color: var(--hm-error, #DC2626);
    }
    .multi-hvac-stub {
      padding: 12px;
      border-radius: 8px;
      background: rgba(245, 158, 11, 0.08);
      color: var(--hm-accent, #B45309);
      font-size: 13px;
      line-height: 1.4;
    }
    .multi-hvac-stub code {
      font-family: ui-monospace, monospace;
      font-size: 12px;
    }
    .thermostat {
      font-size: 0.85rem;
      color: var(--hm-muted, #64748B);
    }
    .status-note {
      font-size: 13px;
      line-height: 1.4;
      color: var(--hm-muted, #64748B);
    }
    .card-foot {
      padding-top: 10px;
      border-top: 1px solid rgba(100, 116, 139, 0.2);
      font-size: 13px;
    }
    .card-foot a {
      color: var(--hm-primary, #1E3A8A);
      font-weight: 600;
      text-decoration: none;
    }
    .card-foot a:hover {
      text-decoration: underline;
    }
  `;

  static override properties = {
    hass: { attribute: false },
    _auth: { state: true },
    _schedules: { state: true },
    _rates: { state: true },
    _scheduleError: { state: true },
    _appliancePrefs: { state: true },
    _pauseBusy: { state: true },
    _pauseError: { state: true },
  };

  hass: HassLike | undefined = undefined;
  _auth: AuthState = authStore.state;
  _schedules: SchedulesResponse | null = null;
  _rates: RatesResponse | null = null;
  _scheduleError: string | null = null;
  /**
   * Preferences of the resolved HVAC. Its saved comfort band is drawn
   * on the chart, so an edit shows here before the next plan is made.
   */
  _appliancePrefs: AppliancePreferences | null = null;
  _pauseBusy = false;
  _pauseError = '';

  /** Which appliance `_appliancePrefs` belongs to (guards stale fetches). */
  private _appliancePrefsFor: string | null = null;

  private _config: HmThermostatCardConfig = {};
  private _unsubscribe: (() => void) | null = null;
  private _unsubscribeUnit: (() => void) | null = null;
  private _unsubscribeChartScale: (() => void) | null = null;
  private _scheduleFetchedAt = 0;

  setConfig(config: HmThermostatCardConfig | undefined): void {
    this._config = config ?? {};
    this.requestUpdate();
  }

  getCardSize(): number {
    return 5;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this._auth = authStore.state;
    this._unsubscribe = authStore.subscribe((s) => {
      const wasAuthed = this._auth.status === 'authed';
      this._auth = s;
      if (!wasAuthed && s.status === 'authed') {
        this._scheduleFetchedAt = 0;
        void this._loadIfAuthed();
      } else if (s.status !== 'authed') {
        this._scheduleFetchedAt = 0;
        this._schedules = null;
      }
    });
    this._unsubscribeUnit = temperatureUnitStore.subscribe(() => this.requestUpdate());
    this._unsubscribeChartScale = chartScaleStore.subscribe(() => this.requestUpdate());
    void authStore.hydrate();
    void this._loadIfAuthed();
  }

  override willUpdate(changed: Map<PropertyKey, unknown>): void {
    if (changed.has('hass')) {
      temperatureUnitStore.setHaUnit(haUnitFrom(this.hass));
      // Home Assistant hands the card a new `hass` on every state change,
      // which makes it the clock for a card left open all day: the plan
      // is asked for again once the one in hand is five minutes old.
      void this._loadIfAuthed();
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this._unsubscribeUnit) {
      this._unsubscribeUnit();
      this._unsubscribeUnit = null;
    }
    if (this._unsubscribeChartScale) {
      this._unsubscribeChartScale();
      this._unsubscribeChartScale = null;
    }
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
  }

  private async _loadIfAuthed(): Promise<void> {
    if (this._auth.status !== 'authed') return;
    const now = Date.now();
    if (this._scheduleFetchedAt && now - this._scheduleFetchedAt < CARD_REFRESH_MS) {
      return;
    }
    this._scheduleFetchedAt = now;
    try {
      const [schedules, preferences, rates] = await Promise.all([
        getAllSchedules(),
        getPreferences().catch(() => null as Preferences | null),
        getRates().catch(() => null as RatesResponse | null),
      ]);
      this._schedules = schedules;
      this._scheduleError = null;
      // A failed refresh keeps the price bars already on the chart.
      if (rates) this._rates = rates;
      if (preferences) {
        temperatureUnitStore.setPreference(preferences.temperature_unit ?? null);
        chartScaleStore.setFromPreferences(preferences);
      }
      const appliance = this._resolveAppliance();
      if (appliance) {
        try {
          const prefs = await getAppliancePreferences(appliance.appliance_id);
          this._appliancePrefs = prefs;
          this._appliancePrefsFor = appliance.appliance_id;
        } catch {
          // Best-effort: the chart falls back to the band in the plan.
        }
      } else {
        this._appliancePrefs = null;
        this._appliancePrefsFor = null;
      }
    } catch (err) {
      // With a plan already on screen, keep showing it and try again soon.
      if (!this._schedules) {
        this._scheduleError =
          err instanceof Error && err.message
            ? err.message
            : 'Could not load schedule';
      }
      this._scheduleFetchedAt = now - CARD_REFRESH_MS + CARD_RETRY_MS;
    }
  }

  /**
   * Resolve which HVAC appliance this card targets:
   *   - `appliance_id` in card config → match by id
   *   - exactly one HVAC, no id → that one
   *   - 2+ HVACs, no id → null (caller renders a "configure appliance_id"
   *     stub so we don't silently show the wrong room)
   *   - zero HVACs → null
   */
  private _resolveAppliance(): ApplianceScheduleEntry | null {
    const appliances = this._schedules?.appliances;
    if (!Array.isArray(appliances) || appliances.length === 0) return null;
    const hvacs = appliances.filter((a) => a.appliance_type === 'hvac');
    if (hvacs.length === 0) return null;
    const configuredId = this._config.appliance_id;
    if (configuredId) {
      return hvacs.find((a) => a.appliance_id === configuredId) ?? null;
    }
    if (hvacs.length === 1) return hvacs[0];
    return null;
  }

  /** POST a pause or resume, reload the schedules entry, and nudge the
   * integration so the thermostat follows without waiting for :00/:30. */
  private async _postPause(
    appliance: ApplianceScheduleEntry,
    minutes: number | null,
  ): Promise<void> {
    if (this._pauseBusy) return;
    this._pauseBusy = true;
    this._pauseError = '';
    try {
      if (minutes === null) await resumeUnit(appliance.appliance_id);
      else await pauseUnit(appliance.appliance_id, minutes);
      this._scheduleFetchedAt = 0;
      await this._loadIfAuthed();
      const hass = this.hass;
      if (hass && typeof hass.callService === 'function') {
        try {
          await hass.callService('hungry_machines', 'apply_now', {});
        } catch {
          // Older integration without the service: next :00/:30 tick applies it.
        }
      }
    } catch {
      this._pauseError =
        minutes === null ? 'Could not resume. Try again.' : 'Could not pause. Try again.';
    } finally {
      this._pauseBusy = false;
    }
  }

  private _renderPauseRow(entry: ApplianceScheduleEntry | null): TemplateResult | null {
    if (!entry || entry.appliance_type !== 'hvac') return null;
    const state = entry.pause_state;
    if (state !== 'active' && state !== 'timed') return null;
    const busy = this._pauseBusy;
    const error = this._pauseError;
    if (state === 'timed') {
      return html`
        <div class="pause-row">
          <span class="paused-until">${pausedUntilLabel(entry.paused_until)}</span>
          <button
            type="button"
            name="resume_now"
            ?disabled=${busy}
            @click=${() => this._postPause(entry, null)}
          >Resume now</button>
          <span class="pause-error">${error}</span>
        </div>
      `;
    }
    const button = (hours: number) => html`
      <button
        type="button"
        name=${`pause_${hours}h`}
        ?disabled=${busy}
        title=${`Leave this unit to you for ${hours} hours, then the plan takes it back.`}
        @click=${() => this._postPause(entry, hours * 60)}
      >Pause ${hours} h</button>
    `;
    return html`
      <div class="pause-row">
        ${button(2)}${button(4)}${button(6)}
        <span class="pause-error">${error}</span>
      </div>
    `;
  }

  private _isMultiHvacUnresolved(): boolean {
    const appliances = this._schedules?.appliances;
    if (!Array.isArray(appliances)) return false;
    const hvacs = appliances.filter((a) => a.appliance_type === 'hvac');
    return hvacs.length >= 2 && !this._config.appliance_id;
  }

  private _readEntityState(entityId: string | undefined): string | null {
    if (!entityId) return null;
    const states = this.hass?.states;
    if (!states) return null;
    const entity = states[entityId];
    if (!entity) return null;
    const state = entity.state;
    if (typeof state === 'string' || typeof state === 'number') {
      return String(state);
    }
    return null;
  }

  private _formatTemp(entityId: string | undefined, raw: string | null): string {
    if (raw === null) return '—';
    const n = Number(raw);
    if (!Number.isFinite(n)) return `${raw}°`;
    const attrUnit = this.hass?.states?.[entityId ?? '']?.attributes?.unit_of_measurement;
    const source =
      attrUnit === '°C' ? 'C' : attrUnit === '°F' ? 'F' : temperatureUnitStore.state.haUnit ?? 'F';
    return `${liveTemp(n, source, temperatureUnitStore.state.unit)}°`;
  }

  /** A thermostat attribute, which Home Assistant reports in its own unit. */
  private _formatClimateTemp(value: unknown): string | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    const source = temperatureUnitStore.state.haUnit ?? 'F';
    return `${liveTemp(value, source, temperatureUnitStore.state.unit)}°`;
  }

  /**
   * The indoor reading to show, in this order: the entity named in the
   * card config, the indoor sensor mapped to the appliance, then the
   * thermostat's own reading. Null when none of them is available.
   */
  private _indoorReadout(entry: ApplianceScheduleEntry | null): string | null {
    const configured = this._config.entities?.indoor_temp;
    if (configured) return this._formatTemp(configured, this._readEntityState(configured));
    const sensor = entry?.entities?.['indoor_temp_entity_id'];
    const sensorRaw = this._readEntityState(sensor);
    if (sensorRaw !== null && Number.isFinite(Number(sensorRaw))) {
      return this._formatTemp(sensor, sensorRaw);
    }
    const climate = this.hass?.states?.[entry?.entities?.['entity_id'] ?? ''];
    return this._formatClimateTemp(climate?.attributes?.['current_temperature']);
  }

  /** "Set to 74° · cooling", from the thermostat's live state. */
  private _thermostatReadout(entry: ApplianceScheduleEntry | null): string | null {
    const climate = this.hass?.states?.[entry?.entities?.['entity_id'] ?? ''];
    if (!climate) return null;
    const attrs = climate.attributes ?? {};
    const single = this._formatClimateTemp(attrs['temperature']);
    const low = this._formatClimateTemp(attrs['target_temp_low']);
    const high = this._formatClimateTemp(attrs['target_temp_high']);
    const parts: string[] = [];
    if (climate.state === 'off') parts.push('Thermostat off');
    else if (single) parts.push(`Set to ${single}`);
    else if (low && high) parts.push(`Set to ${low} to ${high}`);
    const action = attrs['hvac_action'];
    if (typeof action === 'string' && action && action !== 'off') parts.push(action);
    return parts.length > 0 ? parts.join(' · ') : null;
  }

  /** One line under the readouts for a day that is not a normal plan day. */
  private _statusNote(entry: ApplianceScheduleEntry | null): string {
    if (!entry) return '';
    if (entry.pause_state === 'master') {
      return 'Optimization is paused for the whole home. Turn it back on in the panel.';
    }
    if (entry.pause_state === 'manual') {
      return 'Optimization is paused for this unit. Turn it back on in the panel.';
    }
    const sched = entry.schedule ?? {};
    if (entry.source === 'defaults' || Object.keys(sched).length === 0) {
      return 'No plan for this unit yet.';
    }
    if (entry.stale) return "Today's plan is not ready yet. Showing the most recent one.";
    if (sched['calibration']) return 'A warm-up test is planned for today, 09:00 to 15:00.';
    if (sched['idle_day'] === true) {
      return 'Idle day: no heating or cooling is planned.';
    }
    return '';
  }

  private _onOpenPanel(e: Event): void {
    e.preventDefault();
    openPanel();
  }

  override render(): TemplateResult {
    if (this._auth.status !== 'authed') {
      return html`
        <div class="stub">
          Sign in from the Hungry Machines panel to see your schedule.
        </div>
      `;
    }

    const entities = this._config.entities ?? {};
    const outdoorRaw = this._readEntityState(entities.outdoor_temp);

    const entry = this._resolveAppliance();
    const multiHvacUnresolved = this._isMultiHvacUnresolved();
    const sched = (entry?.schedule ?? {}) as Record<string, unknown>;
    // A stored plan is 'cool' or 'heat'. With no plan there is no mode to
    // show, so the badge is left out.
    const modeRaw = sched['mode'];
    const planMode = typeof modeRaw === 'string' ? modeRaw.toLowerCase() : '';
    const mode = sched['idle_day'] === true ? 'idle' : planMode;

    const ratesArr = this._rates?.rates_cents_per_kwh;
    const rates: number[] =
      Array.isArray(ratesArr) && ratesArr.length === 48
        ? ratesArr
        : new Array(48).fill(0);
    // The appliance's saved comfort band wins over the one stored with
    // the plan, as it does in the panel, so an edit shows without waiting
    // for the next plan. A day with its own band shows that band.
    const prefs =
      entry && this._appliancePrefsFor === entry.appliance_id ? this._appliancePrefs : null;
    const dayBand =
      prefs && hasHourlyComfortBands(prefs)
        ? resolveDayBand(prefs, weekdayKeyOf(todayIsoLocal()))
        : null;
    const highLimits = dayBand
      ? expandHourlyTo48(dayBand.high)
      : this._asNumberArray(sched['high_temps']);
    const lowLimits = dayBand
      ? expandHourlyTo48(dayBand.low)
      : this._asNumberArray(sched['low_temps']);
    // Prefer the backend's clamped per-interval setpoints. Falls back to
    // temp_trajectory for legacy schedule rows.
    const targetValues =
      this._asNumberArray(sched['setpoint_temps']) ??
      this._asNumberArray(sched['temp_trajectory']);

    const savingsPct = entry?.savings_pct;
    // A paused unit has no plan running, so there is no estimate to show.
    const hasPlan =
      !!entry &&
      entry.source !== 'defaults' &&
      entry.pause_state !== 'manual' &&
      entry.pause_state !== 'master';
    const savingsText =
      hasPlan && typeof savingsPct === 'number' ? formatSavingsEstimate(savingsPct) : '';

    const name = entry?.name ?? 'Thermostat';
    const health = entry?.integration_health;
    const healthHidden = !health || health.status === 'healthy';
    const indoor = this._indoorReadout(entry);
    const thermostat = this._thermostatReadout(entry);
    const statusNote = this._statusNote(entry);

    return html`
      <div class="card" data-appliance-type="hvac">
        <div class="card-head">
          <span class="badge" aria-hidden="true">HVAC</span>
          <span class="name">${name}</span>
          ${mode ? html`<span class="mode-badge" data-mode=${mode}>${mode}</span>` : null}
        </div>
        <div
          class="health-badge"
          data-status=${health?.status ?? 'healthy'}
          ?hidden=${healthHidden}
        >
          ${healthLabel(health)}
        </div>
        ${this._renderPauseRow(entry ?? null)}
        ${multiHvacUnresolved
          ? html`<div class="multi-hvac-stub">
              You have multiple HVAC appliances. Add
              <code>appliance_id</code> to this card's config to pick
              which one it shows.
            </div>`
          : null}
        <div class="metrics">
          <div class="indoor-wrap">
            ${indoor !== null ? html`<span class="indoor">${indoor}</span>` : null}
            ${thermostat !== null ? html`<span class="thermostat">${thermostat}</span>` : null}
            ${entities.outdoor_temp
              ? html`<span class="outdoor">
                  Outside ${this._formatTemp(entities.outdoor_temp, outdoorRaw)}
                </span>`
              : null}
          </div>
          ${savingsText
            ? html`<div class="savings" title=${savingsEstimateTitle(sched)}>${savingsText}</div>`
            : null}
        </div>
        ${statusNote ? html`<div class="status-note">${statusNote}</div>` : null}
        ${this._scheduleError
          ? html`<div class="chart-error">${this._scheduleError}</div>`
          : html`<hm-optimization-chart
              .rates=${rates}
              .highLimits=${highLimits}
              .lowLimits=${lowLimits}
              .targetValues=${targetValues}
              .unit=${'fahrenheit'}
              .displayUnit=${temperatureUnitStore.state.unit}
              .yMin=${40}
              .yMax=${100}
              .scale=${chartScaleStore.state.temperature}
              .size=${'medium'}
            ></hm-optimization-chart>`}
        <div class="card-foot">
          <a href=${PANEL_PATH} @click=${(e: Event) => this._onOpenPanel(e)}>
            Edit comfort range in Hungry Machines
          </a>
        </div>
      </div>
    `;
  }

  /**
   * Convert an unknown schedule field into a length-48 number array.
   * Returns undefined when the field isn't an array, has the wrong
   * length, or any element fails Number.isFinite — the chart's own
   * empty-state then renders instead of a misshapen plot.
   */
  private _asNumberArray(v: unknown): number[] | undefined {
    if (!Array.isArray(v) || v.length !== 48) return undefined;
    const out: number[] = [];
    for (const x of v) {
      const n = Number(x);
      if (!Number.isFinite(n)) return undefined;
      out.push(n);
    }
    return out;
  }
}
