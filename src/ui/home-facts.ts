import { LitElement, html, css } from 'lit';
import type { TemplateResult } from 'lit';
import { getHomeFacts } from '../api/appliance-health.js';
import type { HomeFact, HomeFacts, HomeMachine } from '../api/appliance-health.js';
import { formatDelta, temperatureUnitStore } from '../utils/temperature.js';
import type { TempUnit } from '../utils/temperature.js';
import { formatHour } from './building-info.js';

/** The gap behind "moves about X an hour", and the drift behind "holds", in °F. */
const REFERENCE_GAP_F = 20;
const DRIFT_F = 3;

const LEARNING = 'Still learning this unit from its readings';

const perHour = (f: number, unit: TempUnit): string => `${formatDelta(f, unit)} an hour`;

const num = (f: HomeFact): number | null => (typeof f.value === 'number' ? f.value : null);

/**
 * The fixed sentence for one fact, or null for a key this panel does not know
 * (a newer API may add keys; they are skipped rather than shown raw).
 */
export function factSentence(fact: HomeFact, unit: TempUnit): string | null {
  const v = num(fact);
  switch (fact.key) {
    case 'holds_temperature': {
      if (v === null) return null;
      const gap = formatDelta(REFERENCE_GAP_F, unit, 0);
      const hours = typeof fact.detail === 'number' ? Math.round(fact.detail) : null;
      const drift = formatDelta(DRIFT_F, unit, 0);
      const base = `With the system off and about ${gap} between inside and outside, this room moves about ${perHour(v, unit)}, learned from your readings.`;
      return hours !== null && hours > 0
        ? `${base} It holds within ${drift} for about ${hours} ${hours === 1 ? 'hour' : 'hours'}.`
        : base;
    }
    case 'sun':
      return v === null ? null : `Midday sun adds up to about ${perHour(v, unit)}.`;
    case 'internal_heat':
      return v === null ? null : `Lights, appliances and people add about ${perHour(v, unit)}.`;
    case 'cooling_capacity':
      return v === null ? null : `Cools this room about ${perHour(v, unit)} at full output.`;
    case 'heating_capacity':
      return v === null ? null : `Heats this room about ${perHour(v, unit)} at full output.`;
    case 'sensor_gap': {
      if (v === null || v === 0) return null;
      const size = formatDelta(Math.abs(v), unit);
      return v > 0
        ? `The unit's own sensor reads about ${size} cooler than your room sensor.`
        : `The unit's own sensor reads about ${size} warmer than your room sensor.`;
    }
    case 'shares_heat': {
      const other = typeof fact.detail === 'string' && fact.detail !== '' ? fact.detail : null;
      return other ? `Heat moves between this room and ${other}.` : 'Heat moves between this room and another zone.';
    }
    case 'prediction':
      return v === null ? null : `Predicts this room within about ${formatDelta(v, unit)} a day ahead.`;
    case 'standby_loss':
      return v === null ? null : `The tank loses about ${perHour(v, unit)} when idle.`;
    case 'full_sun_pct':
      return v === null ? null : `Produces about ${Math.round(v)}% of its rating in full sun.`;
    case 'shaded_hours': {
      const hours = Array.isArray(fact.detail)
        ? fact.detail.filter((h): h is number => typeof h === 'number' && h >= 0 && h <= 23)
        : [];
      if (hours.length === 0) return null;
      return `Output runs low in about ${hours.length} daytime ${hours.length === 1 ? 'hour' : 'hours'} (${hours.map(formatHour).join(', ')}), likely shade.`;
    }
    default:
      return null;
  }
}

/**
 * `<hm-home-facts>` - plain facts about how each unit heats, cools and holds
 * temperature, learned from the home's readings. A fact the API leaves out is
 * not shown; a unit with too little data says it is still learning.
 */
export class HmHomeFacts extends LitElement {
  static override styles = css`
    :host { display: block; font-family: var(--hm-font-body, sans-serif); color: var(--hm-text, #0F172A); }
    .banner { padding: 12px 14px; border-radius: 8px; font-size: 14px; background: rgba(100,116,139,0.08); color: #475569; }
    .banner button { margin-left: 8px; }
    h2 { margin: 0; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--hm-muted, #64748B); }
    .intro { margin: 4px 0 12px; font-size: 12px; line-height: 1.45; color: var(--hm-muted, #64748B); }
    .card { margin-top: 12px; padding: 14px; border-radius: 8px; border: 1px solid rgba(100,116,139,0.25); background: #fafbfc; }
    h3 { margin: 0; font-size: 15px; }
    ul { margin: 8px 0 0; padding-left: 18px; font-size: 14px; line-height: 1.5; }
    .learning { margin: 8px 0 0; font-size: 14px; color: var(--hm-muted, #64748B); }
  `;

  static override properties = {
    _facts: { state: true },
    _loading: { state: true },
    _error: { state: true },
    _unit: { state: true },
    refreshKey: { type: Number, attribute: 'refresh-key', reflect: true },
  };

  _facts: HomeFacts | null = null;
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

  private async _load(): Promise<void> {
    this._loading = true;
    this._error = null;
    try {
      this._facts = await getHomeFacts();
    } catch (e) {
      // Never show an earlier payload as current.
      this._facts = null;
      this._error = e instanceof Error ? e.message : 'Could not load home facts.';
    }
    this._loading = false;
  }

  private _renderMachine(m: HomeMachine): TemplateResult {
    const lines = m.learning
      ? []
      : m.facts.map((f) => factSentence(f, this._unit)).filter((s): s is string => s !== null);
    return html`<div class="card" data-appliance=${m.appliance_id}>
      <h3>${m.name ?? m.appliance_type}</h3>
      ${m.learning || lines.length === 0
        ? html`<p class="learning">${LEARNING}</p>`
        : html`<ul>${lines.map((s) => html`<li>${s}</li>`)}</ul>`}
    </div>`;
  }

  override render() {
    if (this._error) {
      return html`<div class="banner" role="alert">
        Home facts are not available right now.
        <button type="button" @click=${() => void this._load()}>Try again</button>
      </div>`;
    }
    if (this._loading || !this._facts) {
      return html`<div class="banner">Loading your home…</div>`;
    }
    const machines = this._facts.appliances;
    return html`<div>
      <h2>Your home</h2>
      <p class="intro">Learned from your readings. These are approximate and change as the seasons do.</p>
      ${machines.length === 0
        ? html`<p class="learning">${LEARNING}</p>`
        : machines.map((m) => this._renderMachine(m))}
    </div>`;
  }
}
