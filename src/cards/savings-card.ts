import { LitElement, html, css, type TemplateResult } from 'lit';
import { authStore, type AuthState } from '../store.js';
import {
  getAllSchedules,
  type ApplianceScheduleEntry,
  type InlineIntegrationHealth,
  type SchedulesResponse,
} from '../api/schedules.js';

export interface HmSavingsCardConfig {
  type?: string;
  /**
   * UUID of the HVAC appliance this card represents. When set, the card
   * shows that one appliance's savings + health verdict (US-MHVAC-018).
   * Omitted → existing behavior: average savings across all appliances
   * + next non-HVAC scheduled run. With exactly one HVAC and no id, the
   * card silently resolves to that unit for back-compat.
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

const SCHEDULES_TTL_MS = 5 * 60 * 1000;
const INTERVALS_PER_DAY = 48;

function asBooleanArray(value: unknown): boolean[] | undefined {
  if (!Array.isArray(value) || value.length !== INTERVALS_PER_DAY) return undefined;
  return value.every((v) => typeof v === 'boolean') ? (value as boolean[]) : undefined;
}

function formatInterval(index: number): string {
  const hours = Math.floor(index / 2);
  const minutes = index % 2 === 0 ? '00' : '30';
  const hh = String(hours).padStart(2, '0');
  return `${hh}:${minutes}`;
}

function currentIntervalIndex(now: Date = new Date()): number {
  const minutesIntoDay = now.getHours() * 60 + now.getMinutes();
  return Math.floor(minutesIntoDay / 30);
}

export class HmSavingsCard extends LitElement {
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
    .savings {
      font-family: var(--hm-font-heading, serif);
      font-size: 2.25rem;
      font-weight: 600;
      color: var(--hm-primary, #1E3A8A);
      line-height: 1.1;
    }
    .savings-sub {
      font-size: 0.85rem;
      color: var(--hm-muted, #64748B);
      margin-bottom: 12px;
    }
    .power-row {
      display: flex;
      align-items: baseline;
      gap: 8px;
      padding: 8px 0;
      border-top: 1px solid rgba(100, 116, 139, 0.2);
      border-bottom: 1px solid rgba(100, 116, 139, 0.2);
      margin-bottom: 12px;
    }
    .power-label {
      font-size: 0.8rem;
      color: var(--hm-muted, #64748B);
    }
    .power-value {
      font-size: 1.1rem;
      font-weight: 600;
      color: var(--hm-secondary, #0F766E);
    }
    .next-label {
      font-size: 0.8rem;
      color: var(--hm-muted, #64748B);
      margin-bottom: 4px;
    }
    .next-value {
      font-size: 1rem;
      color: var(--hm-text, #0F172A);
    }
    .error {
      color: var(--hm-error, #DC2626);
      font-size: 0.85rem;
      margin-top: 8px;
    }
    .scope-name {
      font-size: 0.85rem;
      color: var(--hm-muted, #64748B);
      margin-bottom: 4px;
    }
    .health-badge {
      display: inline-flex;
      align-items: center;
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      background: rgba(220, 38, 38, 0.08);
      color: var(--hm-error, #DC2626);
      margin-top: 8px;
    }
    .health-badge[hidden] {
      display: none;
    }
    .health-badge[data-status='stale_data'] {
      background: rgba(245, 158, 11, 0.12);
      color: var(--hm-accent, #B45309);
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
    return 2;
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
    if (this._fetchedAt && now - this._fetchedAt < SCHEDULES_TTL_MS) {
      return;
    }
    this._fetchedAt = now;
    this._error = null;
    try {
      this._schedules = await getAllSchedules();
    } catch (err) {
      this._error =
        err instanceof Error && err.message ? err.message : 'Could not load schedules';
      this._fetchedAt = 0;
    }
  }

  private _averageSavings(): number | null {
    const appliances = this._schedules?.appliances;
    if (!Array.isArray(appliances) || appliances.length === 0) return null;
    let sum = 0;
    let count = 0;
    for (const a of appliances) {
      if (typeof a.savings_pct === 'number' && Number.isFinite(a.savings_pct)) {
        sum += a.savings_pct;
        count += 1;
      }
    }
    if (count === 0) return null;
    return sum / count;
  }

  /**
   * Resolve the appliance this card is scoped to. The savings card only
   * scopes when `appliance_id` is explicitly configured — the whole-home
   * average + "next non-HVAC scheduled run" view stays the default so
   * existing single-card setups keep their familiar behavior.
   */
  private _resolveAppliance(): ApplianceScheduleEntry | null {
    const configuredId = this._config.appliance_id;
    if (!configuredId) return null;
    const appliances = this._schedules?.appliances;
    if (!Array.isArray(appliances) || appliances.length === 0) return null;
    return appliances.find((a) => a.appliance_id === configuredId) ?? null;
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

  private _formatPower(): string | null {
    const entityId = this._config.entities?.power;
    if (!entityId) return null;
    const state = this.hass?.states?.[entityId]?.state;
    const raw = typeof state === 'string' || typeof state === 'number' ? Number(state) : NaN;
    if (!Number.isFinite(raw)) return null;
    if (raw > 1000) {
      return `${(raw / 1000).toFixed(1)} kW`;
    }
    return `${Math.round(raw)} W`;
  }

  override updated(): void {
    // Bypass Lit+happy-dom ChildPart-drop for sibling interpolations after conditional html templates.
    const root = this.shadowRoot;
    if (!root) return;
    const el = root.querySelector('.next-value');
    if (!el) return;
    const next = this._nextRun();
    el.textContent =
      next !== null ? `${next.name} at ${next.hhmm}` : 'No upcoming runs.';
  }

  private _renderScoped(entry: ApplianceScheduleEntry): TemplateResult {
    const savings = entry.savings_pct;
    const savingsText =
      typeof savings === 'number' && Number.isFinite(savings)
        ? `${Math.round(savings)}% savings today`
        : '—';
    const powerText = this._formatPower();
    const health = entry.integration_health;
    const healthHidden = !health || health.status === 'healthy';
    return html`
      <div class="scope-name">${entry.name}</div>
      <div class="savings">${savingsText}</div>
      <div
        class="power-row"
        ?hidden=${powerText === null}
      >
        <span class="power-label">Home power</span>
        <span class="power-value">${powerText ?? ''}</span>
      </div>
      <div
        class="health-badge"
        data-status=${health?.status ?? 'healthy'}
        ?hidden=${healthHidden}
      >
        ${this._healthLabel(health)}
      </div>
      <div class="error" ?hidden=${this._error === null}>${this._error ?? ''}</div>
    `;
  }

  private _nextRun(): { name: string; hhmm: string } | null {
    const appliances = this._schedules?.appliances;
    if (!Array.isArray(appliances) || appliances.length === 0) return null;
    const startIdx = currentIntervalIndex();
    let best: { name: string; interval: number } | null = null;
    for (const a of appliances) {
      if (a.appliance_type === 'hvac') continue;
      const intervals = asBooleanArray(a.schedule?.intervals);
      if (!intervals) continue;
      for (let i = startIdx; i < INTERVALS_PER_DAY; i++) {
        if (intervals[i]) {
          if (!best || i < best.interval) {
            best = { name: a.name, interval: i };
          }
          break;
        }
      }
    }
    if (!best) return null;
    return { name: best.name, hhmm: formatInterval(best.interval) };
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

    const avg = this._averageSavings();
    const savingsText = avg === null ? '—' : `${Math.round(avg)}% savings today`;
    const powerText = this._formatPower();

    return html`
      <div class="savings">${savingsText}</div>
      <div class="savings-sub">Average across your appliances</div>
      <div
        class="power-row"
        ?hidden=${powerText === null}
      >
        <span class="power-label">Home power</span>
        <span class="power-value">${powerText ?? ''}</span>
      </div>
      <div class="next-label">Next scheduled run</div>
      <div class="next-value"></div>
      <div class="error" ?hidden=${this._error === null}>${this._error ?? ''}</div>
    `;
  }
}
