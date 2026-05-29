import { LitElement, html, css, type TemplateResult } from 'lit';
import { authStore, type AuthState } from '../store.js';
import {
  getAllSchedules,
  recomputeSchedule,
  type ApplianceScheduleEntry,
  type SchedulesResponse,
} from '../api/schedules.js';
import {
  get as getRates,
  update as updateRates,
  type RatesResponse,
} from '../api/rates.js';
import {
  list as listAppliances,
  remove as appliancesApiRemove,
  type Appliance,
  type ApplianceType,
} from '../api/appliances.js';
import { patchMe } from '../api/auth.js';
import { get as getPreferences, type Preferences } from '../api/preferences.js';
import { expandHourlyTo48, hasCustomRates, hasHourlyComfortBands } from '../utils/hourly.js';
import {
  PRICING_ZONE_LABELS,
  pricingZoneFullLabel,
  pricingZoneOptionLabel,
  type PricingZone,
} from '../data/pricing-zones.js';

type HassStateLike = { entity_id?: string; state?: unknown; attributes?: Record<string, unknown> };
type HassLike = {
  states?: Record<string, HassStateLike>;
  callService?: (domain: string, service: string, data?: Record<string, unknown>) => Promise<unknown> | unknown;
};

const PRICING_ZONES = Object.keys(PRICING_ZONE_LABELS)
  .map((k) => Number(k) as PricingZone)
  .sort((a, b) => a - b);

type View = 'dashboard' | 'settings';

const TYPE_LABELS: Record<ApplianceType, string> = {
  hvac: 'HVAC',
  ev_charger: 'EV',
  home_battery: 'Battery',
  water_heater: 'Water',
  solar: 'Solar',
};

function asNumberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((v) => typeof v === 'number') ? (value as number[]) : undefined;
}

