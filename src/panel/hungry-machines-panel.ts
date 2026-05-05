import { LitElement, html, css, type TemplateResult } from 'lit';
import {
  authStore,
  getEntityMap,
  setEntityMap,
  type AuthState,
  type EntityMap,
} from '../store.js';
import {
  getAllSchedules,
  type ApplianceScheduleEntry,
  type SchedulesResponse,
} from '../api/schedules.js';
import {
  get as getRates,
  update as updateRates,
  type RatesResponse,
} from '../api/rates.js';
import { list as listAppliances, type Appliance, type ApplianceType } from '../api/appliances.js';
import { patchMe } from '../api/auth.js';
import { get as getPreferences, type Preferences } from '../api/preferences.js';
import { expandHourlyTo48, hasCustomRates, hasHourlyComfortBands } from '../utils/hourly.js';

type EntityField = 'climate' | 'weather';

type HassStateLike = { entity_id?: string; state?: unknown; attributes?: Record<string, unknown> };
type HassLike = { states?: Record<string, HassStateLike> };

const ENTITY_FIELDS: Array<{ key: EntityField; label: string; domain: 'climate' | 'weather' }> = [
  { key: 'climate', label: 'HVAC climate entity', domain: 'climate' },
  { key: 'weather', label: 'Weather', domain: 'weather' },
];

const PRICING_ZONES = [1, 2, 3, 4, 5, 6, 7, 8] as const;

type View = 'dashboard' | 'settings';

const TYPE_LABELS: Record<ApplianceType, string> = {
  hvac: 'HVAC',
  ev_charger: 'EV',
  home_battery: 'Battery',
  water_heater: 'Water',
};

function asNumberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((v) => typeof v === 'number') ? (value as number[]) : undefined;
}

