import { LitElement, html, css, type TemplateResult } from 'lit';
import { authStore, type AuthState } from '../store.js';
import {
  getAllSchedules,
  recomputeSchedule,
  type ApplianceScheduleEntry,
  type RecomputeApplianceResult,
  type SchedulesResponse,
} from '../api/schedules.js';
import {
  get as getRates,
  update as updateRates,
  type RatesResponse,
  type DeliveryTodCents,
} from '../api/rates.js';
import {
  list as listAppliances,
  remove as appliancesApiRemove,
  getConstraints as getApplianceConstraints,
  update as updateAppliance,
  type Appliance,
  type ApplianceType,
} from '../api/appliances.js';
import * as calibrationApi from '../api/calibration.js';
import type {
  CalibrationStatusResponse,
} from '../api/calibration.js';
import { patchMe } from '../api/auth.js';
import { get as getPreferences, update as updatePreferences, type Preferences } from '../api/preferences.js';
import * as feedbackApi from '../api/feedback.js';
import type { FeedbackCategory } from '../api/feedback.js';
import {
  get as getAppliancePreferences,
  update as updateAppliancePreferences,
  type AppliancePreferences,
} from '../api/appliance-preferences.js';
import { expandHourlyTo48, hasCustomRates, hasHourlyComfortBands } from '../utils/hourly.js';
import {
  groupPricingZones,
  pricingZoneFullLabel,
  pricingZoneOptionLabel,
} from '../data/pricing-zones.js';

type HassStateLike = { entity_id?: string; state?: unknown; attributes?: Record<string, unknown> };
type HassLike = {
  states?: Record<string, HassStateLike>;
  callService?: (domain: string, service: string, data?: Record<string, unknown>) => Promise<unknown> | unknown;
};

type View = 'dashboard' | 'settings';

const TYPE_LABELS: Record<ApplianceType, string> = {
  hvac: 'HVAC',
  ev_charger: 'EV',
  home_battery: 'Battery',
  water_heater: 'Water',
  solar: 'Solar',
  dehumidifier: 'Dehumidifier',
  robot: 'Robot',
};

function asNumberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((v) => typeof v === 'number') ? (value as number[]) : undefined;
}

const DELIVERY_TOD_PERIODS = ['morning', 'midday_peak', 'evening', 'overnight'] as const;
type DeliveryTodPeriod = (typeof DELIVERY_TOD_PERIODS)[number];
type DeliveryTodDraft = Record<DeliveryTodPeriod, string>;

const DELIVERY_TOD_LABELS: Record<DeliveryTodPeriod, string> = {
  morning: 'Morning 6 a.m.-1 p.m.',
  midday_peak: 'Mid-Day Peak 1-7 p.m.',
  evening: 'Evening 7-9 p.m.',
  overnight: 'Overnight 9 p.m.-6 a.m.',
};

const EMPTY_DELIVERY_TOD_DRAFT: DeliveryTodDraft = {
  morning: '',
  midday_peak: '',
  evening: '',
  overnight: '',
};

function isValidDeliveryTodCents(value: unknown): value is DeliveryTodCents {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return DELIVERY_TOD_PERIODS.every(
    (p) => typeof record[p] === 'number' && Number.isFinite(record[p] as number),
  );
}

function deliveryTodCentsToDraft(map: DeliveryTodCents): DeliveryTodDraft {
  return {
    morning: String(map.morning),
    midday_peak: String(map.midday_peak),
    evening: String(map.evening),
    overnight: String(map.overnight),
  };
}

/**
 * Human-readable summary of the per-appliance problems in a recompute
 * response, or null when every appliance re-optimized cleanly. Only
 * `failed` and `calibration` are user-visible problems — the other
 * statuses (ok/forecast/observe/skipped) are expected outcomes.
 */
function describeRecomputeProblems(
  results: RecomputeApplianceResult[] | undefined,
): string | null {
  if (!Array.isArray(results)) return null;
  const failed = results.filter((r) => r.status === 'failed');
  const calibrating = results.filter((r) => r.status === 'calibration');
  const parts: string[] = [];
  if (failed.length > 0) {
    parts.push(
      `${failed.map((r) => r.name).join(', ')} could not be re-optimized — ` +
        'the chart may show an older schedule. Your changes were saved; ' +
        "tonight's run will retry.",
    );
  }
  if (calibrating.length > 0) {
    parts.push(
      `${calibrating.map((r) => r.name).join(', ')}: a calibration run is ` +
        'scheduled, so constraint changes will take effect after it completes.',
    );
  }
  return parts.length > 0 ? parts.join(' ') : null;
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

// Completed-calibration banners are informational — once the user has
// seen the measured rates they can dismiss the banner, and we also
// auto-hide it after CALIBRATION_BANNER_TTL_DAYS so it doesn't linger
// forever for users who never click. Dismissed run ids persist in
// localStorage keyed by calibration_runs.id so the choice survives
// panel reloads and HA restarts.
const CALIBRATION_DISMISS_STORAGE_KEY = 'hm-panel-dismissed-calibrations';
const CALIBRATION_BANNER_TTL_DAYS = 14;

function _loadDismissedCalibrations(): Set<number> {
  try {
    const raw = globalThis.localStorage?.getItem(CALIBRATION_DISMISS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return new Set(parsed.filter((v): v is number => typeof v === 'number'));
      }
    }
  } catch {
    // happy-dom + private browsing both throw on localStorage — fall through
  }
  return new Set();
}

function _saveDismissedCalibrations(ids: Set<number>): void {
  try {
    globalThis.localStorage?.setItem(
      CALIBRATION_DISMISS_STORAGE_KEY,
      JSON.stringify([...ids]),
    );
  } catch {
    // best-effort persistence
  }
}

// User-level and per-appliance preferences are cached in localStorage so
// the constraint editor shows last-known values on its first open after a
// fresh panel mount — without this the editor briefly seeds from the
// user-level fallback (per-appliance rows are fetched lazily on open),
// which reads as "my changes reset" to the user. Each blob is stamped with
// the `user_id` it belongs to so a different account logging in on the same
// browser can never read the prior user's cache (the network fetch is still
// the source of truth and refreshes these the moment it lands).
const APPLIANCE_PREFS_STORAGE_KEY = 'hm-panel-appliance-prefs';
const USER_PREFS_STORAGE_KEY = 'hm-panel-user-prefs';

function _loadAppliancePrefs(userId: string): Record<string, AppliancePreferences> {
  if (!userId) return {};
  try {
    const raw = globalThis.localStorage?.getItem(APPLIANCE_PREFS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as {
        user_id?: unknown;
        prefs?: unknown;
      };
      if (
        parsed &&
        parsed.user_id === userId &&
        parsed.prefs &&
        typeof parsed.prefs === 'object'
      ) {
        return parsed.prefs as Record<string, AppliancePreferences>;
      }
    }
  } catch {
    // happy-dom + private browsing both throw on localStorage — fall through
  }
  return {};
}

function _saveAppliancePrefs(
  userId: string,
  prefs: Record<string, AppliancePreferences>,
): void {
  if (!userId) return;
  try {
    globalThis.localStorage?.setItem(
      APPLIANCE_PREFS_STORAGE_KEY,
      JSON.stringify({ user_id: userId, prefs }),
    );
  } catch {
    // best-effort persistence
  }
}

function _loadUserPrefs(userId: string): Preferences | null {
  if (!userId) return null;
  try {
    const raw = globalThis.localStorage?.getItem(USER_PREFS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { user_id?: unknown; prefs?: unknown };
      if (
        parsed &&
        parsed.user_id === userId &&
        parsed.prefs &&
        typeof parsed.prefs === 'object'
      ) {
        return parsed.prefs as Preferences;
      }
    }
  } catch {
    // happy-dom + private browsing both throw on localStorage — fall through
  }
  return null;
}

function _saveUserPrefs(userId: string, prefs: Preferences | null): void {
  if (!userId || !prefs) return;
  try {
    globalThis.localStorage?.setItem(
      USER_PREFS_STORAGE_KEY,
      JSON.stringify({ user_id: userId, prefs }),
    );
  } catch {
    // best-effort persistence
  }
}

// Non-HVAC appliance constraints (EV target/deadline, battery bounds, water
// heater min/max) live in a separate `constraints` column the appliance-list
// projection omits, so the editor lazily fetches them per open. Cache them
// the same way as HVAC prefs so a fresh mount shows last-known values without
// waiting on the GET. Stamped with user_id for the same cross-user safety.
const APPLIANCE_CONSTRAINTS_STORAGE_KEY = 'hm-panel-appliance-constraints';

