import { LitElement, html, css, type TemplateResult } from 'lit';
import { authStore, type AuthState } from '../store.js';
import {
  getAllSchedules,
  type ApplianceScheduleEntry,
  type InlineIntegrationHealth,
  type SchedulesResponse,
} from '../api/schedules.js';
import {
  get as getPreferences,
  update as updatePreferences,
  type Preferences,
} from '../api/preferences.js';
import {
  get as getAppliancePreferences,
  update as updateAppliancePreferences,
  type AppliancePreferences,
} from '../api/appliance-preferences.js';
import { get as getRates, type RatesResponse } from '../api/rates.js';
import { hasHourlyComfortBands } from '../utils/hourly.js';

export interface HmThermostatCardConfig {
  type?: string;
  /**
   * UUID of the HVAC appliance this card represents. Required when the
   * user has more than one HVAC registered; with exactly one HVAC the
   * card resolves to it automatically (US-MHVAC-018 back-compat).
   */
  appliance_id?: string;
  entities?: {
    indoor_temp?: string;
    outdoor_temp?: string;
    hvac_action?: string;
  };
}

type HassStateLike = {
  entity_id?: string;
  state?: unknown;
  attributes?: Record<string, unknown>;
};
type HassLike = { states?: Record<string, HassStateLike> };

const SCHEDULE_TTL_MS = 5 * 60 * 1000;
const PREFERENCES_DEBOUNCE_MS = 500;

