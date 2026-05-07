import { LitElement, html, css, type TemplateResult } from 'lit';
import { authStore, type AuthState } from '../store.js';
import { getHvacSchedule, type HvacScheduleResponse } from '../api/schedules.js';
import {
  get as getPreferences,
  update as updatePreferences,
  type Preferences,
} from '../api/preferences.js';
import { get as getRates, type RatesResponse } from '../api/rates.js';

export interface HmThermostatCardConfig {
  type?: string;
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

export class HmThermostatCard extends LitElement {
  static override styles = css`
    :host {
      display: block;
      font-family: var(--hm-font-body, sans-serif);
      color: var(--hm-text, #0F172A);
      background: var(--hm-bg, #F8FAFC);
      border-radius: 10px;
      padding: 16px;
      box-sizing: border-box;
    }
    .stub {
      padding: 12px;
      color: var(--hm-muted, #64748B);
      font-size: 14px;
    }
    .temps {
      display: flex;
      align-items: baseline;
      gap: 16px;
      margin-bottom: 10px;
    }
    .indoor {
      font-family: var(--hm-font-heading, serif);
      font-size: 2.5rem;
      font-weight: 600;
      color: var(--hm-primary, #1E3A8A);
      line-height: 1;
    }
    .outdoor {
      font-size: 0.95rem;
      color: var(--hm-muted, #64748B);
    }
    .missing-entity {
      font-size: 13px;
      color: var(--hm-muted, #64748B);
    }
    .missing-entity a {
      color: var(--hm-primary, #1E3A8A);
      text-decoration: underline;
    }
    .mode-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 12px;
    }
    .mode-badge {
      display: inline-flex;
      align-items: center;
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      text-transform: capitalize;
      background: var(--hm-primary, #1E3A8A);
      color: #ffffff;
    }
    .mode-badge[data-mode='heat'] {
      background: var(--hm-error, #DC2626);
    }
    .mode-badge[data-mode='cool'] {
      background: var(--hm-secondary, #0F766E);
    }
    .mode-badge[data-mode='off'] {
      background: var(--hm-muted, #64748B);
    }
    .chart-row {
      margin-bottom: 12px;
    }
    .chart-error {
      color: var(--hm-error, #DC2626);
      font-size: 12px;
    }
    .slider-row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding-top: 8px;
      border-top: 1px solid rgba(100, 116, 139, 0.25);
    }
    .slider-row label {
      font-size: 13px;
      color: var(--hm-text, #0F172A);
    }
    .slider-row input[type='range'] {
      flex: 1;
    }
    .slider-value {
      width: 24px;
      text-align: center;
      font-weight: 600;
      color: var(--hm-primary, #1E3A8A);
    }
    .unit {
      font-size: 0.9rem;
      color: var(--hm-muted, #64748B);
      margin-left: 4px;
    }
  `;

  static override properties = {
    hass: { attribute: false },
    _auth: { state: true },
    _schedule: { state: true },
    _rates: { state: true },
    _scheduleError: { state: true },
    _savingsLevel: { state: true },
  };

  hass: HassLike | undefined = undefined;
  _auth: AuthState = authStore.state;
  _schedule: HvacScheduleResponse | null = null;
  _rates: RatesResponse | null = null;
  _scheduleError: string | null = null;
  _savingsLevel = 3;

  private _config: HmThermostatCardConfig = {};
  private _unsubscribe: (() => void) | null = null;
  private _scheduleFetchedAt = 0;
  private _preferencesTimer: ReturnType<typeof setTimeout> | null = null;

  setConfig(config: HmThermostatCardConfig | undefined): void {
    this._config = config ?? {};
    this.requestUpdate();
  }

  getCardSize(): number {
    return 4;
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
        this._schedule = null;
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
      const [schedule, preferences, rates] = await Promise.all([
        getHvacSchedule(),
        getPreferences().catch(() => null as Preferences | null),
        getRates().catch(() => null as RatesResponse | null),
      ]);
      this._schedule = schedule;
      this._rates = rates;
      if (preferences && typeof preferences.savings_level === 'number') {
        this._savingsLevel = this._clampLevel(preferences.savings_level);
      }
    } catch (err) {
      this._scheduleError =
        err instanceof Error && err.message
          ? err.message
          : 'Could not load schedule';
      this._scheduleFetchedAt = 0;
    }
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
      void updatePreferences({ savings_level: level }).catch(() => {
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
    const mode = (this._schedule?.mode ?? '').toLowerCase() || 'auto';

    const ratesArr = this._rates?.rates_cents_per_kwh;
    const rates: number[] =
      Array.isArray(ratesArr) && ratesArr.length === 48
        ? ratesArr
        : new Array(48).fill(0);
    const highTemps = this._schedule?.schedule?.high_temps;
    const lowTemps = this._schedule?.schedule?.low_temps;

    return html`
      <div class="temps">
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
      <div class="mode-row">
        <span class="mode-badge" data-mode=${mode}>${mode}</span>
        ${this._schedule?.estimated_savings_pct !== undefined
          ? html`<span class="unit">
              ${Math.round(this._schedule.estimated_savings_pct)}% savings today
            </span>`
          : null}
      </div>
      <div class="chart-row">
        ${this._scheduleError
          ? html`<div class="chart-error">${this._scheduleError}</div>`
          : html`<hm-schedule-chart
              .rates=${rates}
              .highTemps=${highTemps}
              .lowTemps=${lowTemps}
              unit="fahrenheit"
            ></hm-schedule-chart>`}
      </div>
      <div class="slider-row">
        <label for="hm-savings-level">Savings level</label>
        <input
          id="hm-savings-level"
          name="savings_level"
          type="range"
          min="1"
          max="3"
          step="1"
          .value=${String(this._savingsLevel)}
          @input=${(e: Event) => this._onSavingsInput(e)}
        />
        <span class="slider-value">${this._savingsLevel}</span>
      </div>
    `;
  }
}
