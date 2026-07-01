import { LitElement, html, css, type TemplateResult } from 'lit';
import * as appliancesApi from '../api/appliances.js';
import type { Appliance, ApplianceType } from '../api/appliances.js';

type ErrorMap = Record<string, string>;

type HassStateLike = {
  entity_id?: string;
  state?: unknown;
  attributes?: Record<string, unknown>;
};
type HassLike = { states?: Record<string, HassStateLike> };

const TYPE_OPTIONS: Array<{ type: ApplianceType; label: string; description: string }> = [
  { type: 'hvac', label: 'HVAC', description: 'Thermostat / heat pump / AC' },
  { type: 'ev_charger', label: 'EV charger', description: 'Electric vehicle charger' },
  { type: 'home_battery', label: 'Home battery', description: 'Battery storage system' },
  { type: 'water_heater', label: 'Water heater', description: 'Electric water heater' },
  { type: 'solar', label: 'Solar PV', description: 'Rooftop solar generation' },
  { type: 'dehumidifier', label: 'Dehumidifier', description: 'Records room temp/humidity (data only)' },
];

// Per-type allowed control-entity domains. The integration applies the
// optimized schedule by calling the matching service on this entity.
// Solar has no control surface (it produces what it produces) — the
// empty list here is the signal that the form should hide the entity
// picker and skip the "pick an entity" validation.
const CONTROL_DOMAINS: Record<ApplianceType, ReadonlyArray<string>> = {
  hvac: ['climate'],
  ev_charger: ['switch'],
  home_battery: ['switch'],
  water_heater: ['switch', 'climate'],
  solar: [],
  // HA models dehumidifiers under the `humidifier` domain (device_class
  // dehumidifier). Data-collection only — no schedule is applied, but the
  // entity is still the thing we observe on/off/mode + current_humidity.
  dehumidifier: ['humidifier'],
};

// Optional auxiliary sensor entities — when present, the readings poller
// includes their state in the per-appliance reading payload.
const AUX_FIELDS: Partial<Record<ApplianceType, { name: string; label: string; help: string; domain: string }>> = {
  hvac: {
    name: 'indoor_temp_entity_id',
    label: 'Indoor temperature sensor (optional)',
    help: 'sensor.* exposing indoor temp in °F — used when the climate entity reports current_temperature: null (Tuya wrappers, IR-blaster controllers, etc.)',
    domain: 'sensor',
  },
  ev_charger: {
    name: 'soc_entity_id',
    label: 'State-of-charge sensor (optional)',
    help: 'sensor.* exposing battery % so the optimizer sees live SoC',
    domain: 'sensor',
  },
  home_battery: {
    name: 'soc_entity_id',
    label: 'State-of-charge sensor (optional)',
    help: 'sensor.* exposing battery % so the optimizer sees live SoC',
    domain: 'sensor',
  },
  water_heater: {
    name: 'temp_entity_id',
    label: 'Tank temperature sensor (optional)',
    help: 'sensor.* exposing tank temp in °F',
    domain: 'sensor',
  },
};

// HVAC gets two additional optional aux fields beyond the singular
// AUX_FIELDS path: a power sensor (ground-truth "AC running" signal
// for the reconciler) and an indoor humidity sensor (latent-heat
// load input for the model). Kept as separate constants rather than
// extending AUX_FIELDS to a list because the original singular-aux
// render path is well-tested and additional conditional blocks in
// the render slot in cleanly.
const HVAC_POWER_FIELD = {
  name: 'power_sensor_entity_id',
  label: 'AC power sensor (optional)',
  help: 'sensor.* exposing instantaneous draw in W or kW (built-in meter or smart plug). Lets the model verify the AC is actually running when the climate entity reports stale state — common on Tuya / mini-split units.',
  domain: 'sensor',
} as const;

const HVAC_INDOOR_HUMIDITY_FIELD = {
  name: 'indoor_humidity_entity_id',
  label: 'Indoor humidity sensor (optional)',
  help: 'sensor.* exposing indoor relative humidity (0-100%). Used when the climate entity doesn\'t expose current_humidity (Tuya / IR-blaster). Humid weather drops AC capacity 30-50% — this lets the optimizer account for that.',
  domain: 'sensor',
} as const;