function _loadApplianceConstraints(
  userId: string,
): Record<string, Record<string, unknown>> {
  if (!userId) return {};
  try {
    const raw = globalThis.localStorage?.getItem(APPLIANCE_CONSTRAINTS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { user_id?: unknown; constraints?: unknown };
      if (
        parsed &&
        parsed.user_id === userId &&
        parsed.constraints &&
        typeof parsed.constraints === 'object'
      ) {
        return parsed.constraints as Record<string, Record<string, unknown>>;
      }
    }
  } catch {
    // happy-dom + private browsing both throw on localStorage — fall through
  }
  return {};
}

function _saveApplianceConstraints(
  userId: string,
  constraints: Record<string, Record<string, unknown>>,
): void {
  if (!userId) return;
  try {
    globalThis.localStorage?.setItem(
      APPLIANCE_CONSTRAINTS_STORAGE_KEY,
      JSON.stringify({ user_id: userId, constraints }),
    );
  } catch {
    // best-effort persistence
  }
}

function _clearPersistedPrefs(): void {
  try {
    globalThis.localStorage?.removeItem(APPLIANCE_PREFS_STORAGE_KEY);
    globalThis.localStorage?.removeItem(USER_PREFS_STORAGE_KEY);
    globalThis.localStorage?.removeItem(APPLIANCE_CONSTRAINTS_STORAGE_KEY);
  } catch {
    // best-effort
  }
}