function asBooleanArray(value: unknown): boolean[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((v) => typeof v === 'boolean') ? (value as boolean[]) : undefined;
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
    .cards {
      display: grid;
      gap: 16px;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    }
    .card {
      background: #ffffff;
      border: 1px solid rgba(100, 116, 139, 0.2);
      border-radius: 10px;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .card-head {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .card-head .badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 34px;
      height: 34px;
      border-radius: 8px;
      background: var(--hm-primary, #1E3A8A);
      color: #ffffff;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.02em;
      flex-shrink: 0;
    }
    .card-head .name {
      font-weight: 600;
      color: var(--hm-text, #0F172A);
      font-size: 1rem;
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .card .savings {
      color: var(--hm-secondary, #0F766E);
      font-weight: 600;
      font-size: 0.95rem;
    }
    .card .edit-btn {
      align-self: flex-start;
      background: transparent;
      border: 1px solid var(--hm-primary, #1E3A8A);
      color: var(--hm-primary, #1E3A8A);
      padding: 6px 12px;
      border-radius: 6px;
      font: inherit;
      font-size: 13px;
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
    _entityMap: { state: true },
    _zoneSaving: { state: true },
    _zoneError: { state: true },
    _ratesLoading: { state: true },
    _ratesError: { state: true },
    _customRatesEditorOpen: { state: true },
    _customRatesInputs: { state: true },
    _customRatesSaving: { state: true },
    _customRatesSaveError: { state: true },
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
  _entityMap: EntityMap = {};
  _zoneSaving = false;
  _zoneError: string | null = null;
  _ratesLoading = false;
  _ratesError: string | null = null;
  _customRatesEditorOpen = false;
  _customRatesInputs: string[] = Array.from({ length: 24 }, () => '');
  _customRatesSaving = false;
  _customRatesSaveError: string | null = null;

  private _unsubscribe: (() => void) | null = null;
  private _schedulesFetched = false;
  private _ratesInflight = false;
  private _appliancesById: Record<string, Appliance> = {};

  override connectedCallback(): void {
    super.connectedCallback();
    this._auth = authStore.state;
    this._entityMap = getEntityMap();
    this._unsubscribe = authStore.subscribe((s) => {
      const prevStatus = this._auth.status;
      this._auth = s;
      if (prevStatus !== 'authed' && s.status === 'authed') {
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

  private _onEntityChange(field: EntityField, entityId: string): void {
    const next: EntityMap = { ...this._entityMap };
    if (entityId) {
      next[field] = entityId;
    } else {
      delete next[field];
    }
    this._entityMap = next;
    setEntityMap(next);
  }

  private async _onZoneChange(zone: number): Promise<void> {
    const user = this._auth.user;
    if (!user || user.pricing_location === zone) return;
    this._zoneSaving = true;
    this._zoneError = null;
    try {
      const updated = await patchMe({ pricing_location: zone });
      authStore.patchUser({ pricing_location: updated.pricing_location });
    } catch (err) {
      this._zoneError =
        err instanceof Error && err.message ? err.message : 'Could not update pricing zone';
    } finally {
      this._zoneSaving = false;
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
    const config = (appliance?.config ?? {}) as Record<string, unknown>;
    this._editorApplianceId = applianceId;
    this._editorApplianceType = type;
    this._editorConstraints = config;
    this._editorOpen = true;
  }

  private _onEditorClosed(): void {
    this._editorOpen = false;
  }

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
        @constraints-saved=${() => this._onEditorClosed()}
        @constraints-cancelled=${() => this._onEditorClosed()}
      ></hm-constraint-editor>
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
    if (appliances.length === 0) {
      return html`
        <h2>Dashboard</h2>
        <div class="empty">
          <p>No appliances registered yet. Add one to start optimizing.</p>
          <button class="add-btn" type="button">Add appliance</button>
        </div>
      `;
    }

    const rates = this._rates?.rates_cents_per_kwh ?? [];
    return html`
      <h2>Dashboard</h2>
      <div class="cards">
        ${appliances.map((a) => this._renderApplianceCard(a, rates))}
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

    let highTemps: number[] | undefined;
    let lowTemps: number[] | undefined;
    let comfortHighs: number[] | undefined;
    let comfortLows: number[] | undefined;
    let booleanSchedule: boolean[] | undefined;
    let trajectory: number[] | undefined;
    let unit: string | undefined;

    if (type === 'hvac') {
      highTemps = asNumberArray((schedule as Record<string, unknown>)['high_temps']);
      lowTemps = asNumberArray((schedule as Record<string, unknown>)['low_temps']);
      const prefs = this._preferences;
      if (prefs && hasHourlyComfortBands(prefs)) {
        comfortHighs = expandHourlyTo48(prefs.hourly_high_temps_f as number[]);
        comfortLows = expandHourlyTo48(prefs.hourly_low_temps_f as number[]);
      }
    } else if (type === 'ev_charger' || type === 'home_battery') {
      booleanSchedule = asBooleanArray(
        (schedule as Record<string, unknown>)['intervals'],
      );
      trajectory = asNumberArray(
        (schedule as Record<string, unknown>)['value_trajectory'],
      );
      const rawUnit = (schedule as Record<string, unknown>)['unit'];
      unit = typeof rawUnit === 'string' ? rawUnit : 'percent';
    } else if (type === 'water_heater') {
      booleanSchedule = asBooleanArray(
        (schedule as Record<string, unknown>)['intervals'],
      );
      trajectory = asNumberArray(
        (schedule as Record<string, unknown>)['temp_trajectory'],
      );
      const rawUnit = (schedule as Record<string, unknown>)['unit'];
      unit = typeof rawUnit === 'string' ? rawUnit : 'fahrenheit';
    }

    return html`
      <div class="card" data-appliance-type=${type}>
        <div class="card-head">
          <span class="badge" aria-hidden="true">${label}</span>
          <span class="name">${appliance.name}</span>
        </div>
        <div class="savings">${savings}</div>
        <hm-schedule-chart
          .rates=${rates}
          .highTemps=${highTemps}
          .lowTemps=${lowTemps}
          .comfortHighs=${comfortHighs}
          .comfortLows=${comfortLows}
          .booleanSchedule=${booleanSchedule}
          .trajectory=${trajectory}
          .unit=${unit}
        ></hm-schedule-chart>
        ${comfortHighs && comfortLows
          ? html`
              <div class="comfort-legend">
                <span class="comfort-legend-swatch" aria-hidden="true"></span>
                <span class="comfort-legend-label">Your comfort range</span>
              </div>
            `
          : null}
        <button
          class="edit-btn"
          type="button"
          @click=${() => this._openEditor(appliance.appliance_id, type)}
        >
          Edit constraints
        </button>
      </div>
    `;
  }

  private _renderSettings(): TemplateResult {
    const hass = this.hass as HassLike | undefined;
    const states = hass && typeof hass === 'object' ? hass.states : undefined;
    const hasHass = !!states;
    const allEntities = states ? Object.keys(states).sort() : [];
    const climateEntities = allEntities.filter((id) => id.startsWith('climate.'));
    const weatherEntities = allEntities.filter((id) => id.startsWith('weather.'));
    const map = this._entityMap;
    const user = this._auth.user;
    const email = user?.email ?? '';
    const pricing = user?.pricing_location ?? 1;

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
          <h3>Home Assistant entities</h3>
          ${hasHass
            ? html`<p class="hint">
                Pick which Home Assistant entities feed the Hungry Machines cards.
              </p>`
            : html`<p class="hint">
                Entity mapping is only available inside Home Assistant.
              </p>`}
          ${ENTITY_FIELDS.map((f) => {
            const options = f.domain === 'climate' ? climateEntities : weatherEntities;
            const selected = map[f.key] ?? '';
            return html`
              <label>
                <span class="label-text">${f.label}</span>
                <select
                  name=${`entity_${f.key}`}
                  data-field=${f.key}
                  ?disabled=${!hasHass}
                  .value=${selected}
                  @change=${(e: Event) =>
                    this._onEntityChange(
                      f.key,
                      (e.target as HTMLSelectElement).value,
                    )}
                >
                  <option value="">— not set —</option>
                  ${options.map(
                    (id) => html`<option value=${id}>${id}</option>`,
                  )}
                </select>
              </label>
            `;
          })}
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
                (z) => html`<option value=${String(z)}>Zone ${z}</option>`,
              )}
            </select>
          </label>
          ${this._zoneError
            ? html`<p class="zone-error" role="alert">${this._zoneError}</p>`
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