// Dehumidifier aux sensors. Unlike HVAC (which reads temp off the climate
// entity), a `humidifier.*` entity has no thermistor, so the room-temp
// sensor is REQUIRED — it's the only temp source and every sensor reading
// needs indoor_temp. Humidity + power are optional extras.
const DEHU_TEMP_FIELD = {
  name: 'indoor_temp_entity_id',
  label: 'Room temperature sensor (required)',
  help: 'sensor.* exposing room temp in °F. Required — a dehumidifier entity has no built-in thermometer and every reading needs a temperature.',
  domain: 'sensor',
} as const;

const DEHU_HUMIDITY_FIELD = {
  name: 'indoor_humidity_entity_id',
  label: 'Room humidity sensor (optional)',
  help: 'sensor.* exposing room relative humidity (0-100%). Falls back to the dehumidifier entity\'s current_humidity attribute when left unset.',
  domain: 'sensor',
} as const;

const DEHU_POWER_FIELD = {
  name: 'power_sensor_entity_id',
  label: 'Power sensor (optional)',
  help: 'sensor.* exposing the dehumidifier\'s power draw in W or kW (built-in meter or smart plug). Records how much it runs.',
  domain: 'sensor',
} as const;

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
    .entity-section {
      border-top: 1px solid rgba(100, 116, 139, 0.2);
      padding-top: 12px;
      margin-top: 4px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .entity-section .hint {
      display: block;
      margin-top: 4px;
      color: var(--hm-muted, #64748B);
      font-size: 12px;
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
    hass: { attribute: false },
    // `editing` is the appliance being edited — when null/undefined,
    // the form is in CREATE mode (POST). When set, the form skips the
    // type-picker step, pre-populates from the appliance, and calls
    // PUT on submit instead of POST.
    editing: { attribute: false },
    // The full list of the user's already-registered appliances. Used
    // for the multi-HVAC entity uniqueness guard (US-MHVAC-015): two
    // HVAC appliances may not bind the same climate `entity_id`. Empty
    // is a safe default for tests that don't care about the guard.
    existingAppliances: { attribute: false },
    _pickedType: { state: true },
    _values: { state: true },
    _errors: { state: true },
  };

  open = false;
  submitting = false;
  error: string | null = null;
  hass: HassLike | undefined = undefined;
  editing: Appliance | null = null;
  existingAppliances: Appliance[] = [];
  _pickedType: ApplianceType | null = null;
  _values: Record<string, string> = {};
  _errors: ErrorMap = {};

  private _lastOpen = false;
  private _seededForEditingId: string | null = null;

  override willUpdate(changed: Map<string, unknown>): void {
    if (changed.has('open')) {
      if (this.open && !this._lastOpen) {
        // Don't blow away values when opening directly into edit mode
        // — `_seedFromEditing` will populate them below.
        if (!this.editing) {
          this._reset();
        }
      }
      this._lastOpen = this.open;
    }
    // Whenever the editing target changes (or arrives for the first
    // time after open), seed the form values from it.
    if (
      this.open &&
      this.editing &&
      this._seededForEditingId !== this.editing.id
    ) {
      this._seedFromEditing(this.editing);
      this._seededForEditingId = this.editing.id;
    }
    if (!this.editing && this._seededForEditingId !== null) {
      this._seededForEditingId = null;
    }
  }

  private _reset(): void {
    this._pickedType = null;
    this._values = {};
    this._errors = {};
    this.error = null;
    this.submitting = false;
  }

  private _seedFromEditing(appliance: Appliance): void {
    const t = appliance.appliance_type;
    this._pickedType = t;
    const defaults = this._defaultValues(t);
    const cfg = (appliance.config ?? {}) as Record<string, unknown>;
    // Stringify every config field that the form binds to — numbers
    // arrive as `number` from the API but the <input> elements expect
    // strings. Empty strings are fine for optional fields.
    const fromCfg = (key: string): string => {
      const raw = cfg[key];
      if (raw === null || raw === undefined) return '';
      return String(raw);
    };
    const seeded: Record<string, string> = {
      ...defaults,
      name: appliance.name ?? '',
    };
    for (const key of Object.keys(defaults)) {
      if (key === 'name') continue;
      const cfgValue = fromCfg(key);
      if (cfgValue !== '') seeded[key] = cfgValue;
    }
    // Aux field — may exist on the appliance config but not in
    // `defaults` if the form added support later (e.g. HVAC
    // indoor_temp_entity_id on a pre-update appliance).
    const aux = AUX_FIELDS[t];
    if (aux) {
      const auxVal = fromCfg(aux.name);
      seeded[aux.name] = auxVal;
    }
    // HVAC has two extra optional aux fields beyond the singular
    // AUX_FIELDS entry: power and indoor humidity. Both seeded from
    // existing config so editing keeps the user's values.
    if (t === 'hvac') {
      seeded[HVAC_POWER_FIELD.name] = fromCfg(HVAC_POWER_FIELD.name);
      seeded[HVAC_INDOOR_HUMIDITY_FIELD.name] =
        fromCfg(HVAC_INDOOR_HUMIDITY_FIELD.name);
    }
    this._values = seeded;
    this._errors = this._validate(seeded);
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
    // Every type now requires `entity_id` (the HA entity to control) and
    // optionally an aux sensor — both default empty so the user must
    // pick from a populated dropdown.
    switch (t) {
      case 'hvac':
        return {
          name: '',
          hvac_type: 'central_ac',
          home_size_sqft: '',
          entity_id: '',
          indoor_temp_entity_id: '',
          power_sensor_entity_id: '',
          indoor_humidity_entity_id: '',
        };
      case 'ev_charger':
        return {
          name: '',
          battery_capacity_kwh: '',
          max_charge_rate_kw: '',
          efficiency: '0.9',
          entity_id: '',
          soc_entity_id: '',
        };
      case 'home_battery':
        return {
          name: '',
          capacity_kwh: '',
          max_charge_rate_kw: '',
          max_discharge_rate_kw: '',
          entity_id: '',
          soc_entity_id: '',
        };
      case 'water_heater':
        return {
          name: '',
          tank_size_gallons: '',
          element_watts: '',
          insulation_factor: '0.03',
          entity_id: '',
          temp_entity_id: '',
        };
      case 'solar':
        // Forecast-only appliance — no entity_id, no readings. Defaults
        // mirror the SolarConfig pydantic model on the backend (azimuth
        // 180 = south-facing, tilt 20 = mid-latitude rooftop).
        return {
          name: '',
          system_size_kw: '',
          azimuth_degrees: '180',
          tilt_degrees: '20',
        };
      case 'dehumidifier':
        // Data-collection only. Control entity + required room-temp sensor
        // + optional humidity/power + optional nameplate capacity.
        return {
          name: '',
          entity_id: '',
          indoor_temp_entity_id: '',
          indoor_humidity_entity_id: '',
          power_sensor_entity_id: '',
          capacity_pints_per_day: '',
        };
    }
  }

  private _entityList(domains: ReadonlyArray<string>): string[] {
    const states = this.hass?.states;
    if (!states) return [];
    const out: string[] = [];
    for (const id of Object.keys(states)) {
      const dot = id.indexOf('.');
      if (dot <= 0) continue;
      if (domains.includes(id.slice(0, dot))) out.push(id);
    }
    return out.sort();
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
        reqInRange('insulation_factor', 0.01, 0.05, 'Must be 0.01-0.05');
        break;
      }
      case 'solar':
        reqInRange('system_size_kw', 0.1, 100, 'Must be 0.1-100 kW');
        reqInRange('azimuth_degrees', 0, 360, 'Must be 0-360°');
        reqInRange('tilt_degrees', 0, 90, 'Must be 0-90°');
        break;
      case 'dehumidifier': {
        // Room-temp sensor is mandatory (the only temp source, and every
        // reading needs indoor_temp).
        if ((values['indoor_temp_entity_id'] ?? '').trim() === '') {
          errors['indoor_temp_entity_id'] = 'Pick a room temperature sensor';
        }
        // Capacity is an optional nameplate spec; validate only if given.
        const cap = (values['capacity_pints_per_day'] ?? '').trim();
        if (cap !== '') {
          const n = Number(cap);
          if (!Number.isFinite(n) || n <= 0 || n > 200) {
            errors['capacity_pints_per_day'] = 'Must be 0–200';
          }
        }
        break;
      }
    }

    // entity_id is required for every type with a non-empty CONTROL_DOMAINS
    // list — without it the integration can't apply the optimized schedule.
    // Solar has no control surface, so the picker is hidden and not validated.
    if (this._pickedType !== null && CONTROL_DOMAINS[this._pickedType].length > 0) {
      const eid = (values['entity_id'] ?? '').trim();
      if (eid === '') {
        errors['entity_id'] = 'Pick the Home Assistant entity to control';
      } else if (this._pickedType === 'hvac') {
        // Multi-HVAC entity uniqueness guard (US-MHVAC-015): two HVAC
        // appliances may not bind the same climate entity. Editing
        // skips the appliance being edited so the user can keep their
        // own existing binding.
        const editingId = this.editing?.id ?? null;
        const collision = this.existingAppliances.find((a) => {
          if (a.appliance_type !== 'hvac') return false;
          if (editingId && a.id === editingId) return false;
          const cfg = (a.config ?? {}) as Record<string, unknown>;
          return cfg['entity_id'] === eid;
        });
        if (collision) {
          errors['entity_id'] =
            `Another HVAC (“${collision.name || collision.id}”) is already bound to ${eid}. Pick a different climate entity.`;
        }
      }
    }
    return errors;
  }

  private _buildConfig(): Record<string, unknown> {
    const v = this._values;
    const entityId = (v['entity_id'] ?? '').trim();
    const aux = AUX_FIELDS[this._pickedType as ApplianceType];
    const auxValue = aux ? (v[aux.name] ?? '').trim() : '';
    switch (this._pickedType) {
      case 'hvac': {
        const powerValue = (v[HVAC_POWER_FIELD.name] ?? '').trim();
        const humidityValue = (v[HVAC_INDOOR_HUMIDITY_FIELD.name] ?? '').trim();
        return {
          hvac_type: v['hvac_type'] ?? 'central_ac',
          home_size_sqft: Number(v['home_size_sqft']),
          entity_id: entityId,
          ...(auxValue ? { indoor_temp_entity_id: auxValue } : {}),
          ...(powerValue ? { power_sensor_entity_id: powerValue } : {}),
          ...(humidityValue ? { indoor_humidity_entity_id: humidityValue } : {}),
        };
      }
      case 'ev_charger':
        return {
          battery_capacity_kwh: Number(v['battery_capacity_kwh']),
          max_charge_rate_kw: Number(v['max_charge_rate_kw']),
          efficiency: Number(v['efficiency']),
          entity_id: entityId,
          ...(auxValue ? { soc_entity_id: auxValue } : {}),
        };
      case 'home_battery':
        return {
          capacity_kwh: Number(v['capacity_kwh']),
          max_charge_rate_kw: Number(v['max_charge_rate_kw']),
          max_discharge_rate_kw: Number(v['max_discharge_rate_kw']),
          entity_id: entityId,
          ...(auxValue ? { soc_entity_id: auxValue } : {}),
        };
      case 'water_heater':
        return {
          tank_size_gallons: Number(v['tank_size_gallons']),
          element_watts: Number(v['element_watts']),
          insulation_factor: Number(v['insulation_factor']),
          entity_id: entityId,
          ...(auxValue ? { temp_entity_id: auxValue } : {}),
        };
      case 'solar':
        return {
          system_size_kw: Number(v['system_size_kw']),
          azimuth_degrees: Number(v['azimuth_degrees']),
          tilt_degrees: Number(v['tilt_degrees']),
        };
      case 'dehumidifier': {
        const humidityValue = (v['indoor_humidity_entity_id'] ?? '').trim();
        const powerValue = (v['power_sensor_entity_id'] ?? '').trim();
        const capValue = (v['capacity_pints_per_day'] ?? '').trim();
        return {
          entity_id: entityId,
          indoor_temp_entity_id: (v['indoor_temp_entity_id'] ?? '').trim(),
          ...(humidityValue ? { indoor_humidity_entity_id: humidityValue } : {}),
          ...(powerValue ? { power_sensor_entity_id: powerValue } : {}),
          ...(capValue ? { capacity_pints_per_day: Number(capValue) } : {}),
        };
      }
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
      if (this.editing) {
        // EDIT path: PUT only the name and config; appliance_type is
        // immutable (changing it would break linked schedules + readings).
        const appliance: Appliance = await appliancesApi.update(this.editing.id, {
          name: this._values['name'].trim(),
          config: this._buildConfig(),
        });
        this.dispatchEvent(
          new CustomEvent('appliance-updated', {
            detail: { appliance },
            bubbles: true,
            composed: true,
          }),
        );
      } else {
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
      }
      this.open = false;
      this._reset();
    } catch (err) {
      const verb = this.editing ? 'update' : 'create';
      this.error =
        err instanceof Error && err.message
          ? err.message
          : `Could not ${verb} appliance — please try again`;
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
    const editing = !!this.editing;
    if (this._pickedType) {
      const title = editing ? 'Edit appliance' : 'Add appliance details';
      return html`
        <div class="overlay" role="presentation">
          <div
            class="panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="hm-af-title"
          >
            <h2 id="hm-af-title">${title}</h2>
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
    } else if (t === 'water_heater') {
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
          <span class="label-text">Insulation factor (0.01–0.05)</span>
          <input
            name="insulation_factor"
            type="number"
            min="0.01"
            max="0.05"
            step="0.005"
            .value=${v['insulation_factor'] ?? '0.03'}
            @input=${onInput('insulation_factor')}
          />
          <small class="label-text">Lower = better insulated. 0.03 is typical for a residential tank.</small>
          ${errs['insulation_factor']
            ? html`<div class="field-error">${errs['insulation_factor']}</div>`
            : null}
        </label>
      `;
    } else if (t === 'dehumidifier') {
      typeFields = html`
        <p class="hint" style="margin:0">
          Data collection only — Hungry Machines records this dehumidifier's
          temperature, humidity, power, and on/off state to study its effect
          on the room. It isn't scheduled or controlled yet.
        </p>
        <label>
          <span class="label-text">Capacity (pints/day, optional)</span>
          <input
            name="capacity_pints_per_day"
            type="number"
            min="1"
            max="200"
            step="1"
            .value=${v['capacity_pints_per_day'] ?? ''}
            @input=${onInput('capacity_pints_per_day')}
          />
          <small class="label-text">Nameplate moisture-removal spec. Optional — informational only for now.</small>
          ${errs['capacity_pints_per_day']
            ? html`<div class="field-error">${errs['capacity_pints_per_day']}</div>`
            : null}
        </label>
      `;
    } else {
      // solar — forecast-only, system size + orientation only.
      typeFields = html`
        <label>
          <span class="label-text">System size (kW)</span>
          <input
            name="system_size_kw"
            type="number"
            min="0.1"
            max="100"
            step="0.1"
            .value=${v['system_size_kw'] ?? ''}
            @input=${onInput('system_size_kw')}
          />
          <small class="label-text">DC nameplate of the array, e.g. 8.5 for an 8.5 kW system.</small>
          ${errs['system_size_kw']
            ? html`<div class="field-error">${errs['system_size_kw']}</div>`
            : null}
        </label>
        <label>
          <span class="label-text">Azimuth (degrees)</span>
          <input
            name="azimuth_degrees"
            type="number"
            min="0"
            max="360"
            step="5"
            .value=${v['azimuth_degrees'] ?? '180'}
            @input=${onInput('azimuth_degrees')}
          />
          <small class="label-text">180 = south-facing (default for the Northern Hemisphere).</small>
          ${errs['azimuth_degrees']
            ? html`<div class="field-error">${errs['azimuth_degrees']}</div>`
            : null}
        </label>
        <label>
          <span class="label-text">Tilt (degrees)</span>
          <input
            name="tilt_degrees"
            type="number"
            min="0"
            max="90"
            step="1"
            .value=${v['tilt_degrees'] ?? '20'}
            @input=${onInput('tilt_degrees')}
          />
          <small class="label-text">Roof pitch, 0 = flat, 20 is typical for residential.</small>
          ${errs['tilt_degrees']
            ? html`<div class="field-error">${errs['tilt_degrees']}</div>`
            : null}
        </label>
      `;
    }

    const nameErr = errs['name'] ?? '';
    const controlDomains = CONTROL_DOMAINS[t];
    // `solar` is forecast-only — no control entity, so the picker is
    // hidden entirely. Other types still require one.
    const showEntitySection = controlDomains.length > 0;
    const controlOptions = showEntitySection ? this._entityList(controlDomains) : [];
    const controlErr = errs['entity_id'] ?? '';
    const controlHelp =
      t === 'hvac'
        ? 'climate.* — sets target temps every 30 min'
        : t === 'water_heater'
          ? 'switch.* (resistive) or climate.* — toggled every 30 min'
          : t === 'dehumidifier'
            ? 'humidifier.* — observed only (Hungry Machines sends no commands)'
            : 'switch.* — toggled on/off every 30 min';
    const aux = AUX_FIELDS[t];
    const auxOptions = aux ? this._entityList([aux.domain]) : [];
    const auxName = aux ? aux.name : '';
    const auxLabel = aux ? aux.label : '';
    const auxHelp = aux ? aux.help : '';
    const auxValue = aux ? (v[aux.name] ?? '') : '';
    return html`
      <label>
        <span class="label-text">Name</span>
        <input name="name" type="text" .value=${v['name'] ?? ''} @input=${onInput('name')}>
        <div class="field-error" ?hidden=${!nameErr}>${nameErr}</div>
      </label>
      <div class="type-fields">${typeFields}</div>
      <div class="entity-section">
        ${showEntitySection
          ? html`
              <label>
                <span class="label-text">Home Assistant entity to control</span>
                <select
                  name="entity_id"
                  .value=${v['entity_id'] ?? ''}
                  @change=${onSelect('entity_id')}
                >
                  <option value="" ?selected=${(v['entity_id'] ?? '') === ''}>— pick one —</option>
                  ${controlOptions.map(
                    (id) => html`<option value=${id} ?selected=${id === v['entity_id']}>${id}</option>`,
                  )}
                </select>
                <small class="hint">${controlHelp}</small>
                ${controlErr ? html`<div class="field-error">${controlErr}</div>` : null}
                ${controlOptions.length === 0
                  ? html`<div class="field-error">
                      No matching entities found. Make sure your ${controlDomains.join('/')} integration is set up in HA.
                    </div>`
                  : null}
              </label>
              ${aux
                ? html`
                    <label>
                      <span class="label-text">${auxLabel}</span>
                      <select
                        name=${auxName}
                        .value=${auxValue}
                        @change=${onSelect(auxName)}
                      >
                        <option value="" ?selected=${auxValue === ''}>— none —</option>
                        ${auxOptions.map(
                          (id) => html`<option value=${id} ?selected=${id === auxValue}>${id}</option>`,
                        )}
                      </select>
                      <small class="hint">${auxHelp}</small>
                    </label>
                  `
                : null}
              ${t === 'hvac'
                ? html`
                    <label>
                      <span class="label-text">${HVAC_POWER_FIELD.label}</span>
                      <select
                        name=${HVAC_POWER_FIELD.name}
                        .value=${v[HVAC_POWER_FIELD.name] ?? ''}
                        @change=${onSelect(HVAC_POWER_FIELD.name)}
                      >
                        <option value="" ?selected=${(v[HVAC_POWER_FIELD.name] ?? '') === ''}>— none —</option>
                        ${this._entityList([HVAC_POWER_FIELD.domain]).map(
                          (id) => html`<option value=${id} ?selected=${id === v[HVAC_POWER_FIELD.name]}>${id}</option>`,
                        )}
                      </select>
                      <small class="hint">${HVAC_POWER_FIELD.help}</small>
                    </label>
                  `
                : null}
              ${t === 'hvac'
                ? html`
                    <label>
                      <span class="label-text">${HVAC_INDOOR_HUMIDITY_FIELD.label}</span>
                      <select
                        name=${HVAC_INDOOR_HUMIDITY_FIELD.name}
                        .value=${v[HVAC_INDOOR_HUMIDITY_FIELD.name] ?? ''}
                        @change=${onSelect(HVAC_INDOOR_HUMIDITY_FIELD.name)}
                      >
                        <option value="" ?selected=${(v[HVAC_INDOOR_HUMIDITY_FIELD.name] ?? '') === ''}>— none —</option>
                        ${this._entityList([HVAC_INDOOR_HUMIDITY_FIELD.domain]).map(
                          (id) => html`<option value=${id} ?selected=${id === v[HVAC_INDOOR_HUMIDITY_FIELD.name]}>${id}</option>`,
                        )}
                      </select>
                      <small class="hint">${HVAC_INDOOR_HUMIDITY_FIELD.help}</small>
                    </label>
                  `
                : null}
              ${t === 'dehumidifier'
                ? html`
                    <label>
                      <span class="label-text">${DEHU_TEMP_FIELD.label}</span>
                      <select
                        name=${DEHU_TEMP_FIELD.name}
                        .value=${v[DEHU_TEMP_FIELD.name] ?? ''}
                        @change=${onSelect(DEHU_TEMP_FIELD.name)}
                      >
                        <option value="" ?selected=${(v[DEHU_TEMP_FIELD.name] ?? '') === ''}>— pick one —</option>
                        ${this._entityList([DEHU_TEMP_FIELD.domain]).map(
                          (id) => html`<option value=${id} ?selected=${id === v[DEHU_TEMP_FIELD.name]}>${id}</option>`,
                        )}
                      </select>
                      <small class="hint">${DEHU_TEMP_FIELD.help}</small>
                      ${errs['indoor_temp_entity_id']
                        ? html`<div class="field-error">${errs['indoor_temp_entity_id']}</div>`
                        : null}
                    </label>
                    <label>
                      <span class="label-text">${DEHU_HUMIDITY_FIELD.label}</span>
                      <select
                        name=${DEHU_HUMIDITY_FIELD.name}
                        .value=${v[DEHU_HUMIDITY_FIELD.name] ?? ''}
                        @change=${onSelect(DEHU_HUMIDITY_FIELD.name)}
                      >
                        <option value="" ?selected=${(v[DEHU_HUMIDITY_FIELD.name] ?? '') === ''}>— none —</option>
                        ${this._entityList([DEHU_HUMIDITY_FIELD.domain]).map(
                          (id) => html`<option value=${id} ?selected=${id === v[DEHU_HUMIDITY_FIELD.name]}>${id}</option>`,
                        )}
                      </select>
                      <small class="hint">${DEHU_HUMIDITY_FIELD.help}</small>
                    </label>
                    <label>
                      <span class="label-text">${DEHU_POWER_FIELD.label}</span>
                      <select
                        name=${DEHU_POWER_FIELD.name}
                        .value=${v[DEHU_POWER_FIELD.name] ?? ''}
                        @change=${onSelect(DEHU_POWER_FIELD.name)}
                      >
                        <option value="" ?selected=${(v[DEHU_POWER_FIELD.name] ?? '') === ''}>— none —</option>
                        ${this._entityList([DEHU_POWER_FIELD.domain]).map(
                          (id) => html`<option value=${id} ?selected=${id === v[DEHU_POWER_FIELD.name]}>${id}</option>`,
                        )}
                      </select>
                      <small class="hint">${DEHU_POWER_FIELD.help}</small>
                    </label>
                  `
                : null}
            `
          : null}
      </div>
      <div class="actions">
        ${this.editing
          ? null
          : html`<button class="back" type="button" @click=${() => this._back()}>Back</button>`}
        <button class="cancel" type="button" @click=${() => this._onCancel()}>Cancel</button>
        <button
          class="submit"
          type="button"
          ?disabled=${hasErrors || this.submitting}
          @click=${() => this._onSubmit()}
        >${this._submitLabel()}</button>
      </div>
    `;
  }

  private _submitLabel(): string {
    if (this.editing) return this.submitting ? 'Saving…' : 'Save';
    return this.submitting ? 'Adding…' : 'Add';
  }

}
