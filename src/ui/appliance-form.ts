import { LitElement, html, css } from 'lit';
import * as appliancesApi from '../api/appliances.js';
import type { Appliance, ApplianceType } from '../api/appliances.js';

type ErrorMap = Record<string, string>;

const TYPE_OPTIONS: Array<{ type: ApplianceType; label: string; description: string }> = [
  { type: 'hvac', label: 'HVAC', description: 'Thermostat / heat pump / AC' },
  { type: 'ev_charger', label: 'EV charger', description: 'Electric vehicle charger' },
  { type: 'home_battery', label: 'Home battery', description: 'Battery storage system' },
  { type: 'water_heater', label: 'Water heater', description: 'Electric water heater' },
];

export class HmApplianceForm extends LitElement {
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
      max-width: 480px;
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
    .type-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    button.type-btn {
      background: var(--hm-bg, #F8FAFC);
      border: 1px solid var(--hm-muted, #64748B);
      border-radius: 8px;
      padding: 14px 12px;
      font: inherit;
      cursor: pointer;
      text-align: left;
      display: flex;
      flex-direction: column;
      gap: 4px;
      color: var(--hm-text, #0F172A);
    }
    button.type-btn:hover {
      border-color: var(--hm-primary, #1E3A8A);
    }
    button.type-btn .type-name {
      font-weight: 600;
      color: var(--hm-primary, #1E3A8A);
    }
    button.type-btn .type-desc {
      font-size: 12px;
      color: var(--hm-muted, #64748B);
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
    button.cancel,
    button.back {
      background: transparent;
      border: 1px solid var(--hm-muted, #64748B);
      color: var(--hm-text, #0F172A);
    }
    button.submit {
      background: var(--hm-primary, #1E3A8A);
      color: #ffffff;
      border: none;
      font-weight: 600;
    }
    button.submit[disabled] {
      opacity: 0.55;
      cursor: not-allowed;
    }
  `;

  static override properties = {
    open: { type: Boolean, reflect: true },
    submitting: { type: Boolean, reflect: true },
    error: { state: true },
    _pickedType: { state: true },
    _values: { state: true },
    _errors: { state: true },
  };

  open = false;
  submitting = false;
  error: string | null = null;
  _pickedType: ApplianceType | null = null;
  _values: Record<string, string> = {};
  _errors: ErrorMap = {};

  private _lastOpen = false;

  override willUpdate(changed: Map<string, unknown>): void {
    if (changed.has('open')) {
      if (this.open && !this._lastOpen) {
        this._reset();
      }
      this._lastOpen = this.open;
    }
  }

  private _reset(): void {
    this._pickedType = null;
    this._values = {};
    this._errors = {};
    this.error = null;
    this.submitting = false;
  }

  private _pickType(t: ApplianceType): void {
    this._pickedType = t;
    this._values = this._defaultValues(t);
    this._errors = {};
    this.error = null;
  }

  private _defaultValues(t: ApplianceType): Record<string, string> {
    switch (t) {
      case 'hvac':
        return { name: '', hvac_type: 'central_ac', home_size_sqft: '' };
      case 'ev_charger':
        return {
          name: '',
          battery_capacity_kwh: '',
          max_charge_rate_kw: '',
          efficiency: '0.9',
        };
      case 'home_battery':
        return {
          name: '',
          capacity_kwh: '',
          max_charge_rate_kw: '',
          max_discharge_rate_kw: '',
        };
      case 'water_heater':
        return {
          name: '',
          tank_size_gallons: '',
          element_watts: '',
          insulation_factor: '0.5',
        };
    }
  }

  private _back(): void {
    this._pickedType = null;
    this._values = {};
    this._errors = {};
    this.error = null;
  }

  private _setValue(name: string, value: string): void {
    this._values = { ...this._values, [name]: value };
    this._errors = this._validate(this._values);
  }

  private _validate(values: Record<string, string>): ErrorMap {
    const errors: ErrorMap = {};
    if ((values['name'] ?? '').trim() === '') {
      errors['name'] = 'Required';
    }
    const reqPositive = (k: string, label: string, min = 0) => {
      const raw = (values[k] ?? '').trim();
      if (raw === '') {
        errors[k] = 'Required';
        return;
      }
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= min) {
        errors[k] = label;
      }
    };
    const reqInRange = (k: string, lo: number, hi: number, label: string) => {
      const raw = (values[k] ?? '').trim();
      if (raw === '') {
        errors[k] = 'Required';
        return;
      }
      const n = Number(raw);
      if (!Number.isFinite(n) || n < lo || n > hi) {
        errors[k] = label;
      }
    };
    switch (this._pickedType) {
      case 'hvac': {
        const hvacType = values['hvac_type'] ?? '';
        if (!['central_ac', 'window_ac', 'heat_pump', 'furnace'].includes(hvacType)) {
          errors['hvac_type'] = 'Pick an option';
        }
        const raw = (values['home_size_sqft'] ?? '').trim();
        if (raw === '') {
          errors['home_size_sqft'] = 'Required';
        } else {
          const n = Number(raw);
          if (!Number.isFinite(n) || n < 100) errors['home_size_sqft'] = 'Must be at least 100';
        }
        break;
      }
      case 'ev_charger':
        reqPositive('battery_capacity_kwh', 'Must be greater than 0');
        reqPositive('max_charge_rate_kw', 'Must be greater than 0');
        reqInRange('efficiency', 0.5, 1.0, 'Must be 0.5–1.0');
        break;
      case 'home_battery':
        reqPositive('capacity_kwh', 'Must be greater than 0');
        reqPositive('max_charge_rate_kw', 'Must be greater than 0');
        reqPositive('max_discharge_rate_kw', 'Must be greater than 0');
        break;
      case 'water_heater': {
        const tank = (values['tank_size_gallons'] ?? '').trim();
        if (tank === '') errors['tank_size_gallons'] = 'Required';
        else {
          const n = Number(tank);
          if (!Number.isInteger(n) || n <= 0) errors['tank_size_gallons'] = 'Positive integer';
        }
        const watts = (values['element_watts'] ?? '').trim();
        if (watts === '') errors['element_watts'] = 'Required';
        else {
          const n = Number(watts);
          if (!Number.isInteger(n) || n <= 0) errors['element_watts'] = 'Positive integer';
        }
        reqInRange('insulation_factor', 0, 1, 'Must be 0–1');
        break;
      }
    }
    return errors;
  }

  private _buildConfig(): Record<string, unknown> {
    const v = this._values;
    switch (this._pickedType) {
      case 'hvac':
        return {
          hvac_type: v['hvac_type'] ?? 'central_ac',
          home_size_sqft: Number(v['home_size_sqft']),
        };
      case 'ev_charger':
        return {
          battery_capacity_kwh: Number(v['battery_capacity_kwh']),
          max_charge_rate_kw: Number(v['max_charge_rate_kw']),
          efficiency: Number(v['efficiency']),
        };
      case 'home_battery':
        return {
          capacity_kwh: Number(v['capacity_kwh']),
          max_charge_rate_kw: Number(v['max_charge_rate_kw']),
          max_discharge_rate_kw: Number(v['max_discharge_rate_kw']),
        };
      case 'water_heater':
        return {
          tank_size_gallons: Number(v['tank_size_gallons']),
          element_watts: Number(v['element_watts']),
          insulation_factor: Number(v['insulation_factor']),
        };
      default:
        return {};
    }
  }

  private async _onSubmit(): Promise<void> {
    if (!this._pickedType) return;
    const errors = this._validate(this._values);
    this._errors = errors;
    if (Object.keys(errors).length > 0) return;

    this.submitting = true;
    this.error = null;
    try {
      const appliance: Appliance = await appliancesApi.create({
        appliance_type: this._pickedType,
        name: this._values['name'].trim(),
        config: this._buildConfig(),
      });
      this.dispatchEvent(
        new CustomEvent('appliance-created', {
          detail: { appliance },
          bubbles: true,
          composed: true,
        }),
      );
      this.open = false;
      this._reset();
    } catch (err) {
      this.error =
        err instanceof Error && err.message
          ? err.message
          : 'Could not create appliance — please try again';
    } finally {
      this.submitting = false;
    }
  }

  private _onCancel(): void {
    this.open = false;
    this._reset();
    this.dispatchEvent(
      new CustomEvent('cancelled', { bubbles: true, composed: true }),
    );
  }

  override render() {
    if (!this.open) return null;
    if (this._pickedType) {
      return html`
        <div class="overlay" role="presentation">
          <div
            class="panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="hm-af-title"
          >
            <h2 id="hm-af-title">Add appliance details</h2>
            ${this.error
              ? html`<div class="top-error" role="alert">${this.error}</div>`
              : null}
            ${this._renderStep2()}
          </div>
        </div>
      `;
    }
    return html`
      <div class="overlay" role="presentation">
        <div
          class="panel"
          role="dialog"
          aria-modal="true"
          aria-labelledby="hm-af-title"
        >
          <h2 id="hm-af-title">Add appliance</h2>
          ${this.error
            ? html`<div class="top-error" role="alert">${this.error}</div>`
            : null}
          ${this._renderStep1()}
        </div>
      </div>
    `;
  }

  private _renderStep1() {
    return html`
      <p>What kind of appliance are you registering?</p>
      <div class="type-grid">
        ${TYPE_OPTIONS.map(
          (o) => html`
            <button
              class="type-btn"
              type="button"
              data-type=${o.type}
              @click=${() => this._pickType(o.type)}
            >
              <span class="type-name">${o.label}</span>
              <span class="type-desc">${o.description}</span>
            </button>
          `,
        )}
      </div>
      <div class="actions">
        <button class="cancel" type="button" @click=${() => this._onCancel()}>
          Cancel
        </button>
      </div>
    `;
  }

  private _renderStep2() {
    const t = this._pickedType!;
    const v = this._values;
    const errs = this._errors;
    const hasErrors = Object.keys(errs).length > 0;
    const onInput = (name: string) => (e: Event) =>
      this._setValue(name, (e.target as HTMLInputElement).value);
    const onSelect = (name: string) => (e: Event) =>
      this._setValue(name, (e.target as HTMLSelectElement).value);

    let typeFields;
    if (t === 'hvac') {
      typeFields = html`
        <label>
          <span class="label-text">HVAC type</span>
          <select
            name="hvac_type"
            .value=${v['hvac_type'] ?? 'central_ac'}
            @change=${onSelect('hvac_type')}
          >
            <option value="central_ac">Central AC</option>
            <option value="window_ac">Window AC</option>
            <option value="heat_pump">Heat pump</option>
            <option value="furnace">Furnace</option>
          </select>
          ${errs['hvac_type']
            ? html`<div class="field-error">${errs['hvac_type']}</div>`
            : null}
        </label>
        <label>
          <span class="label-text">Home size (sqft)</span>
          <input
            name="home_size_sqft"
            type="number"
            min="100"
            step="10"
            .value=${v['home_size_sqft'] ?? ''}
            @input=${onInput('home_size_sqft')}
          />
          ${errs['home_size_sqft']
            ? html`<div class="field-error">${errs['home_size_sqft']}</div>`
            : null}
        </label>
      `;
    } else if (t === 'ev_charger') {
      typeFields = html`
        <label>
          <span class="label-text">Battery capacity (kWh)</span>
          <input
            name="battery_capacity_kwh"
            type="number"
            min="1"
            step="0.1"
            .value=${v['battery_capacity_kwh'] ?? ''}
            @input=${onInput('battery_capacity_kwh')}
          />
          ${errs['battery_capacity_kwh']
            ? html`<div class="field-error">${errs['battery_capacity_kwh']}</div>`
            : null}
        </label>
        <label>
          <span class="label-text">Max charge rate (kW)</span>
          <input
            name="max_charge_rate_kw"
            type="number"
            min="0.5"
            step="0.1"
            .value=${v['max_charge_rate_kw'] ?? ''}
            @input=${onInput('max_charge_rate_kw')}
          />
          ${errs['max_charge_rate_kw']
            ? html`<div class="field-error">${errs['max_charge_rate_kw']}</div>`
            : null}
        </label>
        <label>
          <span class="label-text">Efficiency (0.5–1.0)</span>
          <input
            name="efficiency"
            type="number"
            min="0.5"
            max="1"
            step="0.01"
            .value=${v['efficiency'] ?? '0.9'}
            @input=${onInput('efficiency')}
          />
          ${errs['efficiency']
            ? html`<div class="field-error">${errs['efficiency']}</div>`
            : null}
        </label>
      `;
    } else if (t === 'home_battery') {
      typeFields = html`
        <label>
          <span class="label-text">Capacity (kWh)</span>
          <input
            name="capacity_kwh"
            type="number"
            min="0.1"
            step="0.1"
            .value=${v['capacity_kwh'] ?? ''}
            @input=${onInput('capacity_kwh')}
          />
          ${errs['capacity_kwh']
            ? html`<div class="field-error">${errs['capacity_kwh']}</div>`
            : null}
        </label>
        <label>
          <span class="label-text">Max charge rate (kW)</span>
          <input
            name="max_charge_rate_kw"
            type="number"
            min="0.1"
            step="0.1"
            .value=${v['max_charge_rate_kw'] ?? ''}
            @input=${onInput('max_charge_rate_kw')}
          />
          ${errs['max_charge_rate_kw']
            ? html`<div class="field-error">${errs['max_charge_rate_kw']}</div>`
            : null}
        </label>
        <label>
          <span class="label-text">Max discharge rate (kW)</span>
          <input
            name="max_discharge_rate_kw"
            type="number"
            min="0.1"
            step="0.1"
            .value=${v['max_discharge_rate_kw'] ?? ''}
            @input=${onInput('max_discharge_rate_kw')}
          />
          ${errs['max_discharge_rate_kw']
            ? html`<div class="field-error">${errs['max_discharge_rate_kw']}</div>`
            : null}
        </label>
      `;
    } else {
      typeFields = html`
        <label>
          <span class="label-text">Tank size (gallons)</span>
          <input
            name="tank_size_gallons"
            type="number"
            min="1"
            step="1"
            .value=${v['tank_size_gallons'] ?? ''}
            @input=${onInput('tank_size_gallons')}
          />
          ${errs['tank_size_gallons']
            ? html`<div class="field-error">${errs['tank_size_gallons']}</div>`
            : null}
        </label>
        <label>
          <span class="label-text">Element wattage (W)</span>
          <input
            name="element_watts"
            type="number"
            min="1"
            step="1"
            .value=${v['element_watts'] ?? ''}
            @input=${onInput('element_watts')}
          />
          ${errs['element_watts']
            ? html`<div class="field-error">${errs['element_watts']}</div>`
            : null}
        </label>
        <label>
          <span class="label-text">Insulation factor (0–1)</span>
          <input
            name="insulation_factor"
            type="number"
            min="0"
            max="1"
            step="0.05"
            .value=${v['insulation_factor'] ?? '0.5'}
            @input=${onInput('insulation_factor')}
          />
          ${errs['insulation_factor']
            ? html`<div class="field-error">${errs['insulation_factor']}</div>`
            : null}
        </label>
      `;
    }

    const nameErr = errs['name'] ?? '';
    return html`
      <label>
        <span class="label-text">Name</span>
        <input name="name" type="text" .value=${v['name'] ?? ''} @input=${onInput('name')}>
        <div class="field-error" ?hidden=${!nameErr}>${nameErr}</div>
      </label>
      <div class="type-fields">${typeFields}</div>
      <div class="actions">
        <button class="back" type="button" @click=${() => this._back()}>Back</button>
        <button class="cancel" type="button" @click=${() => this._onCancel()}>Cancel</button>
        <button
          class="submit"
          type="button"
          ?disabled=${hasErrors || this.submitting}
          @click=${() => this._onSubmit()}
        >${this.submitting ? 'Adding…' : 'Add'}</button>
      </div>
    `;
  }
}