/**
 * Lovelace card on the HA Overview that mirrors the per-appliance card
 * from the Hungry Machines dashboard panel — same `.card` chrome,
 * badge + name header, savings line, and the rich
 * `<hm-optimization-chart>` (price bars + comfort band + setpoint line).
 *
 * Adds two affordances the panel card doesn't have, since this lives on
 * the user's main HA Overview where their actual indoor/outdoor sensors
 * are reachable through `hass.states`:
 *   * Current indoor / outdoor temperature readout (live, not from the
 *     schedule), pulled from `config.entities.indoor_temp` /
 *     `config.entities.outdoor_temp`.
 *   * In-place "Savings level" slider that PUTs `/api/v1/preferences`
 *     on debounce — the panel exposes the same control inside the
 *     constraint editor, but jumping to the panel from the overview
 *     would be heavy for a 1-tap change.
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
    .card-head .mode-badge[data-mode='off'] {
      background: var(--hm-muted, #64748B);
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
    .missing-entity {
      font-size: 13px;
      color: var(--hm-muted, #64748B);
    }
    .missing-entity a {
      color: var(--hm-primary, #1E3A8A);
      text-decoration: underline;
    }
    .chart-error {
      color: var(--hm-error, #DC2626);
      font-size: 12px;
      padding: 12px;
      background: rgba(220, 38, 38, 0.06);
      border-radius: 8px;
    }
    /* Per-appliance integration-health badge inlined from /schedules
       (US-MHVAC-014). Hidden when status is 'healthy' or missing so a
       working card stays clean; muted-red chip for any non-healthy
       verdict. */
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
    .slider-row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding-top: 10px;
      border-top: 1px solid rgba(100, 116, 139, 0.2);
    }
    .slider-row label {
      font-size: 13px;
      color: var(--hm-text, #0F172A);
      font-weight: 600;
    }
    .slider-row input[type='range'] {
      flex: 1;
      accent-color: var(--hm-primary, #1E3A8A);
    }
    .slider-value {
      width: 20px;
      text-align: center;
      font-weight: 700;
      color: var(--hm-primary, #1E3A8A);
    }
    .bands-hint {
      font-size: 12px;
      line-height: 1.4;
      color: var(--hm-muted, #64748B);
      padding: 0 4px;
    }
  `;

  static override properties = {
    hass: { attribute: false },
    _auth: { state: true },
    _schedules: { state: true },
    _rates: { state: true },
    _scheduleError: { state: true },
    _savingsLevel: { state: true },
    _appliancePrefs: { state: true },
  };

  hass: HassLike | undefined = undefined;
  _auth: AuthState = authStore.state;
  _schedules: SchedulesResponse | null = null;
  _rates: RatesResponse | null = null;
  _scheduleError: string | null = null;
  _savingsLevel = 3;
  /**
   * Per-appliance preferences for the resolved HVAC. Preferences are
   * per-appliance since US-MHVAC-017 — the user-level row is only a
   * fallback for HVACs with no row yet, so both the savings-slider
   * write and the "custom hourly limits active" hint key off this.
   */
  _appliancePrefs: AppliancePreferences | null = null;

  /** Which appliance `_appliancePrefs` belongs to (guards stale fetches). */
  private _appliancePrefsFor: string | null = null;

  private _config: HmThermostatCardConfig = {};
  private _unsubscribe: (() => void) | null = null;
  private _scheduleFetchedAt = 0;
  private _preferencesTimer: ReturnType<typeof setTimeout> | null = null;

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
    void authStore.hydrate();
    void this._loadIfAuthed();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
    if (this._preferencesTimer !== null) {
      clearTimeout(this._preferencesTimer);
      this._preferencesTimer = null;
    }
  }

  private async _loadIfAuthed(): Promise<void> {
    if (this._auth.status !== 'authed') return;
    const now = Date.now();
    if (this._scheduleFetchedAt && now - this._scheduleFetchedAt < SCHEDULE_TTL_MS) {
      return;
    }
    this._scheduleFetchedAt = now;
    this._scheduleError = null;
    try {
      const [schedules, preferences, rates] = await Promise.all([
        getAllSchedules(),
        getPreferences().catch(() => null as Preferences | null),
        getRates().catch(() => null as RatesResponse | null),
      ]);
      this._schedules = schedules;
      this._rates = rates;
      if (preferences && typeof preferences.savings_level === 'number') {
        this._savingsLevel = this._clampLevel(preferences.savings_level);
      }
      // Preferences live on the per-appliance row (US-MHVAC-017); the
      // user-level value read above is only the fallback for an HVAC
      // that has no row yet. Without this, the slider showed — and
      // wrote — a user-level value the optimizer never reads once a
      // per-appliance row exists.
      const appliance = this._resolveAppliance();
      if (appliance) {
        try {
          const prefs = await getAppliancePreferences(appliance.appliance_id);
          this._appliancePrefs = prefs;
          this._appliancePrefsFor = appliance.appliance_id;
          if (typeof prefs.savings_level === 'number') {
            this._savingsLevel = this._clampLevel(prefs.savings_level);
          }
        } catch {
          // Best-effort: keep the user-level seed; the write path
          // still targets the per-appliance endpoint.
        }
      } else {
        this._appliancePrefs = null;
        this._appliancePrefsFor = null;
      }
    } catch (err) {
      this._scheduleError =
        err instanceof Error && err.message
          ? err.message
          : 'Could not load schedule';
      this._scheduleFetchedAt = 0;
    }
  }

  /**
   * Resolve which HVAC appliance this card targets:
   *   - `appliance_id` in card config → match by id
   *   - exactly one HVAC, no id → back-compat resolve to that one
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

  private _isMultiHvacUnresolved(): boolean {
    const appliances = this._schedules?.appliances;
    if (!Array.isArray(appliances)) return false;
    const hvacs = appliances.filter((a) => a.appliance_type === 'hvac');
    return hvacs.length >= 2 && !this._config.appliance_id;
  }

  private _clampLevel(n: number): number {
    if (!Number.isFinite(n)) return 3;
    const rounded = Math.round(n);
    if (rounded < 1) return 1;
    if (rounded > 3) return 3;
    return rounded;
  }

  private _onSavingsInput(e: Event): void {
    const target = e.target as HTMLInputElement;
    const raw = Number(target.value);
    const level = this._clampLevel(raw);
    this._savingsLevel = level;
    if (this._preferencesTimer !== null) {
      clearTimeout(this._preferencesTimer);
    }
    this._preferencesTimer = setTimeout(() => {
      this._preferencesTimer = null;
      // Write to the per-appliance row when this card resolves to an
      // HVAC — the nightly optimizer reads per-appliance preferences
      // and ignores the user-level value once a row exists, so the
      // user-level PUT alone was a silent no-op (US-MHVAC-017).
      const appliance = this._resolveAppliance();
      const write = appliance
        ? updateAppliancePreferences(appliance.appliance_id, {
            savings_level: level,
          }).then((prefs) => {
            this._appliancePrefs = prefs;
            this._appliancePrefsFor = appliance.appliance_id;
          })
        : updatePreferences({ savings_level: level }).then(() => undefined);
      void write.catch(() => {
        /* swallow — retry on next change */
      });
    }, PREFERENCES_DEBOUNCE_MS);
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

  private _formatTemp(raw: string | null, unit = '°'): string {
    if (raw === null) return '—';
    const n = Number(raw);
    if (Number.isFinite(n)) {
      return `${Math.round(n)}${unit}`;
    }
    return `${raw}${unit}`;
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
    const indoorRaw = this._readEntityState(entities.indoor_temp);
    const outdoorRaw = this._readEntityState(entities.outdoor_temp);
    const indoorConfigured = !!entities.indoor_temp;

    const entry = this._resolveAppliance();
    const multiHvacUnresolved = this._isMultiHvacUnresolved();
    const sched = (entry?.schedule ?? {}) as Record<string, unknown>;
    const modeRaw = sched['mode'];
    const mode =
      (typeof modeRaw === 'string' ? modeRaw : '').toLowerCase() || 'auto';

    const ratesArr = this._rates?.rates_cents_per_kwh;
    const rates: number[] =
      Array.isArray(ratesArr) && ratesArr.length === 48
        ? ratesArr
        : new Array(48).fill(0);
    const highLimits = this._asNumberArray(sched['high_temps']);
    const lowLimits = this._asNumberArray(sched['low_temps']);
    // Prefer the backend's clamped per-interval setpoints. Falls back to
    // temp_trajectory for legacy schedule rows.
    const targetValues =
      this._asNumberArray(sched['setpoint_temps']) ??
      this._asNumberArray(sched['temp_trajectory']);

    const savingsPct = entry?.savings_pct;
    const savingsText =
      typeof savingsPct === 'number'
        ? `${Math.round(savingsPct)}% savings today`
        : '';

    const name = entry?.name ?? 'Thermostat';
    const health = entry?.integration_health;
    const healthHidden = !health || health.status === 'healthy';
    // The savings slider only drives the SIMPLE comfort schedule.
    // When this appliance runs custom hourly limits, say so instead of
    // presenting a control that silently does nothing.
    const customBandsActive =
      !!entry &&
      this._appliancePrefsFor === entry.appliance_id &&
      !!this._appliancePrefs &&
      hasHourlyComfortBands(this._appliancePrefs);

    return html`
      <div class="card" data-appliance-type="hvac">
        <div class="card-head">
          <span class="badge" aria-hidden="true">HVAC</span>
          <span class="name">${name}</span>
          <span class="mode-badge" data-mode=${mode}>${mode}</span>
        </div>
        <div
          class="health-badge"
          data-status=${health?.status ?? 'healthy'}
          ?hidden=${healthHidden}
        >
          ${this._healthLabel(health)}
        </div>
        ${multiHvacUnresolved
          ? html`<div class="multi-hvac-stub">
              You have multiple HVAC appliances. Add
              <code>appliance_id</code> to this card's config to pick
              which one it controls.
            </div>`
          : null}
        <div class="metrics">
          <div class="indoor-wrap">
            ${indoorConfigured
              ? html`<span class="indoor">${this._formatTemp(indoorRaw)}</span>`
              : html`<span class="missing-entity">
                  Indoor temperature entity not set.
                  <a href="#hm-panel">Configure in HM panel</a>
                </span>`}
            ${entities.outdoor_temp
              ? html`<span class="outdoor">
                  Outside ${this._formatTemp(outdoorRaw)}
                </span>`
              : null}
          </div>
          ${savingsText
            ? html`<div class="savings">${savingsText}</div>`
            : null}
        </div>
        ${this._scheduleError
          ? html`<div class="chart-error">${this._scheduleError}</div>`
          : html`<hm-optimization-chart
              .rates=${rates}
              .highLimits=${highLimits}
              .lowLimits=${lowLimits}
              .targetValues=${targetValues}
              .unit=${'fahrenheit'}
              .yMin=${40}
              .yMax=${100}
              .size=${'medium'}
            ></hm-optimization-chart>`}
        <div class="slider-row">
          <label for="hm-savings-level">Savings level</label>
          <input
            id="hm-savings-level"
            name="savings_level"
            type="range"
            min="1"
            max="3"
            step="1"
            ?disabled=${customBandsActive}
            .value=${String(this._savingsLevel)}
            @input=${(e: Event) => this._onSavingsInput(e)}
          />
          <span class="slider-value">${this._savingsLevel}</span>
        </div>
        ${customBandsActive
          ? html`<div class="bands-hint">
              Custom hourly limits are active for this device, so the
              savings level doesn't apply. Switch back to the simple
              schedule in the Hungry Machines panel to use it.
            </div>`
          : null}
      </div>
    `;
  }

  private _healthLabel(health: InlineIntegrationHealth | undefined): string {
    if (!health) return '';
    if (health.message) return health.message;
    switch (health.status) {
      case 'stale_data':
        return 'Sensor data is stale.';
      case 'frozen_sensor':
        return 'Indoor sensor appears stuck.';
      case 'no_data':
        return 'No recent sensor data.';
      default:
        return '';
    }
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