function asBooleanArray(value: unknown): boolean[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((v) => typeof v === 'boolean') ? (value as boolean[]) : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function constantArray(value: number, length = 48): number[] {
  return new Array(length).fill(value);
}

type ChartSize = 'small' | 'medium' | 'large';
const CHART_SIZES: ReadonlyArray<ChartSize> = ['small', 'medium', 'large'];
const CHART_SIZE_STORAGE_KEY = 'hm-panel-chart-size';

function _loadChartSize(): ChartSize {
  try {
    const raw = globalThis.localStorage?.getItem(CHART_SIZE_STORAGE_KEY);
    if (raw && (CHART_SIZES as ReadonlyArray<string>).includes(raw)) {
      return raw as ChartSize;
    }
  } catch {
    // happy-dom + private browsing both throw on localStorage — fall through
  }
  return 'large';
}

function _saveChartSize(size: ChartSize): void {
  try {
    globalThis.localStorage?.setItem(CHART_SIZE_STORAGE_KEY, size);
  } catch {
    // best-effort persistence
  }
}

/**
 * Synthetic schedule used for the "Not Connected" example cards on the
 * dashboard. Every appliance type the user hasn't registered yet still
 * renders a card so they can see what the chart will look like once
 * the appliance is added; the overlay above the chart blocks
 * interaction.
 */
function _exampleScheduleFor(type: ApplianceType): Record<string, unknown> {
  switch (type) {
    case 'hvac': {
      const high = constantArray(74);
      const low = constantArray(70);
      // Trajectory hovers within band with a mid-day dip suggesting
      // pre-cooling ahead of peak hours.
      const setpoints = Array.from({ length: 48 }, (_, i) => {
        const t = i / 48;
        return Math.round((72 - Math.sin(t * Math.PI * 2) * 1.5) * 10) / 10;
      });
      return {
        intervals: Array.from({ length: 48 }, (_, i) => i),
        high_temps: high,
        low_temps: low,
        setpoint_temps: setpoints,
        temp_trajectory: setpoints,
        mode: 'cool',
      };
    }
    case 'ev_charger':
    case 'home_battery': {
      // Charge sits at 30% overnight, ramps up to ~80% by 07:00.
      const trajectory = Array.from({ length: 48 }, (_, i) => {
        if (i < 8) return 30;
        if (i < 16) return 30 + (i - 8) * 6.25;
        return 80;
      });
      const intervals = Array.from({ length: 48 }, (_, i) => i >= 8 && i < 16);
      return {
        intervals,
        value_trajectory: trajectory,
        unit: 'percent',
        min_value: 20,
        target_value: 80,
        deadline_interval: 14,
      };
    }
    case 'water_heater': {
      const high = constantArray(140);
      const low = constantArray(110);
      const trajectory = Array.from({ length: 48 }, (_, i) => {
        const t = i / 48;
        return Math.round((125 + Math.sin(t * Math.PI * 2) * 8) * 10) / 10;
      });
      return {
        intervals: Array.from({ length: 48 }, (_, i) => i % 4 === 0),
        high_temps: high,
        low_temps: low,
        temp_trajectory: trajectory,
        unit: 'fahrenheit',
      };
    }
    case 'solar':
    default:
      return {};
  }
}

function _exampleApplianceEntry(type: ApplianceType): ApplianceScheduleEntry {
  return {
    appliance_id: `__example_${type}`,
    appliance_type: type,
    name: _exampleNameFor(type),
    schedule: _exampleScheduleFor(type),
    savings_pct: 0,
    source: 'defaults',
  };
}

function _exampleNameFor(type: ApplianceType): string {
  switch (type) {
    case 'hvac': return 'HVAC';
    case 'ev_charger': return 'EV charger';
    case 'home_battery': return 'Home battery';
    case 'water_heater': return 'Water heater';
    case 'solar': return 'Solar PV';
  }
}

export class HungryMachinesPanel extends LitElement {
  static override styles = css`
    :host {
      display: block;
      min-height: 100%;
      background: var(--hm-bg, #F8FAFC);
      color: var(--hm-text, #0F172A);
      font-family: var(--hm-font-body, sans-serif);
      box-sizing: border-box;
    }
    .loading,
    .login-gate {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 48px 16px;
      min-height: 280px;
    }
    .login-gate {
      padding: 64px 16px;
    }
    .spinner {
      width: 32px;
      height: 32px;
      border: 3px solid var(--hm-muted, #64748B);
      border-top-color: var(--hm-primary, #1E3A8A);
      border-radius: 50%;
      animation: hm-spin 0.8s linear infinite;
    }
    @keyframes hm-spin {
      to {
        transform: rotate(360deg);
      }
    }
    header.app-header {
      padding: 20px 24px;
      border-bottom: 1px solid var(--hm-muted, #64748B);
      background: var(--hm-bg, #F8FAFC);
    }
    header.app-header h1 {
      margin: 0;
      font-family: var(--hm-font-heading, serif);
      color: var(--hm-primary, #1E3A8A);
      font-size: 1.5rem;
      font-weight: 600;
    }
    nav.tabs {
      display: flex;
      gap: 4px;
      padding: 0 24px;
      border-bottom: 1px solid var(--hm-muted, #64748B);
      background: var(--hm-bg, #F8FAFC);
    }
    nav.tabs button {
      background: transparent;
      border: none;
      padding: 12px 18px;
      color: var(--hm-muted, #64748B);
      cursor: pointer;
      font: inherit;
      border-bottom: 2px solid transparent;
      margin-bottom: -1px;
    }
    nav.tabs button[aria-selected='true'] {
      color: var(--hm-primary, #1E3A8A);
      border-bottom-color: var(--hm-primary, #1E3A8A);
      font-weight: 600;
    }
    section.content {
      padding: 24px;
      min-height: 200px;
    }
    section.content h2 {
      margin: 0 0 16px;
      font-family: var(--hm-font-heading, serif);
      color: var(--hm-text, #0F172A);
      font-size: 1.25rem;
      font-weight: 600;
    }
    section.content p {
      color: var(--hm-muted, #64748B);
      margin: 0;
    }
    .dashboard-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      flex-wrap: wrap;
      margin-bottom: 8px;
    }
    .size-toggle {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 4px;
      background: var(--hm-bg, #F8FAFC);
      border: 1px solid rgba(100, 116, 139, 0.25);
      border-radius: 10px;
      font-size: 14px;
    }
    .size-toggle-label {
      color: var(--hm-muted, #64748B);
      font-size: 12px;
      padding: 0 6px 0 8px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .size-btn {
      background: transparent;
      border: none;
      color: var(--hm-text, #0F172A);
      padding: 6px 12px;
      border-radius: 6px;
      font: inherit;
      cursor: pointer;
    }
    .size-btn:hover {
      background: rgba(30, 58, 138, 0.08);
    }
    .size-btn.active {
      background: var(--hm-primary, #1E3A8A);
      color: #ffffff;
      font-weight: 600;
    }
    .cards {
      display: grid;
      gap: 24px;
      /* Wide cards so the optimization chart has enough room for a
         readable schedule + axis labels. Drops to a single-column
         layout below ~640px viewport width. */
      grid-template-columns: repeat(auto-fill, minmax(min(640px, 100%), 1fr));
    }
    /* Example "Not Connected" cards: greyed-out version of a real
       appliance card with an interactive overlay that opens the
       Add Appliance flow when the user clicks. */
    .card-shell {
      position: relative;
    }
    .card-shell.example > .card {
      opacity: 0.45;
      pointer-events: none;
      filter: grayscale(35%);
    }
    .not-connected-overlay {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 14px;
      border-radius: 14px;
      background: rgba(15, 23, 42, 0.05);
    }
    .not-connected-badge {
      background: rgba(15, 23, 42, 0.82);
      color: #ffffff;
      padding: 8px 18px;
      border-radius: 999px;
      font-size: 14px;
      font-weight: 600;
      letter-spacing: 0.02em;
    }
    .not-connected-cta {
      background: var(--hm-primary, #1E3A8A);
      color: #ffffff;
      border: none;
      padding: 10px 18px;
      border-radius: 8px;
      font: inherit;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
    }
    .not-connected-cta:hover {
      background: #16306d;
    }
    .card {
      background: #ffffff;
      border: 1px solid rgba(100, 116, 139, 0.2);
      border-radius: 14px;
      padding: 24px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .card-head {
      display: flex;
      align-items: center;
      gap: 14px;
    }
    .card-head .badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 52px;
      height: 52px;
      border-radius: 10px;
      background: var(--hm-primary, #1E3A8A);
      color: #ffffff;
      font-size: 15px;
      font-weight: 700;
      letter-spacing: 0.02em;
      flex-shrink: 0;
    }
    .card-head .name {
      font-weight: 600;
      color: var(--hm-text, #0F172A);
      font-size: 1.4rem;
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .card .savings {
      color: var(--hm-secondary, #0F766E);
      font-weight: 600;
      font-size: 1.3rem;
    }
    .card .edit-btn {
      align-self: flex-start;
      background: transparent;
      border: 1px solid var(--hm-primary, #1E3A8A);
      color: var(--hm-primary, #1E3A8A);
      padding: 10px 20px;
      border-radius: 8px;
      font: inherit;
      font-size: 16px;
      cursor: pointer;
    }
    .comfort-legend {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      color: var(--hm-muted, #64748B);
    }
    .comfort-legend-swatch {
      display: inline-block;
      width: 12px;
      height: 12px;
      background: var(--hm-accent, #F59E0B);
      opacity: 0.4;
      border: 1px solid var(--hm-accent, #F59E0B);
      border-radius: 2px;
    }
    .card .edit-btn:hover {
      background: var(--hm-primary, #1E3A8A);
      color: #ffffff;
    }
    .card .card-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .card .edit-btn.secondary {
      border-color: var(--hm-muted, #64748B);
      color: var(--hm-muted, #64748B);
    }
    .card .edit-btn.secondary:hover {
      background: var(--hm-muted, #64748B);
      color: #ffffff;
    }
    .card .edit-btn.danger {
      border-color: var(--hm-error, #DC2626);
      color: var(--hm-error, #DC2626);
    }
    .card .edit-btn.danger:hover {
      background: var(--hm-error, #DC2626);
      color: #ffffff;
    }
    .confirm-overlay {
      position: fixed;
      inset: 0;
      background: rgba(15, 23, 42, 0.55);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      z-index: 1100;
    }
    .confirm-panel {
      background: #ffffff;
      border-radius: 12px;
      padding: 24px;
      width: 100%;
      max-width: 440px;
      box-sizing: border-box;
      box-shadow: 0 14px 40px rgba(15, 23, 42, 0.35);
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .confirm-panel h2 {
      margin: 0;
      font-family: var(--hm-font-heading, serif);
      color: var(--hm-error, #DC2626);
      font-size: 1.15rem;
    }
    .confirm-panel p {
      margin: 0;
      color: var(--hm-text, #0F172A);
      font-size: 14px;
      line-height: 1.4;
    }
    .confirm-panel .confirm-error {
      color: var(--hm-error, #DC2626);
      background: rgba(220, 38, 38, 0.08);
      border: 1px solid var(--hm-error, #DC2626);
      padding: 8px 10px;
      border-radius: 6px;
      font-size: 13px;
    }
    .confirm-panel .actions {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
      margin-top: 4px;
    }
    .confirm-panel button {
      padding: 8px 16px;
      border-radius: 8px;
      font: inherit;
      cursor: pointer;
    }
    .confirm-panel button.cancel {
      background: transparent;
      border: 1px solid var(--hm-muted, #64748B);
      color: var(--hm-muted, #64748B);
    }
    .confirm-panel button.confirm {
      background: var(--hm-error, #DC2626);
      border: 1px solid var(--hm-error, #DC2626);
      color: #ffffff;
    }
    .confirm-panel button.confirm[disabled] {
      opacity: 0.6;
      cursor: not-allowed;
    }
    .empty,
    .error {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      padding: 48px 16px;
      gap: 12px;
      color: var(--hm-muted, #64748B);
    }
    .error .message {
      color: var(--hm-error, #DC2626);
      font-weight: 500;
    }
    .add-btn,
    .retry-btn {
      background: var(--hm-primary, #1E3A8A);
      color: #ffffff;
      border: none;
      padding: 8px 16px;
      border-radius: 6px;
      font: inherit;
      cursor: pointer;
    }
    .dashboard-actions {
      display: flex;
      justify-content: flex-end;
      margin-top: 16px;
    }
    .recompute-overlay {
      /* Fixed instead of absolute so the overlay covers the whole panel
         even when the dashboard is scrolled. */
      position: fixed;
      inset: 0;
      display: flex;
      align-items: flex-start;
      justify-content: center;
      padding-top: 96px;
      background: rgba(248, 250, 252, 0.72);
      backdrop-filter: blur(2px);
      z-index: 50;
      pointer-events: all;
    }
    .recompute-card {
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 14px 18px;
      border-radius: 10px;
      background: var(--hm-surface, #FFFFFF);
      box-shadow: 0 8px 24px rgba(15, 23, 42, 0.18);
      max-width: 420px;
    }
    .recompute-card .spinner {
      width: 22px;
      height: 22px;
      border: 3px solid rgba(30, 58, 138, 0.18);
      border-top-color: var(--hm-primary, #1E3A8A);
      border-radius: 50%;
      animation: hm-spin 0.9s linear infinite;
    }
    .recompute-card .recompute-text strong {
      display: block;
      color: var(--hm-text, #0F172A);
      margin-bottom: 2px;
      font-weight: 600;
    }
    .recompute-card .recompute-text p {
      margin: 0;
      color: var(--hm-muted, #64748B);
      font-size: 12px;
      line-height: 1.4;
    }
    @keyframes hm-spin {
      to { transform: rotate(360deg); }
    }
    .recompute-error {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 14px;
      margin-bottom: 14px;
      border-radius: 8px;
      background: rgba(220, 38, 38, 0.08);
      color: var(--hm-error, #DC2626);
      font-size: 13px;
    }
    .recompute-error-dismiss {
      margin-left: auto;
      background: transparent;
      border: none;
      color: inherit;
      font-size: 18px;
      line-height: 1;
      cursor: pointer;
      padding: 0 4px;
    }
    .skeleton {
      display: grid;
      gap: 16px;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    }
    .skeleton-card {
      height: 140px;
      border-radius: 10px;
      background: rgba(100, 116, 139, 0.15);
      animation: hm-pulse 1.2s ease-in-out infinite;
    }
    @keyframes hm-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.55; }
    }
    footer.app-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 24px;
      border-top: 1px solid var(--hm-muted, #64748B);
      background: var(--hm-bg, #F8FAFC);
      color: var(--hm-muted, #64748B);
      font-size: 14px;
    }
    footer.app-footer .email {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    footer.app-footer button.signout {
      background: transparent;
      border: 1px solid var(--hm-primary, #1E3A8A);
      color: var(--hm-primary, #1E3A8A);
      padding: 6px 14px;
      border-radius: 6px;
      font: inherit;
      cursor: pointer;
    }
    footer.app-footer button.signout:hover {
      background: var(--hm-primary, #1E3A8A);
      color: var(--hm-bg, #F8FAFC);
    }
    .settings {
      display: flex;
      flex-direction: column;
      gap: 20px;
      max-width: 520px;
    }
    .settings-section {
      background: #ffffff;
      border: 1px solid rgba(100, 116, 139, 0.2);
      border-radius: 10px;
      padding: 16px 18px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .settings-section h3 {
      margin: 0;
      font-family: var(--hm-font-heading, serif);
      color: var(--hm-text, #0F172A);
      font-size: 1.05rem;
      font-weight: 600;
    }
    .settings-section .hint {
      color: var(--hm-muted, #64748B);
      font-size: 13px;
      margin: 0;
    }
    .settings-section label {
      display: block;
      font-size: 14px;
      color: var(--hm-text, #0F172A);
    }
    .settings-section .label-text {
      display: block;
      margin-bottom: 4px;
    }
    .settings-section select {
      width: 100%;
      padding: 8px 10px;
      border: 1px solid var(--hm-muted, #64748B);
      border-radius: 6px;
      font: inherit;
      background: var(--hm-bg, #F8FAFC);
      color: var(--hm-text, #0F172A);
      box-sizing: border-box;
    }
    .settings-section select:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }
    .settings-section .zone-error {
      color: var(--hm-error, #DC2626);
      font-size: 13px;
      margin: 0;
    }
    .settings-section .zone-hint {
      color: var(--hm-muted, #64748B);
      font-size: 13px;
      margin: 0;
    }
    .settings-section .account-email {
      font-weight: 600;
      color: var(--hm-text, #0F172A);
      word-break: break-all;
    }
    .settings-section .account-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
    }
    .settings-section button.account-signout {
      background: transparent;
      border: 1px solid var(--hm-primary, #1E3A8A);
      color: var(--hm-primary, #1E3A8A);
      padding: 8px 14px;
      border-radius: 6px;
      font: inherit;
      cursor: pointer;
    }
    .settings-section button.account-signout:hover {
      background: var(--hm-primary, #1E3A8A);
      color: #ffffff;
    }
    .settings-section button.account-delete {
      background: transparent;
      border: 1px solid var(--hm-muted, #64748B);
      color: var(--hm-muted, #64748B);
      padding: 8px 14px;
      border-radius: 6px;
      font: inherit;
      cursor: not-allowed;
      opacity: 0.7;
    }
    .rates-summary {
      font-weight: 500;
      color: var(--hm-text, #0F172A);
      margin: 0;
    }
    .rates-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
    }
    .rates-actions button {
      background: transparent;
      border: 1px solid var(--hm-primary, #1E3A8A);
      color: var(--hm-primary, #1E3A8A);
      padding: 8px 14px;
      border-radius: 6px;
      font: inherit;
      cursor: pointer;
    }
    .rates-actions button:hover {
      background: var(--hm-primary, #1E3A8A);
      color: #ffffff;
    }
    .rates-actions button.primary {
      background: var(--hm-primary, #1E3A8A);
      color: #ffffff;
    }
    .rates-actions button.primary:hover {
      opacity: 0.9;
    }
    .rates-actions button:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }
    .rates-editor {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .rates-helper {
      color: var(--hm-muted, #64748B);
      font-size: 13px;
      margin: 0;
    }
    table.rates-table {
      border-collapse: collapse;
      width: 100%;
      font-size: 14px;
    }
    table.rates-table th,
    table.rates-table td {
      padding: 4px 6px;
      text-align: left;
      border-bottom: 1px solid rgba(100, 116, 139, 0.18);
    }
    table.rates-table th {
      font-weight: 600;
      color: var(--hm-muted, #64748B);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    table.rates-table input {
      width: 100%;
      padding: 5px 7px;
      border: 1px solid var(--hm-muted, #64748B);
      border-radius: 4px;
      font: inherit;
      font-size: 13px;
      background: var(--hm-bg, #F8FAFC);
      color: var(--hm-text, #0F172A);
      box-sizing: border-box;
    }
    table.rates-table input.invalid {
      border-color: var(--hm-error, #DC2626);
    }
    table.rates-table .row-error {
      color: var(--hm-error, #DC2626);
      font-size: 12px;
    }
    .rates-api-error {
      color: var(--hm-error, #DC2626);
      font-size: 13px;
      margin: 0;
    }
    .settings-actions {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }
    .settings-actions .save-btn {
      background: var(--hm-primary, #1E3A8A);
      color: #ffffff;
      border: none;
      padding: 8px 16px;
      border-radius: 6px;
      font: inherit;
      cursor: pointer;
    }
    .settings-actions .save-btn:hover:not(:disabled) {
      opacity: 0.9;
    }
    .settings-actions .reset-btn {
      background: transparent;
      border: 1px solid var(--hm-primary, #1E3A8A);
      color: var(--hm-primary, #1E3A8A);
      padding: 8px 16px;
      border-radius: 6px;
      font: inherit;
      cursor: pointer;
    }
    .settings-actions .reset-btn:hover:not(:disabled) {
      background: var(--hm-primary, #1E3A8A);
      color: #ffffff;
    }
    .settings-actions button:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }
    .settings-actions .saved-flash {
      color: var(--hm-secondary, #0F766E);
      font-weight: 600;
      font-size: 14px;
    }
  `;

  static override properties = {
    hass: { attribute: false },
    _auth: { state: true },
    _view: { state: true },
    _schedulesLoading: { state: true },
    _schedulesError: { state: true },
    _schedules: { state: true },
    _rates: { state: true },
    _preferences: { state: true },
    _editorOpen: { state: true },
    _editorApplianceId: { state: true },
    _editorApplianceType: { state: true },
    _editorConstraints: { state: true },
    _addApplianceOpen: { state: true },
    // Appliance currently being edited via the appliance-form overlay.
    // Null when the form is in CREATE mode (or closed entirely).
    _editingAppliance: { state: true },
    // Pending delete confirmation — when set, the delete confirm modal
    // is shown for that appliance.
    _deletingAppliance: { state: true },
    _deleting: { state: true },
    _deleteError: { state: true },
    _weatherEntityDraft: { state: true },
    _zoneDraft: { state: true },
    _savedFlash: { state: true },
    _zoneSaving: { state: true },
    _zoneError: { state: true },
    _ratesLoading: { state: true },
    _ratesError: { state: true },
    _customRatesEditorOpen: { state: true },
    _customRatesInputs: { state: true },
    _customRatesSaving: { state: true },
    _customRatesSaveError: { state: true },
    _recomputing: { state: true },
    _recomputeError: { state: true },
    _chartSize: { state: true },
  };

  hass: unknown = undefined;
  _auth: AuthState = authStore.state;
  _view: View = 'dashboard';
  _schedulesLoading = false;
  _schedulesError: string | null = null;
  _schedules: SchedulesResponse | null = null;
  _rates: RatesResponse | null = null;
  _preferences: Preferences | null = null;
  _editorOpen = false;
  _editorApplianceId = '';
  _editorApplianceType: ApplianceType = 'hvac';
  _editorConstraints: Record<string, unknown> | undefined = undefined;
  _addApplianceOpen = false;
  _editingAppliance: Appliance | null = null;
  _deletingAppliance: Appliance | null = null;
  _deleting = false;
  _deleteError: string | null = null;
  _weatherEntityDraft = '';
  _zoneDraft = 1;
  _savedFlash = false;
  _zoneSaving = false;
  _zoneError: string | null = null;
  _ratesLoading = false;
  _ratesError: string | null = null;
  _customRatesEditorOpen = false;
  _customRatesInputs: string[] = Array.from({ length: 24 }, () => '');
  _customRatesSaving = false;
  _customRatesSaveError: string | null = null;
  // User-selected chart size for the dashboard. Persisted to
  // localStorage so the choice survives panel reloads. Defaults to
  // 'large' for first-time users — the v2.4.1 baseline.
  _chartSize: 'small' | 'medium' | 'large' = _loadChartSize();
  // Inline recompute state. `_recomputing` drives the "Optimizing…"
  // overlay shown over the dashboard while the backend reruns the
  // optimizer for this user; `_recomputeError` surfaces a failure as a
  // dismissible toast so the user knows the chart didn't update.
  _recomputing = false;
  _recomputeError: string | null = null;

  private _unsubscribe: (() => void) | null = null;
  private _schedulesFetched = false;
  private _ratesInflight = false;
  private _appliancesById: Record<string, Appliance> = {};
  private _savedFlashTimer: ReturnType<typeof setTimeout> | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    this._auth = authStore.state;
    this._zoneDraft = this._auth.user?.pricing_location ?? 1;
    this._weatherEntityDraft = this._auth.user?.weather_entity_id ?? '';
    this._unsubscribe = authStore.subscribe((s) => {
      const prevStatus = this._auth.status;
      this._auth = s;
      if (prevStatus !== 'authed' && s.status === 'authed') {
        this._zoneDraft = s.user?.pricing_location ?? 1;
        this._weatherEntityDraft = s.user?.weather_entity_id ?? '';
        void this._loadSchedulesIfNeeded();
      }
      if (s.status !== 'authed') {
        this._schedulesFetched = false;
      }
    });
    void authStore.hydrate();
    void this._loadSchedulesIfNeeded();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
    if (this._savedFlashTimer !== null) {
      clearTimeout(this._savedFlashTimer);
      this._savedFlashTimer = null;
    }
  }

  private _selectView(view: View): void {
    this._view = view;
    if (view === 'dashboard') {
      void this._loadSchedulesIfNeeded();
    } else if (view === 'settings') {
      void this._loadRatesIfNeeded();
    }
  }

  private async _loadSchedulesIfNeeded(): Promise<void> {
    if (this._schedulesFetched) return;
    if (this._auth.status !== 'authed') return;
    if (this._view !== 'dashboard') return;
    if (this._schedulesLoading) return;
    this._schedulesFetched = true;
    this._schedulesLoading = true;
    this._schedulesError = null;
    try {
      const [schedules, rates, appliances, preferences] = await Promise.all([
        getAllSchedules(),
        getRates(),
        listAppliances().catch(() => [] as Appliance[]),
        getPreferences().catch(() => null as Preferences | null),
      ]);
      this._schedules = schedules;
      this._rates = rates;
      this._preferences = preferences;
      const map: Record<string, Appliance> = {};
      if (Array.isArray(appliances)) {
        for (const a of appliances) map[a.id] = a;
      }
      this._appliancesById = map;
    } catch (err) {
      this._schedulesError =
        err instanceof Error && err.message
          ? err.message
          : 'Could not load schedules';
      this._schedulesFetched = false;
    } finally {
      this._schedulesLoading = false;
    }
  }

  private _retrySchedules(): void {
    this._schedulesError = null;
    void this._loadSchedulesIfNeeded();
  }

  private _onSignOut = (): void => {
    authStore.logout();
  };

  private _onWeatherEntityChange(entityId: string): void {
    this._weatherEntityDraft = entityId;
  }

  private _onZoneChange(zone: number): void {
    this._zoneDraft = zone;
  }

  private _isDirty(): boolean {
    const currentZone = this._auth.user?.pricing_location ?? 1;
    if (this._zoneDraft !== currentZone) return true;
    const currentWeather = this._auth.user?.weather_entity_id ?? '';
    return this._weatherEntityDraft !== currentWeather;
  }

  private async _onSave(): Promise<void> {
    if (!this._isDirty()) return;
    const currentZone = this._auth.user?.pricing_location ?? 1;
    const currentWeather = this._auth.user?.weather_entity_id ?? '';
    const patch: { pricing_location?: number; weather_entity_id?: string } = {};
    if (this._zoneDraft !== currentZone) patch.pricing_location = this._zoneDraft;
    if (this._weatherEntityDraft !== currentWeather)
      patch.weather_entity_id = this._weatherEntityDraft;

    this._zoneSaving = true;
    this._zoneError = null;
    try {
      const updated = await patchMe(patch);
      authStore.patchUser({
        pricing_location: updated.pricing_location,
        weather_entity_id: updated.weather_entity_id,
      });
    } catch (err) {
      this._zoneError =
        err instanceof Error && err.message ? err.message : 'Could not update settings';
      this._zoneSaving = false;
      return;
    }
    this._zoneSaving = false;
    this._savedFlash = true;
    if (this._savedFlashTimer !== null) clearTimeout(this._savedFlashTimer);
    this._savedFlashTimer = setTimeout(() => {
      this._savedFlash = false;
      this._savedFlashTimer = null;
    }, 2000);
  }

  private _onReset(): void {
    this._zoneDraft = this._auth.user?.pricing_location ?? 1;
    this._weatherEntityDraft = this._auth.user?.weather_entity_id ?? '';
  }

  private async _loadRatesIfNeeded(): Promise<void> {
    if (this._rates !== null) return;
    if (this._ratesInflight) return;
    if (this._auth.status !== 'authed') return;
    this._ratesInflight = true;
    this._ratesLoading = true;
    this._ratesError = null;
    try {
      this._rates = await getRates();
    } catch (err) {
      this._ratesError =
        err instanceof Error && err.message ? err.message : 'Could not load rates';
    } finally {
      this._ratesInflight = false;
      this._ratesLoading = false;
    }
  }

  private _openCustomRatesEditor(): void {
    const rates = this._rates;
    const inputs: string[] = Array.from({ length: 24 }, () => '');
    if (rates && rates.source === 'custom' && Array.isArray(rates.hourly_rates_cents_per_kwh)) {
      for (let i = 0; i < 24; i++) {
        const cents = rates.hourly_rates_cents_per_kwh[i];
        if (typeof cents === 'number' && Number.isFinite(cents)) {
          inputs[i] = (cents / 100).toFixed(3);
        }
      }
    }
    this._customRatesInputs = inputs;
    this._customRatesEditorOpen = true;
    this._customRatesSaveError = null;
  }

  private _closeCustomRatesEditor(): void {
    this._customRatesEditorOpen = false;
    this._customRatesSaveError = null;
  }

  private _importFromZone(): void {
    const rates = this._rates;
    if (!rates) return;
    const zoneCents = rates.rates_cents_per_kwh;
    if (!Array.isArray(zoneCents) || zoneCents.length !== 48) return;
    const inputs: string[] = [];
    for (let i = 0; i < 24; i++) {
      const cents = zoneCents[i * 2];
      if (typeof cents === 'number' && Number.isFinite(cents)) {
        inputs.push((cents / 100).toFixed(3));
      } else {
        inputs.push('');
      }
    }
    this._customRatesInputs = inputs;
  }

  private _onCustomRateInput(i: number, val: string): void {
    const next = this._customRatesInputs.slice();
    next[i] = val;
    this._customRatesInputs = next;
  }

  private _validateRateInputs(inputs: string[]): (string | null)[] {
    return inputs.map((s) => {
      const trimmed = s.trim();
      if (trimmed === '') return 'Enter a value';
      const n = Number(trimmed);
      if (!Number.isFinite(n)) return 'Not a number';
      if (n < 0 || n > 2) return 'Must be between 0 and 2';
      return null;
    });
  }

  private async _saveCustomRates(): Promise<void> {
    const errors = this._validateRateInputs(this._customRatesInputs);
    if (errors.some((e) => e !== null)) return;
    const cents = this._customRatesInputs.map(
      (s) => Math.round(Number(s.trim()) * 100 * 10000) / 10000,
    );
    this._customRatesSaving = true;
    this._customRatesSaveError = null;
    try {
      this._rates = await updateRates({ hourly_rates_cents_per_kwh: cents });
      this._customRatesEditorOpen = false;
    } catch (err) {
      this._customRatesSaveError =
        err instanceof Error && err.message ? err.message : 'Could not save rates';
    } finally {
      this._customRatesSaving = false;
    }
  }

  private async _clearCustomRatesOverride(): Promise<void> {
    this._customRatesSaving = true;
    this._customRatesSaveError = null;
    try {
      this._rates = await updateRates({ hourly_rates_cents_per_kwh: null });
      this._customRatesEditorOpen = false;
    } catch (err) {
      this._customRatesSaveError =
        err instanceof Error && err.message ? err.message : 'Could not clear override';
    } finally {
      this._customRatesSaving = false;
    }
  }

  private _openEditor(applianceId: string, type: ApplianceType): void {
    const appliance = this._appliancesById[applianceId];
    // HVAC editor edits user preferences, not appliance.config (which is just {hvac_type, home_size_sqft}).
    const seed: Record<string, unknown> =
      type === 'hvac'
        ? ((this._preferences ?? {}) as unknown as Record<string, unknown>)
        : ((appliance?.config ?? {}) as Record<string, unknown>);
    this._editorApplianceId = applianceId;
    this._editorApplianceType = type;
    this._editorConstraints = seed;
    this._editorOpen = true;
  }

  private _onEditorClosed(): void {
    this._editorOpen = false;
  }

  private _onConstraintsSaved(e: CustomEvent): void {
    // The editor just persisted to the backend. For HVAC saves, the
    // payload IS the user_preferences delta — fold it into our cached
    // `_preferences` so reopening the editor reflects the just-saved
    // state instead of the value we read at panel mount. Without this
    // patch, the UI shows stale numbers until a full panel reload, which
    // is indistinguishable from "save didn't work" to the user.
    const detail = (e?.detail ?? {}) as {
      applianceId?: string;
      payload?: Record<string, unknown>;
    };
    const payload = detail.payload;
    if (this._editorApplianceType === 'hvac' && payload && typeof payload === 'object') {
      const current = this._preferences ?? ({} as Preferences);
      this._preferences = { ...current, ...(payload as Partial<Preferences>) } as Preferences;
    }
    this._onEditorClosed();
    void this._recomputeNow();
  }

  /**
   * Trigger a synchronous server-side re-optimization for this user
   * and replace `_schedules` with the result so the dashboard charts
   * reflect the just-saved constraints without a page reload.
   *
   * Renders an overlay while in flight (HVAC optimizer can take up to
   * ~30s in pathological cases; typical run is 1-5s). On error we
   * surface a toast — the saved values are persisted regardless, the
   * user just needs to wait for the next nightly run for the chart to
   * pick them up.
   */
  private async _recomputeNow(): Promise<void> {
    this._recomputing = true;
    this._recomputeError = null;
    try {
      const fresh = await recomputeSchedule();
      this._schedules = fresh;
      this._schedulesFetched = true;
      // Ask the integration to refetch + apply immediately so the
      // thermostat reflects the new schedule on the next service call
      // instead of waiting for the next :00/:30 boundary (up to 30 min).
      // The API write already landed; this just shortens the loop on
      // the HA side. Failures here are non-fatal — the apply still
      // happens at the next tick.
      void this._triggerImmediateApply();
    } catch (err) {
      this._recomputeError =
        err instanceof Error
          ? err.message
          : 'Could not refresh schedule — your changes were saved, the next nightly run will pick them up.';
    } finally {
      this._recomputing = false;
    }
  }

  private async _triggerImmediateApply(): Promise<void> {
    const hass = this.hass as HassLike | undefined;
    if (!hass || typeof hass.callService !== 'function') return;
    try {
      await hass.callService('hungry_machines', 'apply_now', {});
    } catch {
      // Service may not be registered yet (older integration version);
      // the next :00/:30 tick will pick up the new schedule via the
      // 5-min cache TTL. No user-facing error needed.
    }
  }

  private _dismissRecomputeError = (): void => {
    this._recomputeError = null;
  };

  private _openAddAppliance = (): void => {
    this._addApplianceOpen = true;
  };

  private _onApplianceCreated = (): void => {
    this._addApplianceOpen = false;
    // The new appliance has no schedule row yet; an immediate recompute
    // populates one so the dashboard card renders a real chart instead
    // of the "no schedule" empty state.
    void this._recomputeNow();
  };

  private _onApplianceUpdated = (event: Event): void => {
    this._editingAppliance = null;
    // Refresh the locally cached appliance with the merged config so
    // a subsequent edit sees the latest values without a round trip.
    const updated = (event as CustomEvent).detail?.appliance as Appliance | undefined;
    if (updated && updated.id) {
      this._appliancesById = { ...this._appliancesById, [updated.id]: updated };
    }
    // Config changes (entity_id, hvac_type, indoor_temp sensor, etc.)
    // can change the optimizer's inputs. Recompute so the dashboard
    // chart reflects the new appliance state.
    void this._recomputeNow();
  };

  private _onApplianceCancelled = (): void => {
    this._addApplianceOpen = false;
    this._editingAppliance = null;
  };

  private _openEditAppliance = (applianceId: string): void => {
    const appliance = this._appliancesById[applianceId];
    if (!appliance) return;
    this._editingAppliance = appliance;
  };

  private _openDeleteAppliance = (applianceId: string): void => {
    const appliance = this._appliancesById[applianceId];
    if (!appliance) return;
    this._deletingAppliance = appliance;
    this._deleteError = null;
  };

  private _cancelDeleteAppliance = (): void => {
    this._deletingAppliance = null;
    this._deleteError = null;
    this._deleting = false;
  };

  private _confirmDeleteAppliance = async (): Promise<void> => {
    const target = this._deletingAppliance;
    if (!target) return;
    this._deleting = true;
    this._deleteError = null;
    try {
      await appliancesApiRemove(target.id);
      // Remove from local caches so the dashboard reflects the change
      // before the next /schedules fetch lands.
      const next = { ...this._appliancesById };
      delete next[target.id];
      this._appliancesById = next;
      if (this._schedules) {
        this._schedules = {
          ...this._schedules,
          appliances: (this._schedules.appliances || []).filter(
            (a) => a.appliance_id !== target.id,
          ),
        };
      }
      this._deletingAppliance = null;
    } catch (err) {
      this._deleteError =
        err instanceof Error && err.message
          ? err.message
          : 'Could not delete appliance — please try again';
    } finally {
      this._deleting = false;
    }
  };

  override render() {
    const status = this._auth.status;
    if (status === 'loading') {
      return html`
        <div class="loading" role="status" aria-live="polite">
          <div class="spinner" aria-hidden="true"></div>
        </div>
      `;
    }
    if (status !== 'authed') {
      return html`
        <div class="login-gate">
          <hm-login-form></hm-login-form>
        </div>
      `;
    }
    return this._renderAuthed();
  }

  private _renderAuthed() {
    const email = this._auth.user?.email ?? '';
    const view = this._view;
    return html`
      <header class="app-header">
        <h1>Hungry Machines</h1>
      </header>
      <nav class="tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected=${view === 'dashboard' ? 'true' : 'false'}
          @click=${() => this._selectView('dashboard')}
        >
          Dashboard
        </button>
        <button
          type="button"
          role="tab"
          aria-selected=${view === 'settings' ? 'true' : 'false'}
          @click=${() => this._selectView('settings')}
        >
          Settings
        </button>
      </nav>
      <section class="content">
        ${view === 'dashboard' ? this._renderDashboard() : this._renderSettings()}
      </section>
      <footer class="app-footer">
        <span class="email">${email}</span>
        <button class="signout" type="button" @click=${this._onSignOut}>
          Sign out
        </button>
      </footer>
      <hm-constraint-editor
        .applianceId=${this._editorApplianceId}
        .applianceType=${this._editorApplianceType}
        .currentConstraints=${this._editorConstraints}
        .open=${this._editorOpen}
        @constraints-saved=${(e: CustomEvent) => this._onConstraintsSaved(e)}
        @constraints-cancelled=${() => this._onEditorClosed()}
      ></hm-constraint-editor>
      <hm-appliance-form
        .open=${this._addApplianceOpen || !!this._editingAppliance}
        .hass=${this.hass}
        .editing=${this._editingAppliance ?? null}
        @appliance-created=${this._onApplianceCreated}
        @appliance-updated=${this._onApplianceUpdated}
        @cancelled=${this._onApplianceCancelled}
      ></hm-appliance-form>
      ${this._deletingAppliance ? this._renderDeleteConfirm() : ''}
      ${this._recomputeError ? this._renderRecomputeToast() : ''}
      ${this._recomputing ? this._renderRecomputeOverlay() : ''}
    `;
  }

  private _renderDeleteConfirm(): TemplateResult {
    const target = this._deletingAppliance!;
    const name = target.name || 'this appliance';
    return html`
      <div class="confirm-overlay" role="presentation">
        <div
          class="confirm-panel"
          role="dialog"
          aria-modal="true"
          aria-labelledby="hm-confirm-title"
        >
          <h2 id="hm-confirm-title">Delete ${name}?</h2>
          <p>
            This removes the appliance and every schedule and reading
            tied to it. Your learned thermal model is per-user and is
            kept — re-adding an HVAC appliance later reuses it.
          </p>
          ${this._deleteError
            ? html`<div class="confirm-error" role="alert">${this._deleteError}</div>`
            : null}
          <div class="actions">
            <button
              class="cancel"
              type="button"
              ?disabled=${this._deleting}
              @click=${() => this._cancelDeleteAppliance()}
            >Cancel</button>
            <button
              class="confirm"
              type="button"
              ?disabled=${this._deleting}
              @click=${() => void this._confirmDeleteAppliance()}
            >${this._deleting ? 'Deleting…' : 'Delete'}</button>
          </div>
        </div>
      </div>
    `;
  }

  private _renderDashboard(): TemplateResult {
    if (this._schedulesLoading) {
      return html`
        <h2>Dashboard</h2>
        <div class="skeleton" aria-busy="true" aria-live="polite">
          <div class="skeleton-card"></div>
          <div class="skeleton-card"></div>
          <div class="skeleton-card"></div>
        </div>
      `;
    }

    if (this._schedulesError) {
      return html`
        <h2>Dashboard</h2>
        <div class="error" role="alert">
          <div class="message">Could not load schedules</div>
          <button
            class="retry-btn"
            type="button"
            @click=${() => this._retrySchedules()}
          >
            Retry
          </button>
        </div>
      `;
    }

    const appliances = this._schedules?.appliances ?? [];
    const rates = this._rates?.rates_cents_per_kwh ?? [];

    // Build a list of appliance types the user has NOT yet registered.
    // Each one becomes a greyed-out "Not Connected" example card so the
    // user can see what their dashboard would look like with that
    // device added, without us hiding the option from them.
    const registeredTypes = new Set(appliances.map((a) => a.appliance_type));
    const ALL_TYPES: ReadonlyArray<ApplianceType> = [
      'hvac', 'ev_charger', 'home_battery', 'water_heater', 'solar',
    ];
    const missingTypes = ALL_TYPES.filter((t) => !registeredTypes.has(t));

    return html`
      <div class="dashboard-head">
        <h2>Dashboard</h2>
        ${this._renderChartSizeToggle()}
      </div>
      <div class="cards">
        ${appliances.map((a) => this._renderApplianceCard(a, rates))}
        ${missingTypes.map((t) => this._renderExampleApplianceCard(t, rates))}
      </div>
      <div class="dashboard-actions">
        <button
          class="add-btn"
          type="button"
          @click=${this._openAddAppliance}
        >
          ${appliances.length === 0 ? 'Add appliance' : 'Add another appliance'}
        </button>
      </div>
    `;
  }

  private _renderChartSizeToggle(): TemplateResult {
    return html`
      <div
        class="size-toggle"
        role="group"
        aria-label="Chart size"
      >
        <span class="size-toggle-label">Chart size</span>
        ${(['small', 'medium', 'large'] as const).map(
          (s) => html`
            <button
              type="button"
              class="size-btn ${this._chartSize === s ? 'active' : ''}"
              aria-pressed=${this._chartSize === s ? 'true' : 'false'}
              @click=${() => this._setChartSize(s)}
            >
              ${s[0].toUpperCase() + s.slice(1)}
            </button>
          `,
        )}
      </div>
    `;
  }

  private _setChartSize(size: ChartSize): void {
    if (this._chartSize === size) return;
    this._chartSize = size;
    _saveChartSize(size);
  }

  private _renderExampleApplianceCard(
    type: ApplianceType,
    rates: number[],
  ): TemplateResult {
    const entry = _exampleApplianceEntry(type);
    const inner = type === 'solar'
      ? this._renderSolarCard(entry, TYPE_LABELS[type])
      : this._renderApplianceCard(entry, rates);
    return html`
      <div class="card-shell example" data-appliance-type=${type}>
        ${inner}
        <div class="not-connected-overlay" aria-hidden="false">
          <div class="not-connected-badge">Not Connected</div>
          <button
            type="button"
            class="not-connected-cta"
            @click=${this._openAddAppliance}
          >
            Add ${_exampleNameFor(type)}
          </button>
        </div>
      </div>
    `;
  }

  private _renderRecomputeOverlay(): TemplateResult {
    if (!this._recomputing) return html``;
    return html`
      <div class="recompute-overlay" role="status" aria-live="polite">
        <div class="recompute-card">
          <div class="spinner" aria-hidden="true"></div>
          <div class="recompute-text">
            <strong>Optimizing&hellip;</strong>
            <p>
              Building a fresh schedule with your new settings. This usually
              takes a few seconds.
            </p>
          </div>
        </div>
      </div>
    `;
  }

  private _renderRecomputeToast(): TemplateResult {
    if (!this._recomputeError) return html``;
    return html`
      <div class="recompute-error" role="alert">
        <span>${this._recomputeError}</span>
        <button
          type="button"
          class="recompute-error-dismiss"
          @click=${this._dismissRecomputeError}
          aria-label="Dismiss"
        >
          &times;
        </button>
      </div>
    `;
  }

  private _renderApplianceCard(
    appliance: ApplianceScheduleEntry,
    rates: number[],
  ): TemplateResult {
    const type = appliance.appliance_type;
    const label = TYPE_LABELS[type] ?? type.slice(0, 3).toUpperCase();
    const schedule = appliance.schedule ?? {};
    const savings = `${Math.round(appliance.savings_pct)}% savings today`;

    if (type === 'solar') {
      return this._renderSolarCard(appliance, label);
    }

    // Every appliance type gets the same user-facing optimization chart:
    // background hourly price bars + up to three line series (high limit,
    // low limit, optimizer target). The data wired in differs by type.
    const sched = schedule as Record<string, unknown>;
    let highLimits: number[] | undefined;
    let lowLimits: number[] | undefined;
    let targetValues: number[] | undefined;
    let chartUnit: 'fahrenheit' | 'percent' = 'fahrenheit';
    // Per-appliance fixed Y-axis range so charts read consistently
    // across the dashboard regardless of the day's data:
    //   HVAC          → 40–100 °F (covers winter heat to summer cool)
    //   Water heater  → 50–150 °F (covers tap-cold to scald-hot)
    //   EV / battery  → handled by the chart's `'percent'` mode (0–100)
    let yMin: number | undefined;
    let yMax: number | undefined;
    let marker:
      | { interval: number; value: number; label?: string }
      | undefined;

    if (type === 'hvac') {
      const highTemps = asNumberArray(sched['high_temps']);
      const lowTemps = asNumberArray(sched['low_temps']);
      // Prefer the backend's clamped per-interval setpoints (what the
      // thermostat is actually commanded to). `temp_trajectory` is the
      // raw, unclamped simulator prediction kept alongside it for
      // diagnostics — that's what the chart used to show, but it can
      // dip outside the comfort band when the thermal model is off,
      // which confuses users. Falling back to temp_trajectory if a
      // schedule somehow lacks setpoint_temps is safe (it just shows
      // the older, unclamped value).
      targetValues =
        asNumberArray(sched['setpoint_temps']) ??
        asNumberArray(sched['temp_trajectory']);
      const prefs = this._preferences;
      // The user's saved comfort band wins over whatever the nightly job
      // happened to bake into this row, so live edits don't wait until
      // tomorrow's run to show up on the chart.
      highLimits =
        prefs && hasHourlyComfortBands(prefs)
          ? expandHourlyTo48(prefs.hourly_high_temps_f as number[])
          : highTemps;
      lowLimits =
        prefs && hasHourlyComfortBands(prefs)
          ? expandHourlyTo48(prefs.hourly_low_temps_f as number[])
          : lowTemps;
      chartUnit = 'fahrenheit';
      yMin = 40;
      yMax = 100;
    } else if (type === 'water_heater') {
      highLimits = asNumberArray(sched['high_temps']);
      lowLimits = asNumberArray(sched['low_temps']);
      targetValues = asNumberArray(sched['temp_trajectory']);
      chartUnit = 'fahrenheit';
      yMin = 50;
      yMax = 150;
    } else if (type === 'ev_charger' || type === 'home_battery') {
      targetValues = asNumberArray(sched['value_trajectory']);
      chartUnit = 'percent';
      const minValue = asFiniteNumber(sched['min_value']);
      if (minValue !== undefined) {
        // Single-value minimum becomes a flat dashed line across 24h —
        // the bottom-of-chart "min" rule from the reference sketch.
        lowLimits = constantArray(minValue);
      }
      const targetValue = asFiniteNumber(sched['target_value']);
      const deadlineRaw = asFiniteNumber(sched['deadline_interval']);
      if (
        targetValue !== undefined &&
        deadlineRaw !== undefined &&
        Number.isInteger(deadlineRaw) &&
        deadlineRaw >= 0 &&
        deadlineRaw < 48
      ) {
        marker = { interval: deadlineRaw, value: targetValue };
      }
    }

    return html`
      <div class="card" data-appliance-type=${type}>
        <div class="card-head">
          <span class="badge" aria-hidden="true">${label}</span>
          <span class="name">${appliance.name}</span>
        </div>
        <div class="savings">${savings}</div>
        <hm-optimization-chart
          .rates=${rates}
          .highLimits=${highLimits}
          .lowLimits=${lowLimits}
          .targetValues=${targetValues}
          .targetMarker=${marker}
          .unit=${chartUnit}
          .yMin=${yMin}
          .yMax=${yMax}
          .size=${this._chartSize}
        ></hm-optimization-chart>
        <div class="card-actions">
          <button
            class="edit-btn"
            type="button"
            @click=${() => this._openEditor(appliance.appliance_id, type)}
          >
            Edit constraints
          </button>
          <button
            class="edit-btn secondary"
            type="button"
            @click=${() => this._openEditAppliance(appliance.appliance_id)}
            title="Edit appliance entity, sensors, or properties"
          >
            Edit appliance
          </button>
          <button
            class="edit-btn danger"
            type="button"
            @click=${() => this._openDeleteAppliance(appliance.appliance_id)}
            title="Delete this appliance and its schedules"
          >
            Delete
          </button>
        </div>
      </div>
    `;
  }

  /**
   * Compact informational tile for a solar appliance.
   *
   * Solar is forecast-only — there's no schedule to render and no
   * constraints to edit. The tile shows the registered system size and
   * a short note explaining how it influences the other appliances'
   * schedules. Keeping it on the dashboard (rather than hiding it)
   * gives the user a confirmation that solar is registered and feeding
   * the optimizer.
   */
  private _renderSolarCard(
    appliance: ApplianceScheduleEntry,
    label: string,
  ): TemplateResult {
    const fullAppliance = this._appliancesById[appliance.appliance_id];
    const config = (fullAppliance?.config ?? {}) as Record<string, unknown>;
    const sizeRaw = config['system_size_kw'];
    const sizeKw = typeof sizeRaw === 'number' && Number.isFinite(sizeRaw) ? sizeRaw : null;
    const sizeText = sizeKw !== null ? `${sizeKw.toFixed(1)} kW system` : 'Solar PV';
    return html`
      <div class="card" data-appliance-type="solar">
        <div class="card-head">
          <span class="badge" aria-hidden="true">${label}</span>
          <span class="name">${appliance.name}</span>
        </div>
        <div class="savings">${sizeText}</div>
        <p style="margin: 8px 0 0; color: var(--hm-muted, #64748B); font-size: 14px;">
          Generation forecast is folded into pricing for HVAC, EV, battery, and water-heater
          schedules so they prefer daylight hours when possible.
        </p>
        <div class="card-actions">
          <button
            class="edit-btn secondary"
            type="button"
            @click=${() => this._openEditAppliance(appliance.appliance_id)}
            title="Edit solar system size and orientation"
          >
            Edit appliance
          </button>
          <button
            class="edit-btn danger"
            type="button"
            @click=${() => this._openDeleteAppliance(appliance.appliance_id)}
            title="Delete this appliance"
          >
            Delete
          </button>
        </div>
      </div>
    `;
  }

  private _renderSettings(): TemplateResult {
    const hass = this.hass as HassLike | undefined;
    const states = hass && typeof hass === 'object' ? hass.states : undefined;
    const hasHass = !!states;
    const allEntities = states ? Object.keys(states).sort() : [];
    const weatherEntities = allEntities.filter((id) => id.startsWith('weather.'));
    const user = this._auth.user;
    const email = user?.email ?? '';
    const pricing = this._zoneDraft;
    const weatherDraft = this._weatherEntityDraft;
    const isDirty = this._isDirty();
    const settingsSaving = this._zoneSaving;

    const rates = this._rates;
    const ratesLoading = this._ratesLoading;
    const ratesError = this._ratesError;
    const editorOpen = this._customRatesEditorOpen;
    const saving = this._customRatesSaving;
    const saveError = this._customRatesSaveError;
    const inputs = this._customRatesInputs;
    const rowErrors = this._validateRateInputs(inputs);
    const hasRowError = rowErrors.some((e) => e !== null);
    const ratesSource = rates?.source;
    const zoneForImport = rates?.pricing_location ?? 1;
    const summaryText = !rates
      ? ratesLoading
        ? 'Loading rates…'
        : ratesError ?? 'Rates unavailable'
      : ratesSource === 'custom'
        ? 'Currently using: your custom rates'
        : `Currently using: Zone ${zoneForImport} rates`;
    const toggleLabel =
      ratesSource === 'custom' ? 'Edit / Clear override' : 'Edit custom rates';

    return html`
      <h2>Settings</h2>
      <div class="settings">
        <div class="settings-section">
          <h3>Weather entity</h3>
          <p class="hint">
            The HACS integration pushes this entity's hourly forecast to the
            optimizer once a day. Pick the most accurate provider you have set
            up in Home Assistant. If none is set, the optimizer falls back to
            Open-Meteo using your zip code.
          </p>
          <label>
            <span class="label-text">Forecast source</span>
            <select
              name="weather_entity_id"
              ?disabled=${!hasHass || settingsSaving}
              .value=${weatherDraft}
              @change=${(e: Event) =>
                this._onWeatherEntityChange(
                  (e.target as HTMLSelectElement).value,
                )}
            >
              <option value="" ?selected=${weatherDraft === ''}>— use Open-Meteo fallback —</option>
              ${weatherEntities.map(
                (id) =>
                  html`<option value=${id} ?selected=${id === weatherDraft}>${id}</option>`,
              )}
            </select>
          </label>
          ${!hasHass
            ? html`<p class="hint">Weather picker is only available inside Home Assistant.</p>`
            : null}
        </div>

        <div class="settings-section">
          <h3>Pricing zone</h3>
          <p class="hint">Your time-of-use pricing zone (exact names coming soon).</p>
          <label>
            <span class="label-text">Zone</span>
            <select
              name="pricing_zone"
              ?disabled=${this._zoneSaving}
              .value=${String(pricing)}
              @change=${(e: Event) =>
                this._onZoneChange(Number((e.target as HTMLSelectElement).value))}
            >
              ${PRICING_ZONES.map(
                (z) => html`<option value=${String(z)} ?selected=${z === pricing}>
                  ${pricingZoneOptionLabel(z)}
                </option>`,
              )}
            </select>
          </label>
          <p class="zone-hint">${pricingZoneFullLabel(pricing)}</p>
          ${this._zoneError
            ? html`<p class="zone-error" role="alert">${this._zoneError}</p>`
            : null}
        </div>

        <div class="settings-actions">
          <button
            type="button"
            class="save-btn"
            ?disabled=${!isDirty || settingsSaving}
            @click=${() => void this._onSave()}
          >
            Save
          </button>
          <button
            type="button"
            class="reset-btn"
            ?disabled=${!isDirty || settingsSaving}
            @click=${() => this._onReset()}
          >
            Reset
          </button>
          ${this._savedFlash
            ? html`<span class="saved-flash" role="status">Saved</span>`
            : null}
        </div>

        <div class="settings-section" data-section="custom-rates">
          <h3>Custom electricity rates</h3>
          <p class="rates-summary">${summaryText}</p>
          ${rates
            ? html`
                <div class="rates-actions">
                  <button
                    type="button"
                    name="toggle_custom_rates"
                    @click=${() =>
                      editorOpen
                        ? this._closeCustomRatesEditor()
                        : this._openCustomRatesEditor()}
                  >
                    ${editorOpen ? 'Close' : toggleLabel}
                  </button>
                </div>
              `
            : null}
          ${editorOpen
            ? html`
                <div class="rates-editor">
                  <p class="rates-helper">
                    Rates in dollars per kWh (e.g. 0.36 = 36 cents/kWh).
                  </p>
                  ${ratesSource === 'zone'
                    ? html`
                        <div class="rates-actions">
                          <button
                            type="button"
                            name="import_from_zone"
                            @click=${() => this._importFromZone()}
                          >
                            Import from Zone ${zoneForImport}
                          </button>
                        </div>
                      `
                    : null}
                  <table class="rates-table">
                    <thead>
                      <tr>
                        <th>Hour</th>
                        <th>$/kWh</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${inputs.map((val, i) => {
                        const err = rowErrors[i];
                        const hourLabel = `${String(i).padStart(2, '0')}:00`;
                        return html`
                          <tr data-row=${i}>
                            <td>${hourLabel}</td>
                            <td>
                              <input
                                type="number"
                                step="0.001"
                                min="0"
                                max="2"
                                name=${`rate_${i}`}
                                data-hour=${i}
                                .value=${val}
                                class=${err ? 'invalid' : ''}
                                @input=${(e: Event) =>
                                  this._onCustomRateInput(
                                    i,
                                    (e.target as HTMLInputElement).value,
                                  )}
                              />
                              ${err
                                ? html`<div class="row-error">${err}</div>`
                                : ''}
                            </td>
                          </tr>
                        `;
                      })}
                    </tbody>
                  </table>
                  ${saveError
                    ? html`<p class="rates-api-error" role="alert">
                        ${saveError}
                      </p>`
                    : ''}
                  <div class="rates-actions">
                    <button
                      type="button"
                      name="save_rates"
                      class="primary"
                      ?disabled=${hasRowError || saving}
                      @click=${() => void this._saveCustomRates()}
                    >
                      Save
                    </button>
                    ${rates && hasCustomRates(rates)
                      ? html`
                          <button
                            type="button"
                            name="clear_override"
                            ?disabled=${saving}
                            @click=${() =>
                              void this._clearCustomRatesOverride()}
                          >
                            Clear override
                          </button>
                        `
                      : ''}
                  </div>
                </div>
              `
            : null}
        </div>

        <div class="settings-section">
          <h3>Account</h3>
          <div class="account-email">${email}</div>
          <div class="account-actions">
            <button
              class="account-signout"
              type="button"
              @click=${this._onSignOut}
            >
              Sign out
            </button>
            <button class="account-delete" type="button" disabled>
              Delete account
            </button>
          </div>
          <p class="hint">Contact info@hungrymachines.io to delete your account.</p>
        </div>
      </div>
    `;
  }
}
