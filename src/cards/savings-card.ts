import { LitElement, html, css, type TemplateResult } from 'lit';
import { authStore, type AuthState } from '../store.js';
import {
  getAllSchedules,
  type ApplianceScheduleEntry,
  type SchedulesResponse,
} from '../api/schedules.js';
import { formatSavingsEstimate, savingsEstimateTitle } from '../utils/savings.js';
import {
  CARD_REFRESH_MS,
  CARD_RETRY_MS,
  PANEL_PATH,
  formatPower,
  healthLabel,
  nextScheduledSlot,
  openPanel,
  pausedUntilLabel,
  slotTimeLabel,
} from '../utils/cards.js';

export interface HmSavingsCardConfig {
  type?: string;
  /**
   * UUID of one appliance. When set, the card shows that appliance's
   * estimate, its next scheduled run and, for an HVAC, its sensor health.
   * Omitted → one row per appliance that gets a plan.
   */
  appliance_id?: string;
  entities?: {
    power?: string;
  };
}

type HassStateLike = {
  entity_id?: string;
  state?: unknown;
  attributes?: Record<string, unknown>;
};
type HassLike = { states?: Record<string, HassStateLike> };

/** Appliance types that get a plan, and so a savings estimate. Solar is
 * forecast and a dehumidifier is only recorded. */
function isPlanned(entry: ApplianceScheduleEntry): boolean {
  return entry.appliance_type !== 'solar' && entry.appliance_type !== 'dehumidifier';
}

function isPaused(entry: ApplianceScheduleEntry): boolean {
  if (entry.optimization_enabled === false) return true;
  const state = entry.pause_state;
  return state === 'timed' || state === 'manual' || state === 'master';
}

function hasPlan(entry: ApplianceScheduleEntry): boolean {
  return entry.source !== 'defaults' && Object.keys(entry.schedule ?? {}).length > 0;
}

/**
 * Lovelace card with today's estimated savings, appliance by appliance,
 * as the panel shows them. Each estimate is a share of that appliance's
 * own cost, so the card lists them and does not add or average them.
 */