// True once a completed calibration is older than the banner TTL. A
// null/unparseable timestamp is treated as not-expired so the banner
// still shows (and stays dismissable).
function _calibrationExpired(completedAt: string | null): boolean {
  if (!completedAt) return false;
  const finished = new Date(completedAt).getTime();
  if (!Number.isFinite(finished)) return false;
  const ageMs = Date.now() - finished;
  return ageMs > CALIBRATION_BANNER_TTL_DAYS * 24 * 60 * 60 * 1000;
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
    case 'robot': {
      // Charges toward target overnight before the Tasks window opens, holds
      // where it landed while off-dock doing tasks, tops back up once
      // redocked — the dock-as-charging-proxy pattern (no undock, no task
      // starts) with a visible mid-day gap.
      const trajectory = Array.from({ length: 48 }, (_, i) => {
        if (i < 18) return Math.round((25 + (i / 18) * 65) * 10) / 10; // 25% -> 90% by window start
        if (i < 34) return 60; // off-dock during the tasks window
        return Math.round((60 + ((i - 34) / 14) * 30) * 10) / 10; // 60% -> 90% after redocking
      });
      return {
        intervals: Array.from({ length: 48 }, (_, i) => i >= 10 && i < 18),
        value_trajectory: trajectory,
        unit: 'percent',
        min_value: 25,
        target_value: 90,
        deadline_interval: 18,
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
    case 'dehumidifier': return 'Dehumidifier';
    case 'robot': return 'Home robot';
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
    .opt-toggle {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 14px;
      border-radius: 999px;
      border: 1px solid rgba(100, 116, 139, 0.25);
      background: var(--hm-bg, #F8FAFC);
      color: var(--hm-text, #0F172A);
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
    }
    .opt-toggle:disabled {
      opacity: 0.6;
      cursor: wait;
    }
    .opt-toggle .opt-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #0F766E;
    }
    .opt-toggle.paused .opt-dot {
      background: #F59E0B;
    }
    /* Compact per-device pause toggle in each card header. Smaller
       sibling of the master .opt-toggle. */
    .device-opt-toggle {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
      padding: 4px 10px;
      border-radius: 999px;
      border: 1px solid rgba(100, 116, 139, 0.25);
      background: var(--hm-bg, #F8FAFC);
      color: var(--hm-text, #0F172A);
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
    }
    .device-opt-toggle:disabled {
      opacity: 0.6;
      cursor: wait;
    }
    .device-opt-toggle .opt-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #0F766E;
    }
    .device-opt-toggle.paused .opt-dot {
      background: #F59E0B;
    }
    .device-opt-toggle.paused {
      color: var(--hm-muted, #64748B);
    }
    .paused-banner {
      background: rgba(245, 158, 11, 0.12);
      border: 1px solid rgba(245, 158, 11, 0.5);
      border-radius: 10px;
      padding: 12px 16px;
      margin-bottom: 16px;
      color: var(--hm-text, #0F172A);
      font-size: 14px;
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
    .calibration-banners {
      display: flex;
      flex-direction: column;
      gap: 12px;
      margin-bottom: 18px;
    }
    .banner.calibration {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      padding: 14px 18px;
      border-radius: 10px;
      font-size: 14px;
      line-height: 1.4;
    }
    .banner.calibration.in-progress {
      background: rgba(245, 158, 11, 0.10);
      border: 1px solid var(--hm-accent, #F59E0B);
      color: var(--hm-text, #0F172A);
    }
    .banner.calibration.complete {
      background: rgba(15, 118, 110, 0.08);
      border: 1px solid var(--hm-secondary, #0F766E);
      color: var(--hm-text, #0F172A);
    }
    .banner-text {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .banner-text strong {
      color: var(--hm-primary, #1E3A8A);
    }
    .banner-skip {
      background: transparent;
      border: 1px solid var(--hm-muted, #64748B);
      color: var(--hm-muted, #64748B);
      padding: 6px 14px;
      border-radius: 6px;
      font: inherit;
      cursor: pointer;
      align-self: center;
    }
    .banner-skip:hover {
      background: var(--hm-muted, #64748B);
      color: #ffffff;
    }
    .banner-skip[disabled] {
      opacity: 0.55;
      cursor: not-allowed;
    }
    .banner-dismiss {
      background: transparent;
      border: none;
      color: var(--hm-muted, #64748B);
      font: inherit;
      font-size: 16px;
      line-height: 1;
      padding: 2px 6px;
      border-radius: 6px;
      cursor: pointer;
      align-self: flex-start;
    }
    .banner-dismiss:hover {
      color: var(--hm-text, #0F172A);
      background: rgba(100, 116, 139, 0.12);
    }
    .diagnostics-section {
      margin-bottom: 16px;
    }
    .diagnostics-section:empty {
      display: none;
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
    .card .entity-binding {
      color: var(--hm-muted, #64748B);
      font-size: 0.9rem;
      font-family: var(--hm-font-mono, monospace);
      letter-spacing: 0.01em;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .card .entity-binding[hidden] {
      display: none;
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
    .settings-section textarea {
      width: 100%;
      padding: 8px 10px;
      border: 1px solid var(--hm-muted, #64748B);
      border-radius: 6px;
      font: inherit;
      background: var(--hm-bg, #F8FAFC);
      color: var(--hm-text, #0F172A);
      box-sizing: border-box;
      resize: vertical;
      min-height: 80px;
    }
    .settings-section textarea:disabled {
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
    .dynamic-fields {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    /* The explicit display above overrides the UA [hidden] rule, so the
       ?hidden binding wouldn't hide the Region + adder. Re-assert it: these
       fields only belong under Source = Dynamic. */
    .dynamic-fields[hidden] {
      display: none;
    }
    .delivery-tod-fields {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
      gap: 12px;
    }
    .delivery-tod-fields .hint {
      grid-column: 1 / -1;
    }
    .pricing-adder-input {
      width: 100%;
      padding: 8px 10px;
      border: 1px solid var(--hm-muted, #64748B);
      border-radius: 6px;
      font: inherit;
      background: var(--hm-bg, #F8FAFC);
      color: var(--hm-text, #0F172A);
      box-sizing: border-box;
    }
    .pricing-adder-input:disabled {
      opacity: 0.55;
      cursor: not-allowed;
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
    _appliancePrefsById: { state: true },
    _applianceConstraintsById: { state: true },
    _addApplianceOpen: { state: true },
    // Appliance currently being edited via the appliance-form overlay.
    // Null when the form is in CREATE mode (or closed entirely).
    _editingAppliance: { state: true },
    // Pending delete confirmation — when set, the delete confirm modal
    // is shown for that appliance.
    _deletingAppliance: { state: true },
    _deleting: { state: true },
    _deleteError: { state: true },
    // Per-HVAC-appliance calibration status snapshot. Populated when
    // the dashboard loads and refreshed on appliance-updated events.
    _calibrationByAppliance: { state: true },
    _calibrationSkipping: { state: true },
    _dismissedCalibrations: { state: true },
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
    _pricingSourceDraft: { state: true },
    _dynamicZoneDraft: { state: true },
    _pricingAdderDraft: { state: true },
    _deliveryTariffDraft: { state: true },
    _deliveryTodDraft: { state: true },
    _pricingSaving: { state: true },
    _pricingError: { state: true },
    _pricingSavedFlash: { state: true },
    _recomputing: { state: true },
    _recomputeError: { state: true },
    _chartSize: { state: true },
    _optToggleBusy: { state: true },
    _deviceOptToggleBusy: { state: true },
    _feedbackCategory: { state: true },
    _feedbackMessage: { state: true },
    _feedbackSubmitting: { state: true },
    _feedbackError: { state: true },
    _feedbackSent: { state: true },
  };

  hass: unknown = undefined;
  _auth: AuthState = authStore.state;
  _view: View = 'dashboard';
  _schedulesLoading = false;
  _schedulesError: string | null = null;
  _schedules: SchedulesResponse | null = null;
  _rates: RatesResponse | null = null;
  _preferences: Preferences | null = null;
  _optToggleBusy = false;
  // Per-appliance optimization toggle in-flight guards, keyed by
  // appliance_id, so one card's toggle spinner doesn't block the others.
  _deviceOptToggleBusy: Record<string, boolean> = {};
  _editorOpen = false;
  _editorApplianceId = '';
  _editorApplianceType: ApplianceType = 'hvac';
  _editorConstraints: Record<string, unknown> | undefined = undefined;
  // Per-HVAC-appliance preferences cache (US-MHVAC-017). Populated
  // lazily when the user opens the HVAC editor and refreshed in
  // place when the editor save event fires. Independent of the
  // user-level _preferences row so two HVACs hold and submit
  // independent values.
  _appliancePrefsById: Record<string, AppliancePreferences> = {};
  // Per-appliance constraints cache for NON-HVAC units (EV/battery/water).
  // Same lazy-fetch-on-open + localStorage-persist story as
  // _appliancePrefsById, but keyed to the `constraints` column instead of
  // the appliance-preferences row.
  _applianceConstraintsById: Record<string, Record<string, unknown>> = {};
  _addApplianceOpen = false;
  _editingAppliance: Appliance | null = null;
  _deletingAppliance: Appliance | null = null;
  _deleting = false;
  _deleteError: string | null = null;
  _calibrationByAppliance: Record<string, CalibrationStatusResponse> = {};
  _calibrationSkipping = false;
  // Run ids of completed-calibration banners the user has dismissed.
  // Hydrated from localStorage so the dismissal sticks across reloads.
  _dismissedCalibrations: Set<number> = _loadDismissedCalibrations();
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
  _pricingSourceDraft: 'zone' | 'custom' | 'dynamic' = 'zone';
  _dynamicZoneDraft = '';
  _pricingAdderDraft = '';
  // Selected delivery-tariff ruleset id, as a string for the <select>
  // binding; '' means "Flat estimate" (adder_grid_ruleset_id: null).
  _deliveryTariffDraft = '';
  // The four editable DTOD period prices (string inputs), shown only when
  // _deliveryTariffDraft is a class. Prefilled from the selected class's
  // period_rates or the stored delivery_tod_cents; edited freely after.
  _deliveryTodDraft: DeliveryTodDraft = { ...EMPTY_DELIVERY_TOD_DRAFT };
  _pricingSaving = false;
  _pricingError: string | null = null;
  _pricingSavedFlash = false;
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
  // "Send feedback" form (Settings tab). Independent of every other
  // settings draft — submitting POSTs to /api/v1/feedback and clears.
  _feedbackCategory: FeedbackCategory = 'comment';
  _feedbackMessage = '';
  _feedbackSubmitting = false;
  _feedbackError: string | null = null;
  _feedbackSent = false;

  private _unsubscribe: (() => void) | null = null;
  private _schedulesFetched = false;
  private _ratesInflight = false;
  private _appliancesById: Record<string, Appliance> = {};
  private _savedFlashTimer: ReturnType<typeof setTimeout> | null = null;
  private _pricingDraftsInitialized = false;
  private _pricingSavedFlashTimer: ReturnType<typeof setTimeout> | null = null;
  private _feedbackSentTimer: ReturnType<typeof setTimeout> | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    this._auth = authStore.state;
    this._zoneDraft = this._auth.user?.pricing_location ?? 1;
    this._weatherEntityDraft = this._auth.user?.weather_entity_id ?? '';
    // authStore is a module singleton, so a panel remount within the same
    // session lands here already 'authed' — hydrate the persisted prefs
    // caches now so the first editor open shows last-known values.
    if (this._auth.status === 'authed') {
      this._hydratePrefsCaches();
    }
    this._unsubscribe = authStore.subscribe((s) => {
      const prevStatus = this._auth.status;
      this._auth = s;
      if (prevStatus !== 'authed' && s.status === 'authed') {
        this._zoneDraft = s.user?.pricing_location ?? 1;
        this._weatherEntityDraft = s.user?.weather_entity_id ?? '';
        this._hydratePrefsCaches();
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
    if (this._pricingSavedFlashTimer !== null) {
      clearTimeout(this._pricingSavedFlashTimer);
      this._pricingSavedFlashTimer = null;
    }
    if (this._feedbackSentTimer !== null) {
      clearTimeout(this._feedbackSentTimer);
      this._feedbackSentTimer = null;
    }
  }

  private _selectView(view: View): void {
    this._view = view;
    if (view === 'dashboard') {
      if (this._schedulesFetched) {
        // Revisiting the dashboard — refresh just the rate curve so the
        // price bars reflect today's prices (dynamic LMPs roll over daily)
        // and any change saved elsewhere. Schedules only change nightly, so
        // they stay cached.
        void this._refreshRates();
      } else {
        void this._loadSchedulesIfNeeded();
      }
    } else if (view === 'settings') {
      void this._loadRatesIfNeeded();
    }
  }

  private _currentUserId(): string {
    return this._auth.user?.user_id ?? '';
  }

  // Seed the in-memory preference caches from localStorage once we know
  // who the user is. Fresh in-memory rows win — the persisted blob only
  // fills gaps (e.g. per-appliance rows we haven't lazily fetched yet),
  // so the network fetch in _loadSchedulesIfNeeded still overrides it.
  private _hydratePrefsCaches(): void {
    const userId = this._currentUserId();
    if (!userId) return;
    const persisted = _loadAppliancePrefs(userId);
    if (Object.keys(persisted).length > 0) {
      this._appliancePrefsById = { ...persisted, ...this._appliancePrefsById };
    }
    const persistedConstraints = _loadApplianceConstraints(userId);
    if (Object.keys(persistedConstraints).length > 0) {
      this._applianceConstraintsById = {
        ...persistedConstraints,
        ...this._applianceConstraintsById,
      };
    }
    if (!this._preferences) {
      const userPrefs = _loadUserPrefs(userId);
      if (userPrefs) this._preferences = userPrefs;
    }
  }

  private _persistAppliancePrefs(): void {
    _saveAppliancePrefs(this._currentUserId(), this._appliancePrefsById);
  }

  private _persistApplianceConstraints(): void {
    _saveApplianceConstraints(this._currentUserId(), this._applianceConstraintsById);
  }

  private _persistUserPrefs(): void {
    _saveUserPrefs(this._currentUserId(), this._preferences);
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
      this._initPricingDraftsFromRates(rates);
      this._preferences = preferences;
      this._persistUserPrefs();
      const map: Record<string, Appliance> = {};
      if (Array.isArray(appliances)) {
        for (const a of appliances) map[a.id] = a;
      }
      this._appliancesById = map;
      // Calibration status — one fetch per HVAC appliance. Errors
      // are swallowed; the banner just won't render. Runs after the
      // appliance list lands so we know which ids to query.
      void this._refreshCalibrationStatuses();
      // Per-appliance preferences — one fetch per HVAC so each card's
      // comfort-band overlay reflects that machine's own saved band
      // without the user having to open its editor first. Best-effort:
      // a failed fetch leaves the card on the band baked into its
      // schedule row (or the persisted cache from a prior session).
      void this._refreshAppliancePrefs();
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

  private async _refreshCalibrationStatuses(): Promise<void> {
    const hvacIds = Object.values(this._appliancesById)
      .filter((a) => a.appliance_type === 'hvac')
      .map((a) => a.id);
    if (hvacIds.length === 0) {
      this._calibrationByAppliance = {};
      return;
    }
    const next: Record<string, CalibrationStatusResponse> = {};
    await Promise.all(
      hvacIds.map(async (id) => {
        try {
          const status = await calibrationApi.getStatus(id);
          next[id] = status;
        } catch {
          // Best effort — leave it out of the map; banner won't render.
        }
      }),
    );
    this._calibrationByAppliance = next;
  }

  private async _refreshAppliancePrefs(): Promise<void> {
    const hvacIds = Object.values(this._appliancesById)
      .filter((a) => a.appliance_type === 'hvac')
      .map((a) => a.id);
    if (hvacIds.length === 0) return;
    const fetched: Record<string, AppliancePreferences> = {};
    await Promise.all(
      hvacIds.map(async (id) => {
        try {
          fetched[id] = await getAppliancePreferences(id);
        } catch {
          // Best effort — the card falls back to its schedule row's
          // baked band (or a previously cached prefs row).
        }
      }),
    );
    if (Object.keys(fetched).length === 0) return;
    this._appliancePrefsById = { ...this._appliancePrefsById, ...fetched };
    this._persistAppliancePrefs();
  }

  private async _onCalibrationSkip(applianceId: string): Promise<void> {
    if (this._calibrationSkipping) return;
    this._calibrationSkipping = true;
    try {
      await calibrationApi.skip(applianceId);
      // Refresh the status so the banner disappears.
      const fresh = await calibrationApi.getStatus(applianceId);
      this._calibrationByAppliance = {
        ...this._calibrationByAppliance,
        [applianceId]: fresh,
      };
    } catch {
      // Surface failure silently for now; the banner will retry on
      // next dashboard load. (No toast infrastructure to wire into.)
    } finally {
      this._calibrationSkipping = false;
    }
  }

  private _onCalibrationDismiss(runId: number): void {
    const next = new Set(this._dismissedCalibrations);
    next.add(runId);
    this._dismissedCalibrations = next;
    _saveDismissedCalibrations(next);
  }

  private _retrySchedules(): void {
    this._schedulesError = null;
    void this._loadSchedulesIfNeeded();
  }

  private _onSignOut = (): void => {
    // Drop the cached prefs on explicit sign-out so they don't linger in
    // localStorage. (Cross-user safety is already covered by the user_id
    // stamp on each blob, but clearing on logout is the privacy-clean move.)
    _clearPersistedPrefs();
    this._appliancePrefsById = {};
    this._applianceConstraintsById = {};
    this._preferences = null;
    authStore.logout();
  };

  private _onWeatherEntityChange(entityId: string): void {
    this._weatherEntityDraft = entityId;
  }

  private _onZoneChange(zone: number): void {
    this._zoneDraft = zone;
  }

  private _isDirty(): boolean {
    // Weather-only now — the pricing zone moved into the unified Pricing
    // source section (saved via _savePricingSource).
    const currentWeather = this._auth.user?.weather_entity_id ?? '';
    return this._weatherEntityDraft !== currentWeather;
  }

  private async _onSave(): Promise<void> {
    if (!this._isDirty()) return;
    const currentWeather = this._auth.user?.weather_entity_id ?? '';
    const patch: { weather_entity_id?: string } = {};
    if (this._weatherEntityDraft !== currentWeather)
      patch.weather_entity_id = this._weatherEntityDraft;

    this._zoneSaving = true;
    this._zoneError = null;
    try {
      const updated = await patchMe(patch);
      authStore.patchUser({
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
    this._weatherEntityDraft = this._auth.user?.weather_entity_id ?? '';
  }

  /**
   * Re-fetch the rate curve so the dashboard's price bars track the current
   * day's prices (dynamic day-ahead LMPs roll over daily) and any change
   * saved elsewhere. Updates `_rates` only — it does NOT re-seed the pricing
   * drafts, so an in-progress (unsaved) Settings edit survives a tab switch.
   */
  private async _refreshRates(): Promise<void> {
    if (this._auth.status !== 'authed') return;
    if (this._ratesInflight) return;
    this._ratesInflight = true;
    try {
      this._rates = await getRates();
    } catch {
      // Keep the existing _rates on a transient failure — stale bars beat
      // blank bars.
    } finally {
      this._ratesInflight = false;
    }
  }

  private async _loadRatesIfNeeded(): Promise<void> {
    if (this._rates !== null) return;
    if (this._ratesInflight) return;
    if (this._auth.status !== 'authed') return;
    this._ratesInflight = true;
    this._ratesLoading = true;
    this._ratesError = null;
    try {
      const rates = await getRates();
      this._rates = rates;
      this._initPricingDraftsFromRates(rates);
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

  private _initPricingDraftsFromRates(rates: RatesResponse): void {
    const source = rates.pricing_source ?? 'zone';
    this._pricingSourceDraft = source === 'dynamic' || source === 'custom' ? source : 'zone';
    const zones = Array.isArray(rates.available_dynamic_zones)
      ? rates.available_dynamic_zones
      : [];
    const storedZone = rates.dynamic_zone ?? '';
    if (storedZone) {
      this._dynamicZoneDraft = storedZone;
    } else if (zones.length > 0) {
      const comed = zones.find((z) => z.slug.toLowerCase() === 'comed');
      this._dynamicZoneDraft = (comed ?? zones[0]).slug;
    } else {
      this._dynamicZoneDraft = '';
    }
    const adder = rates.pricing_adder_cents_per_kwh;
    // Pre-populate the flat adder with the 8 c/kWh default (matches the
    // backend DYNAMIC_ADDER_CENTS_DEFAULT) when the user hasn't set one,
    // so the field is never blank — they can change it only if they wish.
    this._pricingAdderDraft =
      typeof adder === 'number' && Number.isFinite(adder) ? String(adder) : '8';
    const deliveryId = rates.adder_grid_ruleset_id;
    this._deliveryTariffDraft =
      typeof deliveryId === 'number' && Number.isFinite(deliveryId) ? String(deliveryId) : '';
    // The four period-price inputs init from the stored per-user map when
    // present, else the selected class's published defaults.
    if (isValidDeliveryTodCents(rates.delivery_tod_cents)) {
      this._deliveryTodDraft = deliveryTodCentsToDraft(rates.delivery_tod_cents);
    } else {
      const tariffs = Array.isArray(rates.available_delivery_tariffs)
        ? rates.available_delivery_tariffs
        : [];
      const selected = tariffs.find((t) => String(t.id) === this._deliveryTariffDraft);
      this._deliveryTodDraft = selected?.period_rates
        ? deliveryTodCentsToDraft(selected.period_rates)
        : { ...EMPTY_DELIVERY_TOD_DRAFT };
    }
    // Zone draft tracks the catalog id; keep it in sync with the loaded
    // rates so Reset returns to the stored zone.
    if (typeof rates.pricing_location === 'number') {
      this._zoneDraft = rates.pricing_location;
    }
    this._pricingDraftsInitialized = true;
  }

  private _onPricingSourceChange(value: string): void {
    if (value === 'zone' || value === 'custom' || value === 'dynamic') {
      this._pricingSourceDraft = value;
      // Switching to dynamic with a blank adder pre-fills the 8 c/kWh
      // default so the user sees a sensible starting value.
      if (value === 'dynamic' && this._pricingAdderDraft.trim() === '') {
        this._pricingAdderDraft = '8';
      }
      this._pricingError = null;
    }
  }

  private _onDynamicZoneChange(value: string): void {
    this._dynamicZoneDraft = value;
    this._pricingError = null;
  }

  private _onPricingAdderInput(value: string): void {
    this._pricingAdderDraft = value;
    this._pricingError = null;
  }

  private _onDeliveryTariffChange(value: string): void {
    this._deliveryTariffDraft = value;
    // Prefill the flat-adder estimate to reflect what it now covers, but
    // never clobber a value the user has deliberately typed. Choosing a
    // delivery plan when the adder is blank or the flat default ('8')
    // drops it to the non-delivery residual ('2'); returning to Flat
    // estimate when the adder is blank or that residual restores '8'.
    const draftTrim = this._pricingAdderDraft.trim();
    if (value !== '') {
      if (draftTrim === '' || draftTrim === '8') {
        this._pricingAdderDraft = '2';
      }
    } else if (draftTrim === '' || draftTrim === '2') {
      this._pricingAdderDraft = '8';
    }
    // Changing the class is a prefill action: it overwrites all four
    // period-price inputs with that class's published defaults. The user
    // edits freely afterward — this never runs again until the select
    // changes again.
    if (value !== '') {
      const tariffs = this._rates?.available_delivery_tariffs ?? [];
      const selected = tariffs.find((t) => String(t.id) === value);
      this._deliveryTodDraft = selected?.period_rates
        ? deliveryTodCentsToDraft(selected.period_rates)
        : { ...EMPTY_DELIVERY_TOD_DRAFT };
    }
    this._pricingError = null;
  }

  private _onDeliveryTodInput(period: DeliveryTodPeriod, value: string): void {
    this._deliveryTodDraft = { ...this._deliveryTodDraft, [period]: value };
    this._pricingError = null;
  }

  private _isPricingDirty(): boolean {
    const rates = this._rates;
    if (!rates) return false;
    const storedSource = rates.pricing_source ?? 'zone';
    if (this._pricingSourceDraft !== storedSource) return true;
    // Zone source: the static-catalog zone picker is dirty when changed.
    if (this._pricingSourceDraft === 'zone') {
      return this._zoneDraft !== (rates.pricing_location ?? 1);
    }
    if (this._pricingSourceDraft !== 'dynamic') return false;
    const storedZone = rates.dynamic_zone ?? '';
    if (this._dynamicZoneDraft !== storedZone) return true;
    const storedAdder = rates.pricing_adder_cents_per_kwh;
    const draftTrim = this._pricingAdderDraft.trim();
    if (draftTrim === '') {
      if (storedAdder !== null) return true;
    } else {
      const n = Number(draftTrim);
      if (!Number.isFinite(n) || n !== storedAdder) return true;
    }
    const storedDelivery = rates.adder_grid_ruleset_id;
    const storedDeliveryStr =
      typeof storedDelivery === 'number' ? String(storedDelivery) : '';
    if (this._deliveryTariffDraft !== storedDeliveryStr) return true;
    if (this._deliveryTariffDraft.trim() !== '') {
      const storedTod = rates.delivery_tod_cents;
      for (const p of DELIVERY_TOD_PERIODS) {
        const n = Number(this._deliveryTodDraft[p].trim());
        const storedVal = storedTod ? storedTod[p] : undefined;
        if (!Number.isFinite(n) || n !== storedVal) return true;
      }
    }
    return false;
  }

  private async _savePricingSource(): Promise<void> {
    const rates = this._rates;
    if (!rates) return;
    const draft = this._pricingSourceDraft;
    const body: {
      pricing_source: 'zone' | 'custom' | 'dynamic';
      pricing_location?: number;
      dynamic_zone?: string | null;
      pricing_adder_cents_per_kwh?: number | null;
      adder_grid_ruleset_id?: number | null;
      delivery_tod_cents?: DeliveryTodCents | null;
    } = { pricing_source: draft };
    if (draft === 'zone') {
      body.pricing_location = this._zoneDraft;
    } else if (draft === 'dynamic') {
      const zone = this._dynamicZoneDraft.trim();
      if (!zone) {
        this._pricingError = 'Choose a pricing region before saving.';
        return;
      }
      body.dynamic_zone = zone;
      const adderTrim = this._pricingAdderDraft.trim();
      if (adderTrim === '') {
        body.pricing_adder_cents_per_kwh = null;
      } else {
        const n = Number(adderTrim);
        if (!Number.isFinite(n) || n < 0 || n > 50) {
          this._pricingError = 'Adder must be between 0 and 50 cents/kWh.';
          return;
        }
        body.pricing_adder_cents_per_kwh = n;
      }
      const deliveryTrim = this._deliveryTariffDraft.trim();
      if (deliveryTrim === '') {
        body.adder_grid_ruleset_id = null;
        body.delivery_tod_cents = null;
      } else {
        const id = Number(deliveryTrim);
        body.adder_grid_ruleset_id = Number.isFinite(id) ? id : null;
        const map = {} as DeliveryTodCents;
        for (const p of DELIVERY_TOD_PERIODS) {
          const n = Number(this._deliveryTodDraft[p].trim());
          if (!Number.isFinite(n) || n < 0 || n > 50) {
            this._pricingError = `${DELIVERY_TOD_LABELS[p]} price must be between 0 and 50 cents/kWh.`;
            return;
          }
          map[p] = n;
        }
        body.delivery_tod_cents = map;
      }
    }
    this._pricingSaving = true;
    this._pricingError = null;
    try {
      const fresh = await updateRates(body);
      this._rates = fresh;
      // The dashboard reads the zone from auth.user.pricing_location; keep
      // it in sync so a zone change here reflects everywhere immediately.
      authStore.patchUser({ pricing_location: fresh.pricing_location });
      this._initPricingDraftsFromRates(fresh);
      this._pricingSavedFlash = true;
      if (this._pricingSavedFlashTimer !== null) {
        clearTimeout(this._pricingSavedFlashTimer);
      }
      this._pricingSavedFlashTimer = setTimeout(() => {
        this._pricingSavedFlash = false;
        this._pricingSavedFlashTimer = null;
      }, 2000);
    } catch (err) {
      this._pricingError =
        err instanceof Error && err.message
          ? err.message
          : 'Could not save pricing source';
    } finally {
      this._pricingSaving = false;
    }
  }

  private _resetPricingDraft(): void {
    const rates = this._rates;
    if (rates) {
      this._initPricingDraftsFromRates(rates);
    }
    this._pricingError = null;
  }

  private async _openEditor(applianceId: string, type: ApplianceType): Promise<void> {
    this._editorApplianceId = applianceId;
    this._editorApplianceType = type;
    if (type === 'hvac') {
      // Per-HVAC-appliance preferences (US-MHVAC-017). Always fetch a
      // fresh row on open so a paused/edited unit's UI reflects the
      // current server state, not whatever the user last looked at.
      // Seed from the cached row first so the editor renders without
      // a flash of the user-level fallback while the GET is in flight.
      const cached = this._appliancePrefsById[applianceId];
      if (cached) {
        this._editorConstraints = cached as unknown as Record<string, unknown>;
      } else if (this._preferences) {
        // Pre-MHVAC-017 fallback: a freshly-registered HVAC has no
        // appliance_preferences row in the cache; show the user-level
        // values so the form doesn't start blank, then overwrite with
        // the fetched per-appliance row when it lands.
        this._editorConstraints = this._preferences as unknown as Record<string, unknown>;
      } else {
        this._editorConstraints = undefined;
      }
      this._editorOpen = true;
      try {
        const prefs = await getAppliancePreferences(applianceId);
        this._appliancePrefsById = {
          ...this._appliancePrefsById,
          [applianceId]: prefs,
        };
        this._persistAppliancePrefs();
        // Only overwrite seed if the editor is still open on this
        // appliance — a fast cancel/reopen should not stomp the new
        // editor instance's freshly seeded values.
        if (this._editorOpen && this._editorApplianceId === applianceId) {
          this._editorConstraints = prefs as unknown as Record<string, unknown>;
        }
      } catch {
        // Best-effort: the editor stays on the cached/user-level seed.
        // The save path still PUTs to the per-appliance endpoint, so a
        // failed GET doesn't block the user from editing.
      }
    } else {
      // Non-HVAC constraints (EV/battery/water) live in the `constraints`
      // column, which the appliance-list projection omits — so config never
      // carries the charge/deadline/temp fields the editor reads. Seed from
      // the cache first (avoids a blank flash / stale-config values), then
      // fetch the authoritative row and re-seed when it lands.
      const cached = this._applianceConstraintsById[applianceId];
      this._editorConstraints = cached ?? {};
      this._editorOpen = true;
      try {
        const resp = await getApplianceConstraints(applianceId);
        const constraints = (resp?.constraints ?? {}) as Record<string, unknown>;
        this._applianceConstraintsById = {
          ...this._applianceConstraintsById,
          [applianceId]: constraints,
        };
        this._persistApplianceConstraints();
        if (this._editorOpen && this._editorApplianceId === applianceId) {
          this._editorConstraints = constraints;
        }
      } catch {
        // Best-effort: editor stays on the cached seed; the POST save path
        // is unaffected by a failed GET.
      }
    }
  }

  private _onEditorClosed(): void {
    this._editorOpen = false;
  }

  private _onConstraintsSaved(e: CustomEvent): void {
    // The editor just persisted to the backend. For HVAC saves the
    // payload IS the per-appliance preferences delta (US-MHVAC-017) —
    // fold it into our per-appliance cache so reopening the editor
    // reflects the just-saved state instead of the row we read at
    // panel mount. Without this patch the UI shows stale numbers
    // until a full panel reload, which is indistinguishable from
    // "save didn't work" to the user. The user-level _preferences
    // row is intentionally NOT touched here — the per-HVAC editor
    // does not edit user-global fields.
    const detail = (e?.detail ?? {}) as {
      applianceId?: string;
      payload?: Record<string, unknown>;
    };
    const payload = detail.payload;
    const applianceId = detail.applianceId ?? this._editorApplianceId;
    if (
      this._editorApplianceType === 'hvac' &&
      applianceId &&
      payload &&
      typeof payload === 'object'
    ) {
      const current = (this._appliancePrefsById[applianceId] ?? {}) as AppliancePreferences;
      this._appliancePrefsById = {
        ...this._appliancePrefsById,
        [applianceId]: {
          ...current,
          ...(payload as Partial<AppliancePreferences>),
        } as AppliancePreferences,
      };
      this._persistAppliancePrefs();
    } else if (applianceId && payload && typeof payload === 'object') {
      // Non-HVAC constraints: the editor POSTed the full constraints object
      // to the `constraints` column. Mirror it into our cache so a
      // same-session reopen (and the next mount) shows the just-saved
      // values instead of a blank form.
      this._applianceConstraintsById = {
        ...this._applianceConstraintsById,
        [applianceId]: { ...payload },
      };
      this._persistApplianceConstraints();
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
      // Per-appliance outcome of THIS run. The HTTP call succeeds even
      // when one appliance's optimization failed or was preempted by
      // calibration — without this check a failed zone silently keeps
      // its stale chart and the save looks like it worked.
      const problem = describeRecomputeProblems(fresh.results);
      if (problem) this._recomputeError = problem;
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
      // Drop the deleted appliance's cached prefs/constraints so they don't
      // linger in memory or localStorage as dead entries.
      if (this._appliancePrefsById[target.id]) {
        const prefsNext = { ...this._appliancePrefsById };
        delete prefsNext[target.id];
        this._appliancePrefsById = prefsNext;
        this._persistAppliancePrefs();
      }
      if (this._applianceConstraintsById[target.id]) {
        const consNext = { ...this._applianceConstraintsById };
        delete consNext[target.id];
        this._applianceConstraintsById = consNext;
        this._persistApplianceConstraints();
      }
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
        .existingAppliances=${Object.values(this._appliancesById)}
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
      'hvac', 'ev_charger', 'home_battery', 'water_heater', 'solar', 'robot',
    ];
    const missingTypes = ALL_TYPES.filter((t) => !registeredTypes.has(t));

    return html`
      <div class="dashboard-head">
        <h2>Dashboard</h2>
        ${this._renderOptimizationToggle()}
        ${this._renderChartSizeToggle()}
      </div>
      <div class="calibration-section">${this._renderPausedBanner()}${this._renderCalibrationBanners()}</div>
      <div class="diagnostics-section">
        <hm-diagnostics-panel></hm-diagnostics-panel>
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

  private _optimizationEnabled(): boolean {
    // Missing field (older API) means enabled — never render the
    // paused state unless the backend explicitly said so.
    return this._preferences?.optimization_enabled !== false;
  }

  private _renderPausedBanner(): TemplateResult {
    if (this._optimizationEnabled()) return html``;
    return html`<div class="paused-banner" role="status">
      Optimization is paused — your devices are under manual control
      and no schedules will be applied. Schedules are still computed
      nightly, so turning optimization back on takes effect within 30
      minutes.
    </div>`;
  }

  private _renderOptimizationToggle(): TemplateResult {
    const enabled = this._optimizationEnabled();
    return html`
      <button
        class="opt-toggle ${enabled ? '' : 'paused'}"
        type="button"
        ?disabled=${this._optToggleBusy}
        title=${enabled
          ? 'Pause optimization — devices return to manual control'
          : 'Resume optimization — schedules apply within 30 minutes'}
        @click=${() => this._toggleOptimization()}
      >
        <span class="opt-dot"></span>
        ${enabled ? 'Optimization on' : 'Optimization paused'}
      </button>
    `;
  }

  private async _toggleOptimization(): Promise<void> {
    if (this._optToggleBusy) return;
    const next = !this._optimizationEnabled();
    this._optToggleBusy = true;
    try {
      this._preferences = await updatePreferences({
        optimization_enabled: next,
      });
      this._persistUserPrefs();
    } catch {
      // PUT failed — leave _preferences untouched so the toggle
      // reflects the server's actual state.
    } finally {
      this._optToggleBusy = false;
    }
  }

  /** Appliance types the user can pause independently — the ones the
   * apply loop actually controls. Solar (forecast-only) and dehumidifier
   * (data-collection-only) have nothing to pause. */
  private _isControllableType(type: ApplianceType): boolean {
    return (
      type === 'hvac' ||
      type === 'ev_charger' ||
      type === 'home_battery' ||
      type === 'water_heater' ||
      type === 'robot'
    );
  }

  /** This device's OWN optimization flag (independent of the master
   * switch). HVAC keeps it on its appliance_preferences row; every other
   * controllable type keeps it on the appliance row itself. Missing
   * either place means enabled. */
  private _deviceOptimizationEnabled(appliance: ApplianceScheduleEntry): boolean {
    if (appliance.appliance_type === 'hvac') {
      return this._appliancePrefsById[appliance.appliance_id]?.optimization_enabled !== false;
    }
    return this._appliancesById[appliance.appliance_id]?.optimization_enabled !== false;
  }

  private async _toggleDeviceOptimization(
    appliance: ApplianceScheduleEntry,
  ): Promise<void> {
    const id = appliance.appliance_id;
    if (this._deviceOptToggleBusy[id]) return;
    const next = !this._deviceOptimizationEnabled(appliance);
    this._deviceOptToggleBusy = { ...this._deviceOptToggleBusy, [id]: true };
    try {
      if (appliance.appliance_type === 'hvac') {
        // HVAC pause lives on the per-appliance preferences row — the
        // same field the constraint editor's "Pause this unit" writes,
        // so the two stay in sync.
        const prefs = await updateAppliancePreferences(id, {
          optimization_enabled: next,
        });
        this._appliancePrefsById = { ...this._appliancePrefsById, [id]: prefs };
        this._persistAppliancePrefs();
      } else {
        // Non-HVAC pause lives on the appliance row (migration 038).
        const updated = await updateAppliance(id, { optimization_enabled: next });
        this._appliancesById = { ...this._appliancesById, [id]: updated };
      }
      // Reflect the new effective state on the chart/badges without a
      // full reload — the recompute round-trip returns fresh schedules
      // whose per-appliance optimization_enabled is the ANDed value.
      void this._recomputeNow();
    } catch {
      // PUT failed — leave caches untouched so the toggle snaps back to
      // the server's actual state on the next render.
    } finally {
      const nextBusy = { ...this._deviceOptToggleBusy };
      delete nextBusy[id];
      this._deviceOptToggleBusy = nextBusy;
    }
  }

  /** Compact per-device optimization toggle rendered in each controllable
   * card's header. Independent of the master switch; when the master is
   * paused the card shows this device's own intended state (what it will
   * do once the master is re-enabled), and the global paused banner
   * explains that everything is currently held. */
  private _renderDeviceOptimizationToggle(
    appliance: ApplianceScheduleEntry,
  ): TemplateResult {
    if (!this._isControllableType(appliance.appliance_type)) return html``;
    // "Not Connected" example cards reuse this renderer with a synthetic
    // id — there's no real appliance to pause, so no toggle.
    if (appliance.appliance_id.startsWith('__example_')) return html``;
    const enabled = this._deviceOptimizationEnabled(appliance);
    const busy = !!this._deviceOptToggleBusy[appliance.appliance_id];
    return html`
      <button
        class="device-opt-toggle ${enabled ? '' : 'paused'}"
        type="button"
        role="switch"
        aria-checked=${enabled ? 'true' : 'false'}
        ?disabled=${busy}
        title=${enabled
          ? 'Pause optimization for this device'
          : 'Resume optimization for this device'}
        @click=${() => this._toggleDeviceOptimization(appliance)}
      >
        <span class="opt-dot"></span>
        ${enabled ? 'On' : 'Paused'}
      </button>
    `;
  }

  private _renderCalibrationBanners(): TemplateResult {
    const map = this._calibrationByAppliance ?? {};
    const banners: TemplateResult[] = [];
    for (const [applianceId, status] of Object.entries(map)) {
      const banner = this._renderCalibrationBanner(applianceId, status);
      if (banner) banners.push(banner);
    }
    if (banners.length === 0) return html``;
    return html`<div class="calibration-banners">${banners}</div>`;
  }

  private _renderCalibrationBanner(
    applianceId: string,
    status: CalibrationStatusResponse,
  ): TemplateResult | null {
    const appliance = this._appliancesById[applianceId];
    if (!appliance) return null;
    const name = appliance.name || 'your AC';

    // In-progress: show "scheduled" or "running" message + Skip button.
    if (status.is_in_progress) {
      const run = status.latest_run;
      const dateLabel = run?.schedule_date
        ? new Date(run.schedule_date + 'T00:00:00').toLocaleDateString(undefined, {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
          })
        : 'the next warm day';
      return html`
        <div class="banner calibration in-progress" role="status">
          <div class="banner-text">
            <strong>Calibrating ${name}</strong>
            <span>
              ${run?.status === 'in_progress'
                ? `Running a 6-hour test on ${dateLabel} (09:00–15:00 local) to measure how this AC actually cools your space.`
                : `Scheduled for ${dateLabel} during the next warm day.`}
            </span>
          </div>
          ${status.can_skip
            ? html`<button
                class="banner-skip"
                type="button"
                ?disabled=${this._calibrationSkipping}
                @click=${() => this._onCalibrationSkip(applianceId)}
              >
                ${this._calibrationSkipping ? 'Skipping…' : 'Skip'}
              </button>`
            : null}
        </div>
      `;
    }

    // Completed: show a small confirmation with the measured rates.
    if (status.is_complete && status.latest_run?.status === 'completed') {
      const run = status.latest_run;
      const rates = run.derived_rates;
      if (!rates) return null;
      const low = rates.cooling_effect_cool_low;
      const high = rates.cooling_effect_cool_high;
      if (low === null || high === null) return null;
      // Hide if the user dismissed this run, or it finished long enough
      // ago that the confirmation is no longer interesting.
      if (run.id !== null && this._dismissedCalibrations.has(run.id)) return null;
      if (_calibrationExpired(run.completed_at)) return null;
      // °F/slot → °F/hr for display.
      const lowHr = (low * 2).toFixed(1);
      const highHr = (high * 2).toFixed(1);
      return html`
        <div class="banner calibration complete" role="status">
          <div class="banner-text">
            <strong>${name} calibration done</strong>
            <span>
              Measured cooling: ${lowHr} °F/hr on Low fan,
              ${highHr} °F/hr on High fan.
            </span>
          </div>
          ${run.id !== null
            ? html`<button
                class="banner-dismiss"
                type="button"
                aria-label="Dismiss"
                title="Dismiss"
                @click=${() => this._onCalibrationDismiss(run.id as number)}
              >
                ✕
              </button>`
            : null}
        </div>
      `;
    }

    return null;
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

    if (type === 'dehumidifier') {
      return this._renderDehumidifierCard(appliance, label);
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
    //   EV / battery / robot → handled by the chart's `'percent'` mode (0–100)
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
      // THIS appliance's saved comfort band wins over whatever the
      // nightly job happened to bake into this row, so live edits don't
      // wait until tomorrow's run to show up on the chart. Bands live on
      // appliance_preferences (migration 027) — the user-level row is
      // only a seed default and must NOT paint over every HVAC card, or
      // two machines with different bands look identical (US-MHVAC).
      const prefs = this._appliancePrefsById[appliance.appliance_id];
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
    } else if (type === 'ev_charger' || type === 'home_battery' || type === 'robot') {
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

    // Per-HVAC entity label so multi-HVAC users can tell which card
    // controls which climate entity (US-MHVAC-015). Falls back to no
    // line when the appliance has no config / entity bound (e.g. an
    // older registration or a non-HVAC type).
    const fullForEntity = this._appliancesById[appliance.appliance_id];
    const boundEntityId =
      type === 'hvac' && fullForEntity
        ? (((fullForEntity.config ?? {}) as Record<string, unknown>)['entity_id'] as
            | string
            | undefined)
        : undefined;
    return html`
      <div class="card" data-appliance-type=${type}>
        <div class="card-head">
          <span class="badge" aria-hidden="true">${label}</span>
          <span class="name">${appliance.name}</span>
          ${this._renderDeviceOptimizationToggle(appliance)}
        </div>
        <div class="entity-binding" ?hidden=${!boundEntityId}>${boundEntityId ?? ''}</div>
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

  /**
   * Compact informational tile for a dehumidifier.
   *
   * Data-collection only (v1) — there's no schedule to render and no
   * constraints to edit; Hungry Machines just records the device's
   * temp / humidity / power / on-off state. The tile confirms it's
   * registered and being observed, and offers Edit-appliance (to fix the
   * entity/sensor bindings) + Delete. No "Edit constraints" button.
   */
  private _renderDehumidifierCard(
    appliance: ApplianceScheduleEntry,
    label: string,
  ): TemplateResult {
    const fullAppliance = this._appliancesById[appliance.appliance_id];
    const config = (fullAppliance?.config ?? {}) as Record<string, unknown>;
    const boundEntityId =
      typeof config['entity_id'] === 'string' ? (config['entity_id'] as string) : '';
    return html`
      <div class="card" data-appliance-type="dehumidifier">
        <div class="card-head">
          <span class="badge" aria-hidden="true">${label}</span>
          <span class="name">${appliance.name}</span>
        </div>
        <div class="entity-binding" ?hidden=${!boundEntityId}>${boundEntityId}</div>
        <div class="savings">Recording data</div>
        <p style="margin: 8px 0 0; color: var(--hm-muted, #64748B); font-size: 14px;">
          Hungry Machines is recording this dehumidifier's temperature, humidity,
          power, and on/off state to study its effect on the room. It isn't
          scheduled or controlled yet.
        </p>
        <div class="card-actions">
          <button
            class="edit-btn secondary"
            type="button"
            @click=${() => this._openEditAppliance(appliance.appliance_id)}
            title="Edit the dehumidifier entity and sensors"
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

  private _onFeedbackCategoryChange(value: string): void {
    this._feedbackCategory = value as FeedbackCategory;
  }

  private _onFeedbackMessageInput(value: string): void {
    this._feedbackMessage = value;
    if (this._feedbackError) this._feedbackError = null;
    if (this._feedbackSent) this._feedbackSent = false;
  }

  private async _submitFeedback(): Promise<void> {
    const message = this._feedbackMessage.trim();
    if (!message) {
      this._feedbackError = 'Please enter some feedback before sending.';
      return;
    }
    this._feedbackSubmitting = true;
    this._feedbackError = null;
    try {
      await feedbackApi.submit({ message, category: this._feedbackCategory });
      this._feedbackMessage = '';
      this._feedbackCategory = 'comment';
      this._feedbackSent = true;
      if (this._feedbackSentTimer !== null) {
        clearTimeout(this._feedbackSentTimer);
      }
      this._feedbackSentTimer = setTimeout(() => {
        this._feedbackSent = false;
        this._feedbackSentTimer = null;
      }, 4000);
    } catch (err) {
      this._feedbackError =
        err instanceof Error && err.message
          ? err.message
          : 'Could not send feedback. Please try again.';
    } finally {
      this._feedbackSubmitting = false;
    }
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
    const pricingSourceDraft = this._pricingSourceDraft;
    const availableDynamicZones = rates?.available_dynamic_zones ?? [];
    const availableZones = rates?.available_pricing_zones ?? [];
    const availableDeliveryTariffs = rates?.available_delivery_tariffs ?? [];
    // Fallback: if rates haven't loaded yet, render just the current
    // selection so the dropdown isn't empty.
    const zoneOptionIds: number[] = availableZones.length > 0
      ? availableZones.map((z) => z.id)
      : [pricing];
    const pricingDirty = this._isPricingDirty();
    const pricingSaving = this._pricingSaving;
    const pricingError = this._pricingError;
    const pricingSavedFlash = this._pricingSavedFlash;
    const dynamicActive = pricingSourceDraft === 'dynamic';
    const summaryText = !rates
      ? ratesLoading
        ? 'Loading rates…'
        : ratesError ?? 'Rates unavailable'
      : dynamicActive
        ? 'Currently using: day-ahead pricing'
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
          ${this._zoneError
            ? html`<span class="zone-error" role="alert">${this._zoneError}</span>`
            : null}
        </div>

        <div class="settings-section" data-section="pricing-source">
          <h3>Pricing source</h3>
          <p class="rates-summary">${summaryText}</p>
          <label>
            <span class="label-text">Source</span>
            <select
              name="pricing_source"
              ?disabled=${!rates || pricingSaving}
              .value=${pricingSourceDraft}
              @change=${(e: Event) =>
                this._onPricingSourceChange(
                  (e.target as HTMLSelectElement).value,
                )}
            >
              <option value="zone" ?selected=${pricingSourceDraft === 'zone'}>Zone</option>
              <option value="custom" ?selected=${pricingSourceDraft === 'custom'}>Custom</option>
              <option value="dynamic" ?selected=${pricingSourceDraft === 'dynamic'}>
                Dynamic (day-ahead pricing)
              </option>
            </select>
          </label>
          <div class="zone-fields" ?hidden=${pricingSourceDraft !== 'zone'}>
            <p class="hint">
              Your utility's published time-of-use plan. Prices are fixed by
              the tariff and don't change day to day.
            </p>
            <label>
              <span class="label-text">Zone</span>
              <select
                name="pricing_zone"
                ?disabled=${pricingSaving}
                .value=${String(pricing)}
                @change=${(e: Event) =>
                  this._onZoneChange(Number((e.target as HTMLSelectElement).value))}
              >
                ${availableZones.length > 0
                  ? groupPricingZones(availableZones).map(
                      (group) => html`<optgroup label=${group.key}>
                        ${group.zones.map(
                          (z) => html`<option
                            value=${String(z.id)}
                            ?selected=${z.id === pricing}
                          >
                            ${z.plan}
                          </option>`,
                        )}
                      </optgroup>`,
                    )
                  : zoneOptionIds.map(
                      (z) => html`<option value=${String(z)} ?selected=${z === pricing}>
                        ${pricingZoneOptionLabel(z, availableZones)}
                      </option>`,
                    )}
              </select>
            </label>
            <p class="zone-hint">${pricingZoneFullLabel(pricing, availableZones)}</p>
          </div>
          <div class="dynamic-fields" ?hidden=${pricingSourceDraft !== 'dynamic'}>
            <p class="hint">
              Dynamic prices update daily from the wholesale day-ahead market
              (PJM, CAISO, or NYISO depending on your region). The delivery
              charge estimate covers delivery, taxes, and supplier fees on top
              of the hourly wholesale price.
            </p>
            <label>
              <span class="label-text">Region</span>
              <select
                name="dynamic_zone"
                ?disabled=${pricingSaving}
                .value=${this._dynamicZoneDraft}
                @change=${(e: Event) =>
                  this._onDynamicZoneChange(
                    (e.target as HTMLSelectElement).value,
                  )}
              >
                ${availableDynamicZones.map(
                  (z) => html`<option value=${z.slug} ?selected=${z.slug === this._dynamicZoneDraft}>
                    ${z.label}
                  </option>`,
                )}
              </select>
            </label>
            ${availableDeliveryTariffs.length > 0
              ? html`
                  <label>
                    <span class="label-text">Delivery plan</span>
                    <select
                      name="adder_grid_ruleset_id"
                      ?disabled=${pricingSaving}
                      .value=${this._deliveryTariffDraft}
                      @change=${(e: Event) =>
                        this._onDeliveryTariffChange(
                          (e.target as HTMLSelectElement).value,
                        )}
                    >
                      <option value="" ?selected=${this._deliveryTariffDraft === ''}>
                        Flat estimate
                      </option>
                      ${availableDeliveryTariffs.map(
                        (t) => html`<option
                          value=${String(t.id)}
                          ?selected=${String(t.id) === this._deliveryTariffDraft}
                        >
                          ${t.utility} ${t.plan_name}
                        </option>`,
                      )}
                    </select>
                  </label>
                  <p class="hint">
                    With a delivery plan chosen, the estimate below covers
                    only non-delivery extras — taxes and supply riders.
                    About 2¢/kWh is typical.
                  </p>
                `
              : null}
            ${this._deliveryTariffDraft !== ''
              ? html`
                  <div class="delivery-tod-fields">
                    <p class="hint">
                      Prefilled from your class's published rate. Check
                      these against the Distribution Facility Charge lines
                      on your own bill and edit any that differ.
                    </p>
                    ${DELIVERY_TOD_PERIODS.map(
                      (p) => html`
                        <label>
                          <span class="label-text">${DELIVERY_TOD_LABELS[p]}</span>
                          <input
                            type="number"
                            step="0.001"
                            min="0"
                            max="50"
                            name=${`delivery_tod_${p}`}
                            class="pricing-adder-input"
                            ?disabled=${pricingSaving}
                            .value=${this._deliveryTodDraft[p]}
                            @input=${(e: Event) =>
                              this._onDeliveryTodInput(
                                p,
                                (e.target as HTMLInputElement).value,
                              )}
                          />
                        </label>
                      `,
                    )}
                  </div>
                `
              : null}
            <label>
              <span class="label-text">Delivery charge estimate (cents/kWh)</span>
              <input
                type="number"
                step="0.1"
                min="0"
                max="50"
                name="pricing_adder_cents_per_kwh"
                class="pricing-adder-input"
                ?disabled=${pricingSaving}
                .value=${this._pricingAdderDraft}
                @input=${(e: Event) =>
                  this._onPricingAdderInput(
                    (e.target as HTMLInputElement).value,
                  )}
              />
            </label>
          </div>
          <div class="custom-fields" ?hidden=${pricingSourceDraft !== 'custom'}>
            <p class="hint">
              Enter your own 24-hour rate profile — useful when your plan isn't
              in the list. Values are in dollars per kWh.
            </p>
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
          <p
            class="rates-api-error"
            role="alert"
            ?hidden=${!pricingError}
          >
            ${pricingError ?? ''}
          </p>
          <div class="rates-actions">
            <button
              type="button"
              name="save_pricing_source"
              class="primary"
              ?disabled=${!rates || pricingSaving || !pricingDirty}
              @click=${() => void this._savePricingSource()}
            >
              Save
            </button>
            <button
              type="button"
              name="reset_pricing_source"
              ?disabled=${!rates || pricingSaving || !pricingDirty}
              @click=${() => this._resetPricingDraft()}
            >
              Reset
            </button>
            <span class="saved-flash" role="status" ?hidden=${!pricingSavedFlash}>
              Saved
            </span>
          </div>
        </div>

        <div class="settings-section" data-section="feedback">
          <h3>Send feedback</h3>
          <p class="hint">
            Found a bug, have an idea, or just want to tell us how it's going?
            Your note goes straight to the Hungry Machines team.
          </p>
          <label>
            <span class="label-text">Type</span>
            <select
              name="feedback_category"
              ?disabled=${this._feedbackSubmitting}
              .value=${this._feedbackCategory}
              @change=${(e: Event) =>
                this._onFeedbackCategoryChange(
                  (e.target as HTMLSelectElement).value,
                )}
            >
              <option value="comment" ?selected=${this._feedbackCategory === 'comment'}>General comment</option>
              <option value="bug" ?selected=${this._feedbackCategory === 'bug'}>Problem / bug</option>
              <option value="idea" ?selected=${this._feedbackCategory === 'idea'}>Idea / improvement</option>
              <option value="other" ?selected=${this._feedbackCategory === 'other'}>Other</option>
            </select>
          </label>
          <label>
            <span class="label-text">Your feedback</span>
            <textarea
              name="feedback_message"
              class="feedback-message"
              rows="4"
              maxlength="5000"
              placeholder="Tell us what's on your mind…"
              ?disabled=${this._feedbackSubmitting}
              .value=${this._feedbackMessage}
              @input=${(e: Event) =>
                this._onFeedbackMessageInput(
                  (e.target as HTMLTextAreaElement).value,
                )}
            ></textarea>
          </label>
          <p class="zone-error" role="alert" ?hidden=${!this._feedbackError}>
            ${this._feedbackError ?? ''}
          </p>
          <div class="settings-actions">
            <button
              type="button"
              name="send_feedback"
              class="save-btn"
              ?disabled=${this._feedbackSubmitting || this._feedbackMessage.trim() === ''}
              @click=${() => void this._submitFeedback()}
            >
              ${this._feedbackSubmitting ? 'Sending…' : 'Send feedback'}
            </button>
            <span class="saved-flash" role="status" ?hidden=${!this._feedbackSent}>
              Thanks — sent!
            </span>
          </div>
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
