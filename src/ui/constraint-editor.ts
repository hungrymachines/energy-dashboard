import { LitElement, html, css } from 'lit';
import { setConstraints } from '../api/appliances.js';
import { update as updatePreferences } from '../api/preferences.js';
import type { ApplianceType } from '../api/appliances.js';
import { hasHourlyComfortBands } from '../utils/hourly.js';

type OptimizationMode = 'cool' | 'heat' | 'auto' | 'off';

const OPTIMIZATION_MODES: ReadonlyArray<OptimizationMode> = ['cool', 'heat', 'auto', 'off'];

type ErrorMap = Record<string, string>;

const TIME_PATTERN = /^\d{2}:\d{2}$/;

function toNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function toString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export class HmConstraintEditor extends LitElement {
  static override styles = css`
    :host {
      display: contents;
      font-family: var(--hm-font-body, sans-serif);
      color: var(--hm-text, #0F172A);
    }
    .overlay {
      position: fixed;
      inset: 0;
      background: rgba(15, 23, 42, 0.55);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      z-index: 1000;
    }
    .panel {
      background: #ffffff;
      border-radius: 12px;
      padding: 24px;
      width: 100%;
      max-width: 420px;
      box-sizing: border-box;
      box-shadow: 0 14px 40px rgba(15, 23, 42, 0.35);
      display: flex;
      flex-direction: column;
      gap: 12px;
      max-height: calc(100vh - 48px);
      overflow-y: auto;
    }
    h2 {
      margin: 0;
      font-family: var(--hm-font-heading, serif);
      color: var(--hm-primary, #1E3A8A);
      font-size: 1.15rem;
    }
    label {
      display: block;
      font-size: 14px;
    }
    .label-text {
      display: block;
      margin-bottom: 4px;
      color: var(--hm-text, #0F172A);
    }
    input,
    select {
      width: 100%;
      padding: 8px 10px;
      border: 1px solid var(--hm-muted, #64748B);
      border-radius: 6px;
      font: inherit;
      background: var(--hm-bg, #F8FAFC);
      color: var(--hm-text, #0F172A);
      box-sizing: border-box;
    }
    input:focus,
    select:focus {
      outline: 2px solid var(--hm-primary, #1E3A8A);
      outline-offset: 1px;
    }
    .field-error {
      color: var(--hm-error, #DC2626);
      font-size: 12px;
      margin-top: 4px;
    }
    .top-error {
      background: #ffffff;
      color: var(--hm-error, #DC2626);
      border: 1px solid var(--hm-error, #DC2626);
      border-radius: 6px;
      padding: 8px 10px;
      font-size: 14px;
    }
    .slider-row {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .slider-row input[type='range'] {
      flex: 1;
    }
    .slider-value {
      width: 28px;
      text-align: center;
      font-weight: 600;
      color: var(--hm-primary, #1E3A8A);
    }
    .actions {
      display: flex;
      gap: 10px;
      justify-content: flex-end;
      margin-top: 4px;
    }
    button {
      font: inherit;
      padding: 8px 16px;
      border-radius: 6px;
      cursor: pointer;
    }
    button.cancel {
      background: transparent;
      border: 1px solid var(--hm-muted, #64748B);
      color: var(--hm-text, #0F172A);
    }
    button.save {
      background: var(--hm-primary, #1E3A8A);
      color: #ffffff;
      border: none;
      font-weight: 600;
    }
    button.save[disabled] {
      opacity: 0.55;
      cursor: not-allowed;
    }
    .hourly-bands {
      border-top: 1px solid var(--hm-muted, #64748B);
      padding-top: 10px;
      margin-top: 4px;
    }
    button.hourly-toggle {
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: transparent;
      border: none;
      padding: 4px 0;
      font: inherit;
      font-weight: 600;
      color: var(--hm-text, #0F172A);
      cursor: pointer;
    }
    button.hourly-toggle .chevron {
      display: inline-block;
      transition: transform 0.15s ease;
    }
    button.hourly-toggle.open .chevron {
      transform: rotate(90deg);
    }
    .hourly-content {
      margin-top: 8px;
    }
    .hourly-checkbox {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      font-size: 13px;
      margin-bottom: 8px;
    }
    .hourly-checkbox input {
      width: auto;
      margin-top: 3px;
    }
    table.hourly-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    table.hourly-table th,
    table.hourly-table td {
      padding: 4px 6px;
      text-align: left;
    }
    table.hourly-table th {
      font-weight: 600;
      color: var(--hm-muted, #64748B);
    }
    table.hourly-table input[type='number'] {
      padding: 4px 6px;
      font-size: 13px;
    }
    table.hourly-table.disabled {
      opacity: 0.45;
    }
    table.hourly-table input.invalid {
      border-color: var(--hm-error, #DC2626);
    }
    .hourly-row-error {
      color: var(--hm-error, #DC2626);
      font-size: 12px;
    }
  `;

  static override properties = {
    applianceId: { attribute: false },
    applianceType: { attribute: false },
    currentConstraints: { attribute: false },
    open: { type: Boolean, reflect: true },
    _values: { state: true },
    _errors: { state: true },
    _topError: { state: true },
    _saving: { state: true },
    _hourlyOpen: { state: true },
    _hourlyEnabled: { state: true },
    _hourlyLow: { state: true },
    _hourlyHigh: { state: true },
  };

  applianceId = '';
  applianceType: ApplianceType = 'hvac';
  currentConstraints: Record<string, unknown> | undefined = undefined;
  open = false;
  _values: Record<string, string> = {};
  _errors: ErrorMap = {};
  _topError: string | null = null;
  _saving = false;
  _hourlyOpen = false;
  _hourlyEnabled = false;
  _hourlyLow: string[] = [];
  _hourlyHigh: string[] = [];

  private _lastKey = '';

  override willUpdate(changed: Map<string, unknown>): void {
    const key = `${this.applianceType}|${this.applianceId}|${this.open ? '1' : '0'}`;
    const shouldReset =
      changed.has('open') ||
      changed.has('applianceId') ||
      changed.has('applianceType') ||
      changed.has('currentConstraints');
    if (shouldReset && key !== this._lastKey) {
      this._lastKey = key;
      this._values = this._seedValues();
      this._errors = {};
      this._topError = null;
      this._saving = false;
      this._seedHourlyBands();
    }
  }

  private _seedHourlyBands(): void {
    const c = this.currentConstraints ?? {};
    const high = (c as Record<string, unknown>)['hourly_high_temps_f'];
    const low = (c as Record<string, unknown>)['hourly_low_temps_f'];
    const isFiniteNumberArray = (v: unknown): v is number[] =>
      Array.isArray(v) && v.every((n) => typeof n === 'number' && Number.isFinite(n));
    const prefsLike = {
      hourly_high_temps_f: isFiniteNumberArray(high) ? high : undefined,
      hourly_low_temps_f: isFiniteNumberArray(low) ? low : undefined,
    };
    if (hasHourlyComfortBands(prefsLike)) {
      this._hourlyEnabled = true;
      this._hourlyOpen = true;
      this._hourlyHigh = (prefsLike.hourly_high_temps_f as number[]).map((n) => String(n));
      this._hourlyLow = (prefsLike.hourly_low_temps_f as number[]).map((n) => String(n));
    } else {
      this._hourlyEnabled = false;
      this._hourlyOpen = false;
      this._hourlyHigh = Array.from({ length: 24 }, () => '76');
      this._hourlyLow = Array.from({ length: 24 }, () => '68');
    }
  }

  private _seedValues(): Record<string, string> {
    const c = this.currentConstraints ?? {};
    const s = (k: string) => {
      const v = (c as Record<string, unknown>)[k];
      if (v === undefined || v === null) return '';
      return String(v);
    };
    switch (this.applianceType) {
      case 'ev_charger':
        return {
          target_charge_pct: s('target_charge_pct'),
          min_charge_pct: s('min_charge_pct'),
          current_charge_pct: s('current_charge_pct'),
          deadline_time: s('deadline_time'),
        };
      case 'home_battery':
        return {
          target_charge_pct: s('target_charge_pct'),
          min_charge_pct: s('min_charge_pct'),
          deadline_time: s('deadline_time'),
        };
      case 'water_heater':
        return {
          max_temp_f: s('max_temp_f'),
          min_temp_f: s('min_temp_f'),
        };
      case 'hvac':
      default: {
        const base = toNumber((c as Record<string, unknown>)['base_temperature']);
        const savings = toNumber((c as Record<string, unknown>)['savings_level']);
        const mode = toString((c as Record<string, unknown>)['optimization_mode']);
        const timeAway = toString((c as Record<string, unknown>)['time_away']);
        const timeHome = toString((c as Record<string, unknown>)['time_home']);
        return {
          base_temperature: base === null ? '72' : String(base),
          savings_level: savings === null ? '3' : String(savings),
          optimization_mode: (OPTIMIZATION_MODES as ReadonlyArray<string>).includes(mode)
            ? mode
            : 'auto',
          time_away: timeAway,
          time_home: timeHome,
        };
      }
    }
  }

  private _setValue(name: string, value: string): void {
    this._values = { ...this._values, [name]: value };
    // Re-validate on change so the Save button enable/disable tracks live.
    this._errors = this._validate(this._values);
  }

  private _validate(values: Record<string, string>): ErrorMap {
    const errors: ErrorMap = {};
    const reqPct = (name: string) => {
      const raw = values[name] ?? '';
      if (raw === '') {
        errors[name] = 'Required';
        return null;
      }
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        errors[name] = 'Must be 0–100';
        return null;
      }
      return n;
    };
    const reqTemp = (name: string) => {
      const raw = values[name] ?? '';
      if (raw === '') {
        errors[name] = 'Required';
        return null;
      }
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 60 || n > 180) {
        errors[name] = 'Must be 60–180';
        return null;
      }
      return n;
    };
    const reqTime = (name: string) => {
      const raw = values[name] ?? '';
      if (raw === '') {
        errors[name] = 'Required';
        return;
      }
      if (!TIME_PATTERN.test(raw)) {
        errors[name] = 'Use HH:MM';
      }
    };

    switch (this.applianceType) {
      case 'ev_charger': {
        const target = reqPct('target_charge_pct');
        const min = reqPct('min_charge_pct');
        reqPct('current_charge_pct');
        reqTime('deadline_time');
        if (target !== null && min !== null && min >= target) {
          errors['min_charge_pct'] = 'Must be less than target';
        }
        break;
      }
      case 'home_battery': {
        const target = reqPct('target_charge_pct');
        const min = reqPct('min_charge_pct');
        reqTime('deadline_time');
        if (target !== null && min !== null && min >= target) {
          errors['min_charge_pct'] = 'Must be less than target';
        }
        break;
      }
      case 'water_heater': {
        const maxT = reqTemp('max_temp_f');
        const minT = reqTemp('min_temp_f');
        if (maxT !== null && minT !== null && minT >= maxT) {
          errors['min_temp_f'] = 'Must be less than max';
        }
        break;
      }
      case 'hvac': {
        const base = Number(values['base_temperature'] ?? '');
        if (!Number.isFinite(base)) errors['base_temperature'] = 'Required';
        const sv = Number(values['savings_level'] ?? '');
        if (!Number.isFinite(sv) || sv < 1 || sv > 3) {
          errors['savings_level'] = 'Must be 1–3';
        }
        const mode = values['optimization_mode'] ?? '';
        if (!(OPTIMIZATION_MODES as ReadonlyArray<string>).includes(mode)) {
          errors['optimization_mode'] = 'Pick an option';
        }
        const timeAwayRaw = values['time_away'] ?? '';
        if (timeAwayRaw !== '' && !TIME_PATTERN.test(timeAwayRaw)) {
          errors['time_away'] = 'Use HH:MM';
        }
        const timeHomeRaw = values['time_home'] ?? '';
        if (timeHomeRaw !== '' && !TIME_PATTERN.test(timeHomeRaw)) {
          errors['time_home'] = 'Use HH:MM';
        }
        if (this._hourlyEnabled) {
          for (let i = 0; i < 24; i++) {
            const lowRaw = this._hourlyLow[i] ?? '';
            const highRaw = this._hourlyHigh[i] ?? '';
            const low = Number(lowRaw);
            const high = Number(highRaw);
            const lowOk = lowRaw !== '' && Number.isFinite(low) && low >= 50 && low <= 90;
            const highOk = highRaw !== '' && Number.isFinite(high) && high >= 50 && high <= 90;
            if (!lowOk) errors[`hourly_low_${i}`] = 'Must be 50–90';
            if (!highOk) errors[`hourly_high_${i}`] = 'Must be 50–90';
            if (lowOk && highOk && low >= high) {
              errors[`hourly_row_${i}`] = 'High must be greater than low';
            }
          }
        }
        break;
      }
    }
    return errors;
  }

  private _buildPayload(): Record<string, unknown> {
    const v = this._values;
    switch (this.applianceType) {
      case 'ev_charger':
        return {
          target_charge_pct: Number(v['target_charge_pct']),
          min_charge_pct: Number(v['min_charge_pct']),
          current_charge_pct: Number(v['current_charge_pct']),
          deadline_time: v['deadline_time'] ?? '',
        };
      case 'home_battery':
        return {
          target_charge_pct: Number(v['target_charge_pct']),
          min_charge_pct: Number(v['min_charge_pct']),
          deadline_time: v['deadline_time'] ?? '',
        };
      case 'water_heater':
        return {
          max_temp_f: Number(v['max_temp_f']),
          min_temp_f: Number(v['min_temp_f']),
        };
      case 'hvac':
      default: {
        const payload: Record<string, unknown> = {
          base_temperature: Number(v['base_temperature']),
          savings_level: Number(v['savings_level']),
          optimization_mode: (v['optimization_mode'] ?? 'auto') as OptimizationMode,
        };
        const timeAway = v['time_away'] ?? '';
        if (timeAway !== '') payload['time_away'] = timeAway;
        const timeHome = v['time_home'] ?? '';
        if (timeHome !== '') payload['time_home'] = timeHome;
        if (this._hourlyEnabled) {
          payload['hourly_low_temps_f'] = this._hourlyLow.map((s) => Number(s));
          payload['hourly_high_temps_f'] = this._hourlyHigh.map((s) => Number(s));
        } else {
          payload['hourly_low_temps_f'] = null;
          payload['hourly_high_temps_f'] = null;
        }
        return payload;
      }
    }
  }

  private async _onSave(): Promise<void> {
    const errors = this._validate(this._values);
    this._errors = errors;
    if (Object.keys(errors).length > 0) return;

    const payload = this._buildPayload();
    this._saving = true;
    this._topError = null;
    try {
      if (this.applianceType === 'hvac') {
        await updatePreferences(payload);
      } else {
        await setConstraints(this.applianceId, payload);
      }
      this.dispatchEvent(
        new CustomEvent('constraints-saved', {
          detail: { applianceId: this.applianceId, payload },
          bubbles: true,
          composed: true,
        }),
      );
      this.open = false;
    } catch (err) {
      const msg = err instanceof Error && err.message ? err.message : 'Could not save';
      this._topError = msg;
    } finally {
      this._saving = false;
    }
  }

  private _onCancel(): void {
    this.open = false;
    this.dispatchEvent(
      new CustomEvent('constraints-cancelled', { bubbles: true, composed: true }),
    );
  }

  override render() {
    if (!this.open) return null;
    const hasErrors = Object.keys(this._errors).length > 0;
    const type = this.applianceType;
    const v = this._values;
    const errs = this._errors;
    const onNum = (name: string) => (e: Event) =>
      this._setValue(name, (e.target as HTMLInputElement).value);
    const onSel = (name: string) => (e: Event) =>
      this._setValue(name, (e.target as HTMLSelectElement).value);
    const onHourlyLow = (i: number) => (e: Event) => {
      const next = [...this._hourlyLow];
      next[i] = (e.target as HTMLInputElement).value;
      this._hourlyLow = next;
      this._errors = this._validate(this._values);
    };
    const onHourlyHigh = (i: number) => (e: Event) => {
      const next = [...this._hourlyHigh];
      next[i] = (e.target as HTMLInputElement).value;
      this._hourlyHigh = next;
      this._errors = this._validate(this._values);
    };
    const toggleHourlyOpen = () => {
      this._hourlyOpen = !this._hourlyOpen;
    };
    const onHourlyEnabled = (e: Event) => {
      this._hourlyEnabled = (e.target as HTMLInputElement).checked;
      this._errors = this._validate(this._values);
    };
    const fmtHour = (i: number) =>
      `${String(i).padStart(2, '0')}:00`;
    const hasHourlyErrors =
      type === 'hvac' &&
      Object.keys(this._errors).some((k) => k.startsWith('hourly_'));

    const title =
      type === 'ev_charger'
        ? 'EV charger constraints'
        : type === 'home_battery'
          ? 'Battery constraints'
          : type === 'water_heater'
            ? 'Water heater constraints'
            : 'HVAC preferences';

    return html`
      <div class="overlay" role="presentation">
        <div
          class="panel"
          role="dialog"
          aria-modal="true"
          aria-labelledby="hm-ce-title"
        >
          <h2 id="hm-ce-title">${title}</h2>
          ${this._topError
            ? html`<div class="top-error" role="alert">${this._topError}</div>`
            : null}
          ${type === 'ev_charger'
            ? html`
                <label>
                  <span class="label-text">Target charge (%)</span>
                  <input
                    name="target_charge_pct"
                    type="number"
                    min="0"
                    max="100"
                    step="1"
                    .value=${v['target_charge_pct'] ?? ''}
                    @input=${onNum('target_charge_pct')}
                  />
                  ${errs['target_charge_pct']
                    ? html`<div class="field-error">${errs['target_charge_pct']}</div>`
                    : null}
                </label>
                <label>
                  <span class="label-text">Minimum charge (%)</span>
                  <input
                    name="min_charge_pct"
                    type="number"
                    min="0"
                    max="100"
                    step="1"
                    .value=${v['min_charge_pct'] ?? ''}
                    @input=${onNum('min_charge_pct')}
                  />
                  ${errs['min_charge_pct']
                    ? html`<div class="field-error">${errs['min_charge_pct']}</div>`
                    : null}
                </label>
                <label>
                  <span class="label-text">Current charge (%)</span>
                  <input
                    name="current_charge_pct"
                    type="number"
                    min="0"
                    max="100"
                    step="1"
                    .value=${v['current_charge_pct'] ?? ''}
                    @input=${onNum('current_charge_pct')}
                  />
                  ${errs['current_charge_pct']
                    ? html`<div class="field-error">${errs['current_charge_pct']}</div>`
                    : null}
                </label>
                <label>
                  <span class="label-text">Deadline (HH:MM)</span>
                  <input
                    name="deadline_time"
                    type="text"
                    inputmode="numeric"
                    placeholder="08:00"
                    pattern="\\d{2}:\\d{2}"
                    .value=${v['deadline_time'] ?? ''}
                    @input=${onNum('deadline_time')}
                  />
                  ${errs['deadline_time']
                    ? html`<div class="field-error">${errs['deadline_time']}</div>`
                    : null}
                </label>
              `
            : null}
          ${type === 'home_battery'
            ? html`
                <label>
                  <span class="label-text">Target charge (%)</span>
                  <input
                    name="target_charge_pct"
                    type="number"
                    min="0"
                    max="100"
                    step="1"
                    .value=${v['target_charge_pct'] ?? ''}
                    @input=${onNum('target_charge_pct')}
                  />
                  ${errs['target_charge_pct']
                    ? html`<div class="field-error">${errs['target_charge_pct']}</div>`
                    : null}
                </label>
                <label>
                  <span class="label-text">Minimum charge (%)</span>
                  <input
                    name="min_charge_pct"
                    type="number"
                    min="0"
                    max="100"
                    step="1"
                    .value=${v['min_charge_pct'] ?? ''}
                    @input=${onNum('min_charge_pct')}
                  />
                  ${errs['min_charge_pct']
                    ? html`<div class="field-error">${errs['min_charge_pct']}</div>`
                    : null}
                </label>
                <label>
                  <span class="label-text">Deadline (HH:MM)</span>
                  <input
                    name="deadline_time"
                    type="text"
                    inputmode="numeric"
                    placeholder="08:00"
                    pattern="\\d{2}:\\d{2}"
                    .value=${v['deadline_time'] ?? ''}
                    @input=${onNum('deadline_time')}
                  />
                  ${errs['deadline_time']
                    ? html`<div class="field-error">${errs['deadline_time']}</div>`
                    : null}
                </label>
              `
            : null}
          ${type === 'water_heater'
            ? html`
                <label>
                  <span class="label-text">Max temperature (°F)</span>
                  <input
                    name="max_temp_f"
                    type="number"
                    min="60"
                    max="180"
                    step="1"
                    .value=${v['max_temp_f'] ?? ''}
                    @input=${onNum('max_temp_f')}
                  />
                  ${errs['max_temp_f']
                    ? html`<div class="field-error">${errs['max_temp_f']}</div>`
                    : null}
                </label>
                <label>
                  <span class="label-text">Min temperature (°F)</span>
                  <input
                    name="min_temp_f"
                    type="number"
                    min="60"
                    max="180"
                    step="1"
                    .value=${v['min_temp_f'] ?? ''}
                    @input=${onNum('min_temp_f')}
                  />
                  ${errs['min_temp_f']
                    ? html`<div class="field-error">${errs['min_temp_f']}</div>`
                    : null}
                </label>
              `
            : null}
          ${type === 'hvac'
            ? html`
                <label>
                  <span class="label-text">Base temperature (°F)</span>
                  <input
                    name="base_temperature"
                    type="number"
                    step="0.5"
                    .value=${v['base_temperature'] ?? ''}
                    @input=${onNum('base_temperature')}
                  />
                  ${errs['base_temperature']
                    ? html`<div class="field-error">${errs['base_temperature']}</div>`
                    : null}
                </label>
                <label>
                  <span class="label-text">Savings level (1–3)</span>
                  <div class="slider-row">
                    <input
                      name="savings_level"
                      type="range"
                      min="1"
                      max="3"
                      step="1"
                      .value=${v['savings_level'] ?? '3'}
                      @input=${onNum('savings_level')}
                    />
                    <span class="slider-value">${v['savings_level'] ?? '3'}</span>
                  </div>
                  ${errs['savings_level']
                    ? html`<div class="field-error">${errs['savings_level']}</div>`
                    : null}
                </label>
                <label>
                  <span class="label-text">HVAC mode</span>
                  <select
                    name="optimization_mode"
                    .value=${v['optimization_mode'] ?? 'auto'}
                    @change=${onSel('optimization_mode')}
                  >
                    <option value="auto">Auto (heat or cool as needed)</option>
                    <option value="cool">Cooling only</option>
                    <option value="heat">Heating only</option>
                    <option value="off">Off</option>
                  </select>
                  ${errs['optimization_mode']
                    ? html`<div class="field-error">${errs['optimization_mode']}</div>`
                    : null}
                </label>
                <div class="time-fields">
                  ${this._hourlyEnabled
                    ? null
                    : html`
                        <label>
                          <span class="label-text">Time away (HH:MM)</span>
                          <input
                            name="time_away"
                            type="text"
                            inputmode="numeric"
                            placeholder="08:00"
                            pattern="\\d{2}:\\d{2}"
                            .value=${v['time_away'] ?? ''}
                            @input=${onNum('time_away')}
                          />
                          <small class="label-text">Time you typically leave home (HH:MM, leave blank to keep current)</small>
                          ${errs['time_away']
                            ? html`<div class="field-error">${errs['time_away']}</div>`
                            : null}
                        </label>
                        <label>
                          <span class="label-text">Time home (HH:MM)</span>
                          <input
                            name="time_home"
                            type="text"
                            inputmode="numeric"
                            placeholder="17:00"
                            pattern="\\d{2}:\\d{2}"
                            .value=${v['time_home'] ?? ''}
                            @input=${onNum('time_home')}
                          />
                          <small class="label-text">Time you typically return home (HH:MM, leave blank to keep current)</small>
                          ${errs['time_home']
                            ? html`<div class="field-error">${errs['time_home']}</div>`
                            : null}
                        </label>
                      `}
                </div>
                <div class="hourly-bands">
                  <button
                    class="hourly-toggle ${this._hourlyOpen ? 'open' : ''}"
                    type="button"
                    aria-expanded=${this._hourlyOpen ? 'true' : 'false'}
                    @click=${() => toggleHourlyOpen()}
                  >
                    <span>Hourly bands (advanced)</span>
                    <span class="chevron" aria-hidden="true">▶</span>
                  </button>
                  ${this._hourlyOpen
                    ? html`
                        <div class="hourly-content">
                          <label class="hourly-checkbox">
                            <input
                              name="use_hourly_bands"
                              type="checkbox"
                              .checked=${this._hourlyEnabled}
                              @change=${onHourlyEnabled}
                            />
                            <span>Use my hourly bands (otherwise the optimizer uses base temperature + home/away schedule)</span>
                          </label>
                          <table class="hourly-table ${this._hourlyEnabled ? '' : 'disabled'}">
                            <thead>
                              <tr>
                                <th>Hour</th>
                                <th>Low °F</th>
                                <th>High °F</th>
                              </tr>
                            </thead>
                            <tbody>
                              ${Array.from({ length: 24 }, (_, i) => {
                                const lowErr = errs[`hourly_low_${i}`];
                                const highErr = errs[`hourly_high_${i}`];
                                const rowErr = errs[`hourly_row_${i}`];
                                const errMsg = rowErr ?? lowErr ?? highErr ?? '';
                                const hasErr = errMsg !== '';
                                return html`
                                  <tr data-row=${String(i)}>
                                    <td>${fmtHour(i)}</td>
                                    <td>
                                      <input
                                        name="hourly_low_${i}"
                                        type="number"
                                        step="0.5"
                                        min="50"
                                        max="90"
                                        class=${lowErr || rowErr ? 'invalid' : ''}
                                        ?disabled=${!this._hourlyEnabled}
                                        .value=${this._hourlyLow[i] ?? ''}
                                        @input=${onHourlyLow(i)}
                                      />
                                    </td>
                                    <td>
                                      <input
                                        name="hourly_high_${i}"
                                        type="number"
                                        step="0.5"
                                        min="50"
                                        max="90"
                                        class=${highErr || rowErr ? 'invalid' : ''}
                                        ?disabled=${!this._hourlyEnabled}
                                        .value=${this._hourlyHigh[i] ?? ''}
                                        @input=${onHourlyHigh(i)}
                                      />
                                    </td>
                                  </tr>
                                  <tr data-row-error=${String(i)} ?hidden=${!hasErr}>
                                    <td colspan="3" class="hourly-row-error">${errMsg}</td>
                                  </tr>
                                `;
                              })}
                            </tbody>
                          </table>
                        </div>
                      `
                    : null}
                </div>
              `
            : null}
          <div class="actions">
            <button class="cancel" type="button" @click=${() => this._onCancel()}>
              Cancel
            </button>
            <button
              class="save"
              type="button"
              ?disabled=${hasErrors || this._saving}
              title=${hasHourlyErrors ? 'Fix hourly bands errors' : ''}
              @click=${() => this._onSave()}
            >
              ${this._saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    `;
  }
}