export class HmSavingsCard extends LitElement {
  static override styles = css`
    :host {
      display: block;
      font-family: var(--hm-font-body, system-ui, sans-serif);
      color: var(--hm-text, #0F172A);
    }
    /* Matches .card from the panel so the cards read as siblings. */
    .card,
    .stub {
      background: #ffffff;
      border: 1px solid rgba(100, 116, 139, 0.2);
      border-radius: 14px;
      padding: 20px;
    }
    .card {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .stub {
      color: var(--hm-muted, #64748B);
      font-size: 14px;
    }
    .title {
      font-family: var(--hm-font-heading, Lora, serif);
      font-weight: 600;
      font-size: 1.15rem;
    }
    .savings {
      font-family: var(--hm-font-heading, Lora, serif);
      font-size: 1.6rem;
      font-weight: 600;
      color: var(--hm-secondary, #0F766E);
      line-height: 1.1;
    }
    .next-run,
    .empty {
      font-size: 0.9rem;
      color: var(--hm-muted, #64748B);
    }
    .rows {
      display: flex;
      flex-direction: column;
    }
    .row {
      display: grid;
      grid-template-columns: 1fr auto;
      column-gap: 12px;
      align-items: baseline;
      padding: 8px 0;
      border-top: 1px solid rgba(100, 116, 139, 0.2);
    }
    .row:first-child {
      border-top: none;
      padding-top: 0;
    }
    .row-name {
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .row-savings {
      font-weight: 600;
      color: var(--hm-secondary, #0F766E);
    }
    .row-status {
      grid-column: 1 / -1;
      font-size: 0.85rem;
      color: var(--hm-muted, #64748B);
    }
    .row-status[data-health] {
      color: var(--hm-error, #DC2626);
    }
    .row-status[data-health='stale_data'] {
      color: var(--hm-accent, #B45309);
    }
    .power-row {
      display: flex;
      align-items: baseline;
      gap: 8px;
      padding-top: 10px;
      border-top: 1px solid rgba(100, 116, 139, 0.2);
    }
    .power-row[hidden] {
      display: none;
    }
    .power-label {
      font-size: 0.85rem;
      color: var(--hm-muted, #64748B);
    }
    .power-value {
      font-size: 1.1rem;
      font-weight: 600;
      color: var(--hm-primary, #1E3A8A);
    }
    .error {
      color: var(--hm-error, #DC2626);
      font-size: 0.85rem;
    }
    .error[hidden] {
      display: none;
    }
    .health-badge {
      display: inline-flex;
      align-items: center;
      align-self: flex-start;
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      background: rgba(220, 38, 38, 0.08);
      color: var(--hm-error, #DC2626);
    }
    .health-badge[hidden] {
      display: none;
    }
    .health-badge[data-status='stale_data'] {
      background: rgba(245, 158, 11, 0.12);
      color: var(--hm-accent, #B45309);
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
    _error: { state: true },
  };

  hass: HassLike | undefined = undefined;
  _auth: AuthState = authStore.state;
  _schedules: SchedulesResponse | null = null;
  _error: string | null = null;

  private _config: HmSavingsCardConfig = {};
  private _unsubscribe: (() => void) | null = null;
  private _fetchedAt = 0;

  setConfig(config: HmSavingsCardConfig | undefined): void {
    this._config = config ?? {};
    this.requestUpdate();
  }

  getCardSize(): number {
    return this._config.appliance_id ? 2 : 3;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this._auth = authStore.state;
    this._unsubscribe = authStore.subscribe((s) => {
      const wasAuthed = this._auth.status === 'authed';
      this._auth = s;
      if (!wasAuthed && s.status === 'authed') {
        this._fetchedAt = 0;
        void this._loadIfAuthed();
      } else if (s.status !== 'authed') {
        this._fetchedAt = 0;
        this._schedules = null;
      }
    });
    void authStore.hydrate();
    void this._loadIfAuthed();
  }

  override willUpdate(changed: Map<PropertyKey, unknown>): void {
    // Home Assistant hands the card a new `hass` on every state change,
    // which makes it the clock for a card left open all day: the plans
    // are asked for again once the ones in hand are five minutes old.
    if (changed.has('hass')) void this._loadIfAuthed();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
  }

  private async _loadIfAuthed(): Promise<void> {
    if (this._auth.status !== 'authed') return;
    const now = Date.now();
    if (this._fetchedAt && now - this._fetchedAt < CARD_REFRESH_MS) {
      return;
    }
    this._fetchedAt = now;
    try {
      this._schedules = await getAllSchedules();
      this._error = null;
    } catch (err) {
      // With plans already on screen, keep showing them and try again soon.
      if (!this._schedules) {
        this._error =
          err instanceof Error && err.message ? err.message : 'Could not load schedules';
      }
      this._fetchedAt = now - CARD_REFRESH_MS + CARD_RETRY_MS;
    }
  }

  /** The appliance named by `appliance_id`, of any type. */
  private _resolveAppliance(): ApplianceScheduleEntry | null {
    const configuredId = this._config.appliance_id;
    if (!configuredId) return null;
    const appliances = this._schedules?.appliances;
    if (!Array.isArray(appliances) || appliances.length === 0) return null;
    return appliances.find((a) => a.appliance_id === configuredId) ?? null;
  }

  private _formatPower(): string | null {
    const entity = this.hass?.states?.[this._config.entities?.power ?? ''];
    if (!entity) return null;
    return formatPower(entity.state, entity.attributes?.['unit_of_measurement']);
  }

  /** "est. 32% savings today", or a bare em dash when there is no number. */
  private _savingsText(entry: ApplianceScheduleEntry, short: boolean): string {
    const pct = entry.savings_pct;
    if (isPaused(entry) || !hasPlan(entry) || typeof pct !== 'number' || !Number.isFinite(pct)) {
      return '—';
    }
    return short ? `est. ${Math.round(pct)}%` : formatSavingsEstimate(pct);
  }

  private _savingsTitle(entry: ApplianceScheduleEntry, text: string): string {
    return text === '—' ? '' : savingsEstimateTitle(entry.schedule);
  }

  /** What the plan has this appliance doing: paused, no plan yet, an idle
   * day, or when it is next scheduled on. Empty when there is nothing to add. */
  private _planStatus(entry: ApplianceScheduleEntry): string {
    if (entry.pause_state === 'timed') return pausedUntilLabel(entry.paused_until);
    if (isPaused(entry)) return 'Paused';
    if (!hasPlan(entry)) return 'No plan yet';
    if (entry.appliance_type === 'hvac') {
      return entry.schedule['idle_day'] === true ? 'Idle day' : '';
    }
    const next = nextScheduledSlot(entry);
    if (!next) return 'No more runs today';
    // A robot's plan is time on its dock, which is how it charges.
    const what = entry.appliance_type === 'robot' ? 'charge' : 'run';
    return next.now ? `Scheduled now` : `Next ${what} at ${slotTimeLabel(next.slot)}`;
  }

  private _renderRow(entry: ApplianceScheduleEntry): TemplateResult {
    const savings = this._savingsText(entry, true);
    const health = entry.integration_health;
    const unhealthy = !!health && health.status !== 'healthy';
    const status = unhealthy ? healthLabel(health) : this._planStatus(entry);
    return html`
      <div class="row" data-appliance-id=${entry.appliance_id}>
        <span class="row-name">${entry.name}</span>
        <span class="row-savings" title=${this._savingsTitle(entry, savings)}>${savings}</span>
        ${status
          ? unhealthy
            ? html`<span class="row-status" data-health=${health.status}>${status}</span>`
            : html`<span class="row-status">${status}</span>`
          : null}
      </div>
    `;
  }

  private _renderPower(): TemplateResult {
    const powerText = this._formatPower();
    return html`
      <div class="power-row" ?hidden=${powerText === null}>
        <span class="power-label">Home power</span>
        <span class="power-value">${powerText ?? ''}</span>
      </div>
    `;
  }

  private _renderFoot(): TemplateResult {
    return html`
      <div class="error" ?hidden=${this._error === null}>${this._error ?? ''}</div>
      <div class="card-foot">
        <a
          href=${PANEL_PATH}
          @click=${(e: Event) => {
            e.preventDefault();
            openPanel();
          }}
        >Open Hungry Machines</a>
      </div>
    `;
  }

  private _renderScoped(entry: ApplianceScheduleEntry): TemplateResult {
    const savings = this._savingsText(entry, false);
    const status = this._planStatus(entry);
    const health = entry.integration_health;
    const healthHidden = !health || health.status === 'healthy';
    return html`
      <div class="card">
        <div class="title">${entry.name}</div>
        <div class="savings" title=${this._savingsTitle(entry, savings)}>${savings}</div>
        ${status ? html`<div class="next-run">${status}</div>` : null}
        <div
          class="health-badge"
          data-status=${health?.status ?? 'healthy'}
          ?hidden=${healthHidden}
        >
          ${healthLabel(health)}
        </div>
        ${this._renderPower()}
        ${this._renderFoot()}
      </div>
    `;
  }

  override render(): TemplateResult {
    if (this._auth.status !== 'authed') {
      return html`
        <div class="stub">
          Sign in from the Hungry Machines panel to see your savings.
        </div>
      `;
    }

    const scoped = this._resolveAppliance();
    if (scoped) {
      return this._renderScoped(scoped);
    }

    const loaded = this._schedules !== null;
    // An appliance_id that matches nothing says so; it does not fall back
    // to the whole home, which would read as that appliance's figures.
    const unmatched = loaded && !!this._config.appliance_id;
    const planned = unmatched ? [] : (this._schedules?.appliances ?? []).filter(isPlanned);
    return html`
      <div class="card">
        <div class="title">Estimated savings today</div>
        ${planned.length > 0
          ? html`<div class="rows">${planned.map((a) => this._renderRow(a))}</div>`
          : loaded
            ? html`<div class="empty">
                ${unmatched
                  ? 'No appliance matches the appliance_id in this card.'
                  : 'Add an appliance in the Hungry Machines panel to see its savings here.'}
              </div>`
            : null}
        ${this._renderPower()}
        ${this._renderFoot()}
      </div>
    `;
  }
}
