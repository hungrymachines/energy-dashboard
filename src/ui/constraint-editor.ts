import { LitElement, html, css } from 'lit';
import { setConstraints } from '../api/appliances.js';
import {
  update as updateAppliancePreferences,
  defaultBands as fetchDefaultBands,
} from '../api/appliance-preferences.js';
import type { ApplianceType } from '../api/appliances.js';
import type { BandPrefs } from '../utils/day-bands.js';
import {
  deriveHourlyComfortBand,
  hasHourlyComfortBands,
  type ComfortMode,
} from '../utils/hourly.js';
import {
  WEEKDAY_KEYS,
  bandsEqual,
  detectPreset,
  expandWeek,
  toStorage,
  type DayBand,
  type DayPreset,
  type WeekdayKey,
} from '../utils/day-bands.js';
import {
  displayTemp,
  fToC,
  limitsFor,
  parseTempInput,
  unitLabel,
  type LimitField,
  type TempUnit,
} from '../utils/temperature.js';

type OptimizationMode = 'cool' | 'heat' | 'auto' | 'off';

const OPTIMIZATION_MODES: ReadonlyArray<OptimizationMode> = ['cool', 'heat', 'auto', 'off'];

export function modeHelp(mode: string): string {
  if (mode === 'auto') {
    return "Auto switches your thermostat between heat and cool for each day's plan. " +
      'A thermostat you turn off stays off.';
  }
  if (mode === 'off') return 'Hungry Machines leaves this thermostat alone.';
  return "Keep your thermostat in the same mode. If they differ, the thermostat's " +
    'setting wins and the log records an error.';
}

type ErrorMap = Record<string, string>;

const TIME_PATTERN = /^\d{2}:\d{2}$/;
const SCALAR_TEMP_FIELDS = [
  'base_temperature',
  'max_temp_f',
  'min_temp_f',
  'floor_temp_f',
  'sanitize_temp_f',
  'ready_temp_f',
  'eco_temp_f',
] as const;

const MAX_SOAK_ROWS = 4;

interface SoakRow {
  start: string;
  end: string;
  // Index 0 = Monday .. 6 = Sunday, matching WEEKDAY_KEYS order.
  days: boolean[];
}

function newSoakRow(start: string, end: string, days?: boolean[]): SoakRow {
  return { start, end, days: days ?? [true, true, true, true, true, true, true] };
}

function parseSoakWindows(raw: unknown): SoakRow[] {
  if (!Array.isArray(raw) || raw.length === 0) return [newSoakRow('19:00', '21:00')];
  const rows: SoakRow[] = [];
  for (const w of raw.slice(0, MAX_SOAK_ROWS)) {
    if (typeof w !== 'object' || w === null) continue;
    const obj = w as Record<string, unknown>;
    const start = typeof obj['start'] === 'string' ? obj['start'] : '';
    const end = typeof obj['end'] === 'string' ? obj['end'] : '';
    const daysRaw = obj['days'];
    const days = Array.isArray(daysRaw)
      ? WEEKDAY_KEYS.map((_, i) => daysRaw.includes(i))
      : undefined;
    rows.push(newSoakRow(start, end, days));
  }
  return rows.length > 0 ? rows : [newSoakRow('19:00', '21:00')];
}

function soakRowsToPayload(rows: SoakRow[]): Array<{ start: string; end: string; days?: number[] }> {
  return rows.map((row) => {
    const entry: { start: string; end: string; days?: number[] } = {
      start: row.start,
      end: row.end,
    };
    if (!row.days.every(Boolean)) {
      entry.days = row.days
        .map((on, i) => (on ? i : -1))
        .filter((i) => i >= 0)
        .sort((a, b) => a - b);
    }
    return entry;
  });
}

function toNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

const DAY_NAMES: Record<WeekdayKey, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};
const DAY_LETTERS: Record<WeekdayKey, string> = {
  mon: 'M',
  tue: 'T',
  wed: 'W',
  thu: 'T',
  fri: 'F',
  sat: 'S',
  sun: 'S',
};
const PRESET_LABELS: ReadonlyArray<[DayPreset, string]> = [
  ['every', 'Every day'],
  ['weekend', 'Weekdays and weekends'],
  ['each', 'Each day'],
];

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
    .hourly-content {
      margin-top: 8px;
    }
    fieldset.opt-toggles {
      border: 1px solid rgba(100, 116, 139, 0.3);
      border-radius: 8px;
      padding: 12px 14px;
      margin: 0;
    }
    fieldset.opt-toggles legend {
      padding: 0 6px;
      font-weight: 600;
      font-size: 13px;
      color: var(--hm-text, #0F172A);
    }
    .opt-toggles-help {
      margin: 0 0 10px 0;
      font-size: 12px;
      color: var(--hm-muted, #64748B);
    }
    label.opt-toggle {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      font-size: 13px;
      margin-bottom: 8px;
      cursor: pointer;
    }
    label.opt-toggle:last-child {
      margin-bottom: 0;
    }
    label.opt-toggle input {
      width: auto;
      margin-top: 3px;
    }
    label.opt-toggle span {
      line-height: 1.4;
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
    table.hourly-table input.invalid {
      border-color: var(--hm-error, #DC2626);
    }
    .hourly-row-error {
      color: var(--hm-error, #DC2626);
      font-size: 12px;
    }
    .day-modes {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      margin: 6px 0;
      font-size: 13px;
    }
    .day-modes label {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .day-modes input {
      width: auto;
    }
    .day-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin: 6px 0;
    }
    .day-chips button.day-chip {
      padding: 4px 10px;
      background: transparent;
      border: 1px solid var(--hm-muted, #64748B);
      color: var(--hm-text, #0F172A);
    }
    .day-chips button.day-chip[aria-pressed='true'] {
      background: var(--hm-primary, #1E3A8A);
      border-color: var(--hm-primary, #1E3A8A);
      color: #ffffff;
    }
    .day-chips button.day-chip.same:not([aria-pressed='true']) {
      border-style: dashed;
      border-color: var(--hm-primary, #1E3A8A);
    }
    .day-help,
    .day-note {
      margin: 4px 0;
      font-size: 12px;
      color: var(--hm-muted, #64748B);
    }
    .day-copy {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      margin: 6px 0;
      font-size: 13px;
    }
    .day-copy label {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .day-copy input {
      width: auto;
    }
    .day-copy .copy-targets {
      display: contents;
    }
    button.reset-defaults {
      background: transparent;
      border: 1px solid var(--hm-primary, #1E3A8A);
      color: var(--hm-primary, #1E3A8A);
      font-weight: 600;
      margin-top: 4px;
    }
    button.reset-defaults[disabled] {
      opacity: 0.55;
      cursor: not-allowed;
    }
    .reset-note {
      font-size: 12px;
      color: var(--hm-muted, #64748B);
      margin-top: 4px;
    }
    .soak-rows {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .soak-row {
      border: 1px solid rgba(100, 116, 139, 0.3);
      border-radius: 8px;
      padding: 10px 12px;
    }
    .soak-days {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin: 8px 0;
    }
    label.day-toggle {
      display: flex;
      align-items: center;
      gap: 3px;
      font-size: 12px;
      width: auto;
    }
    label.day-toggle input {
      width: auto;
    }
    button.soak-remove {
      background: transparent;
      border: 1px solid var(--hm-error, #DC2626);
      color: var(--hm-error, #DC2626);
      font-size: 12px;
      padding: 4px 10px;
      margin-top: 4px;
    }
  `;

  static override properties = {
    applianceId: { attribute: false },
    applianceType: { attribute: false },
    currentConstraints: { attribute: false },
    temperatureUnit: { attribute: false },
    open: { type: Boolean, reflect: true },
    _values: { state: true },
    _errors: { state: true },
    _topError: { state: true },
    _saving: { state: true },
    _hourlyEnabled: { state: true },
    _hourlyLow: { state: true },
    _hourlyHigh: { state: true },
    _resetting: { state: true },
    _resetError: { state: true },
    _preset: { state: true },
    _sel: { state: true },
    _dayError: { state: true },
    _replaceNote: { state: true },
    _copyOpen: { state: true },
    _copyTargets: { state: true },
    _soakRows: { state: true },
  };

  applianceId = '';
  applianceType: ApplianceType = 'hvac';
  currentConstraints: Record<string, unknown> | undefined = undefined;
  temperatureUnit: TempUnit = 'F';
  open = false;
  _values: Record<string, string> = {};
  _errors: ErrorMap = {};
  _topError: string | null = null;
  _saving = false;
  // Always true for hvac (the hourly table is the primary
  // control, not an opt-in override) — kept as a field rather than
  // inlined so `_validate`/`_buildPayload` read one source of truth.
  _hourlyEnabled = false;
  _hourlyLow: string[] = [];
  _hourlyHigh: string[] = [];
  // Stored °F, and the display strings they rendered as. A cell whose string
  // still equals its seed is untouched and saves the stored °F exactly, so
  // opening in °C never rewrites a value the user did not edit.
  private _hourlyHighF: number[] = [];
  private _hourlyLowF: number[] = [];
  private _seedHigh: string[] = [];
  private _seedLow: string[] = [];
  private _shownUnit: TempUnit = 'F';
  // Same rule for the scalar comfort fields: stored °F and the display string
  // it rendered as, keyed by field name.
  private _scalarF: Record<string, number> = {};
  private _scalarSeed: Record<string, string> = {};
  _resetting = false;
  _resetError: string | null = null;
  // Weekday bands: seven stored-°F days, the preset they group into, and the
  // day whose band the table shows. In 'weekend' the shown keys are mon
  // (Mon-Fri) and sat (Sat-Sun); in 'every' it is always mon.
  private _week = {} as Record<WeekdayKey, DayBand>;
  _preset: DayPreset = 'every';
  _sel: WeekdayKey = 'mon';
  _dayError: string | null = null;
  _replaceNote = false;
  _copyOpen = false;
  _copyTargets: WeekdayKey[] = [];
  _soakRows: SoakRow[] = [newSoakRow('19:00', '21:00')];

  private _lastKey = '';

  /**
   * True once the user has edited ANY field in the currently-open
   * editor. While dirty, a reassignment of `currentConstraints` (the
   * panel's async per-appliance GET landing late) must NOT re-seed the
   * form: doing so silently reverted in-progress edits — worst of all
   * the "Use my hourly bands" uncheck, where Lit's dirty-check left the
   * checkbox LOOKING unchecked while `_hourlyEnabled` flipped back to
   * true, so Save re-sent the custom bands the user just turned off.
   */
  private _dirty = false;

  override willUpdate(changed: Map<string, unknown>): void {
    if (changed.has('temperatureUnit') && this.temperatureUnit !== this._shownUnit) {
      this._onUnitChanged();
    }
    const key = `${this.applianceType}|${this.applianceId}|${this.open ? '1' : '0'}`;
    // The panel opens the editor seeded with a synchronous fallback
    // (the user-level preferences row) and THEN reassigns
    // `currentConstraints` to the per-appliance row once its async GET
    // lands — same applianceId/type/open, so `key` is unchanged. Keying
    // the reseed only on `key` would ignore that second assignment and
    // leave the form showing the stale fallback until a cancel+reopen.
    // So treat a fresh `currentConstraints` reference as its own reset
    // trigger — but only while the form is pristine. Once the user has
    // touched anything (`_dirty`), their in-progress edits win over the
    // late-arriving row.
    const constraintsChanged = changed.has('currentConstraints');
    const shouldReset =
      changed.has('open') ||
      changed.has('applianceId') ||
      changed.has('applianceType') ||
      constraintsChanged;
    if (
      shouldReset &&
      (key !== this._lastKey || (constraintsChanged && !this._dirty))
    ) {
      this._lastKey = key;
      this._values = this._seedValues();
      this._errors = {};
      this._topError = null;
      this._saving = false;
      this._dirty = false;
      this._seedHourlyBands();
    }
  }

  private _seedHourlyBands(): void {
    // The hourly table is the primary control for every appliance type
    // that renders it (hvac only, see render()) — always populated,
    // never gated behind an opt-in toggle.
    this._hourlyEnabled = true;
    this._resetError = null;
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
      this._setHourlyFromF(
        prefsLike.hourly_high_temps_f as number[],
        prefsLike.hourly_low_temps_f as number[],
      );
    } else {
      // No stored hourly override: seed from the local mirror of the
      // shaped default (`deriveHourlyComfortBand`) so a first-time
      // editor shows what the optimizer would actually use rather than
      // a flat placeholder. "Reset to defaults" re-derives this from the
      // live endpoint; this synchronous seed avoids a network round
      // trip just to open the editor.
      this._loadDerivedHourlyBands();
    }
    this._week = expandWeek(c as BandPrefs, { high: this._hourlyHighF, low: this._hourlyLowF });
    this._preset = detectPreset(this._week);
    this._sel = 'mon';
    this._dayError = null;
    this._replaceNote = false;
    this._copyOpen = false;
    this._copyTargets = [];
    this._setHourlyFromF(this._week.mon.high, this._week.mon.low);
  }

  /** The shown cells as a °F band; untouched cells keep their exact stored °F. */
  private _shownBand(loose: boolean): DayBand | null {
    const base = this._week[this._sel];
    const high: number[] = [];
    const low: number[] = [];
    for (let i = 0; i < 24; i++) {
      const h = this._hourlyCellF(this._hourlyHigh, this._seedHigh, this._hourlyHighF, i).f;
      const l = this._hourlyCellF(this._hourlyLow, this._seedLow, this._hourlyLowF, i).f;
      if ((h === null || l === null) && !loose) return null;
      high.push(h ?? base?.high[i] ?? 0);
      low.push(l ?? base?.low[i] ?? 0);
    }
    return { high, low };
  }

  /** The week with the shown band written into the day(s) the shown chip stands for. */
  private _weekWith(band: DayBand): Record<WeekdayKey, DayBand> {
    const week = { ...this._week };
    const keys: WeekdayKey[] =
      this._preset === 'every'
        ? [...WEEKDAY_KEYS]
        : this._preset === 'weekend'
          ? this._sel === 'mon'
            ? ['mon', 'tue', 'wed', 'thu', 'fri']
            : ['sat', 'sun']
          : [this._sel];
    for (const k of keys) week[k] = { high: [...band.high], low: [...band.low] };
    return week;
  }

  /** Write the shown cells back into the week. False (and a message) when they have errors. */
  private _commitShown(): boolean {
    const hasErr = Object.keys(this._validate(this._values)).some((k) => k.startsWith('hourly_'));
    const band = hasErr ? null : this._shownBand(false);
    if (!band) {
      this._dayError = "Fix this day's errors first.";
      this._errors = this._validate(this._values);
      return false;
    }
    this._week = this._weekWith(band);
    this._dayError = null;
    return true;
  }

  private _showDay(key: WeekdayKey): void {
    this._sel = key;
    this._setHourlyFromF(this._week[key].high, this._week[key].low);
    this._errors = this._validate(this._values);
  }

  private _onSelectDay(key: WeekdayKey): void {
    if (key === this._sel || !this._commitShown()) return;
    this._copyOpen = false;
    this._showDay(key);
  }

  private _onSetPreset(next: DayPreset): void {
    if (next === this._preset || !this._commitShown()) return;
    const w = this._week;
    const prev = this._preset;
    let replaced = false;
    let sel: WeekdayKey = 'mon';
    if (next === 'every') {
      const shown = w[this._sel];
      replaced = !WEEKDAY_KEYS.every((k) => bandsEqual(w[k], shown));
      for (const k of WEEKDAY_KEYS) w[k] = { high: [...shown.high], low: [...shown.low] };
      sel = 'mon';
    } else if (next === 'weekend' && prev === 'each') {
      replaced =
        !(['tue', 'wed', 'thu', 'fri'] as const).every((k) => bandsEqual(w[k], w.mon)) ||
        !bandsEqual(w.sun, w.sat);
      for (const k of ['tue', 'wed', 'thu', 'fri'] as const) w[k] = { high: [...w.mon.high], low: [...w.mon.low] };
      w.sun = { high: [...w.sat.high], low: [...w.sat.low] };
    } else if (next === 'each') {
      sel = this._sel;
    }
    this._dirty = true;
    this._preset = next;
    this._copyOpen = false;
    this._replaceNote = this._replaceNote || replaced;
    this._week = { ...w };
    this._showDay(sel);
  }

  private _onCopyDay(): void {
    if (!this._commitShown()) return;
    const src = this._week[this._sel];
    const week = { ...this._week };
    for (const k of this._copyTargets) {
      if (k !== this._sel) week[k] = { high: [...src.high], low: [...src.low] };
    }
    this._week = week;
    this._dirty = true;
    this._copyOpen = false;
    this._copyTargets = [];
  }

  private _setSoakField(i: number, field: 'start' | 'end', value: string): void {
    this._dirty = true;
    this._soakRows = this._soakRows.map((row, idx) =>
      idx === i ? { ...row, [field]: value } : row,
    );
    this._errors = this._validate(this._values);
  }

  private _setSoakDay(i: number, dayIndex: number, checked: boolean): void {
    this._dirty = true;
    this._soakRows = this._soakRows.map((row, idx) => {
      if (idx !== i) return row;
      const days = [...row.days];
      days[dayIndex] = checked;
      return { ...row, days };
    });
    this._errors = this._validate(this._values);
  }

  private _addSoakRow(): void {
    if (this._soakRows.length >= MAX_SOAK_ROWS) return;
    this._dirty = true;
    this._soakRows = [...this._soakRows, newSoakRow('', '')];
    this._errors = this._validate(this._values);
  }

  private _removeSoakRow(i: number): void {
    if (this._soakRows.length <= 1) return;
    this._dirty = true;
    this._soakRows = this._soakRows.filter((_, idx) => idx !== i);
    this._errors = this._validate(this._values);
  }

  /**
   * Replace `_hourlyHigh` / `_hourlyLow` with the band derived from the
   * legacy preference fields (base_temperature, savings_level, time_away,
   * time_home, optimization_mode). Used when seeding a fresh editor and
   * when the user unchecks the "use my hourly bands" override.
   *
   * Reads from the live `_values` so user edits already in the form
   * (e.g. they bumped savings_level before unchecking) propagate
   * immediately. Source-of-truth derivation lives in
   * `app/services/comfort.py: build_comfort_band` on the backend; the
   * frontend mirror is in `src/utils/hourly.ts: deriveHourlyComfortBand`.
   */
  private _loadDerivedHourlyBands(): void {
    if (this.applianceType !== 'hvac') {
      this._setHourlyFromF(
        Array.from({ length: 24 }, () => 76),
        Array.from({ length: 24 }, () => 68),
      );
      return;
    }
    const v = this._values;
    const fallback = (this.currentConstraints ?? {}) as Record<string, unknown>;
    const baseStr = (v['base_temperature'] ?? '').toString().trim();
    const savingsStr = (v['savings_level'] ?? '').toString().trim();
    const baseNum = baseStr === '' ? toNumber(fallback['base_temperature']) : Number(baseStr);
    const savingsNum =
      savingsStr === '' ? toNumber(fallback['savings_level']) : Number(savingsStr);
    const modeStr =
      (v['optimization_mode'] ?? toString(fallback['optimization_mode']) ?? 'auto').toString();
    const timeAway = (v['time_away'] ?? toString(fallback['time_away']) ?? '08:00').toString() || '08:00';
    const timeHome = (v['time_home'] ?? toString(fallback['time_home']) ?? '17:00').toString() || '17:00';
    const mode: ComfortMode =
      modeStr === 'cool' || modeStr === 'heat' || modeStr === 'auto'
        ? (modeStr as ComfortMode)
        : 'auto';
    const { high, low } = deriveHourlyComfortBand({
      base_temperature: Number.isFinite(baseNum as number) ? (baseNum as number) : 72,
      // Inert since 2026-10-02 (one default band for every surface), but
      // default to 1 to match the API's DEFAULTS and the DB column, not 3.
      savings_level: Number.isFinite(savingsNum as number) ? (savingsNum as number) : 1,
      time_away: timeAway,
      time_home: timeHome,
      mode,
    });
    this._setHourlyFromF(high, low);
  }

  /** Load a °F band: keep the stored values and render the display strings. */
  private _setHourlyFromF(high: number[], low: number[]): void {
    const unit = this.temperatureUnit;
    this._shownUnit = unit;
    this._hourlyHighF = [...high];
    this._hourlyLowF = [...low];
    this._seedHigh = high.map((n) => displayTemp(n, unit));
    this._seedLow = low.map((n) => displayTemp(n, unit));
    this._hourlyHigh = [...this._seedHigh];
    this._hourlyLow = [...this._seedLow];
  }

  /**
   * The unit changed while the editor is open. Untouched cells reseed from
   * the stored °F; edited cells convert to the new unit and stay edited.
   */
  private _onUnitChanged(): void {
    const from = this._shownUnit;
    const to = this.temperatureUnit;
    const oldHigh = this._hourlyHigh;
    const oldLow = this._hourlyLow;
    const oldSeedHigh = this._seedHigh;
    const oldSeedLow = this._seedLow;
    const highF = this._hourlyHighF;
    const lowF = this._hourlyLowF;
    this._shownUnit = to;
    this._seedHigh = highF.map((n) => displayTemp(n, to));
    this._seedLow = lowF.map((n) => displayTemp(n, to));
    const convert = (cur: string, seed: string, seedNew: string): string => {
      if (cur === seed) return seedNew;
      const f = parseTempInput(cur, from);
      return f === null ? cur : displayTemp(f, to);
    };
    this._hourlyHigh = oldHigh.map((c, i) => convert(c, oldSeedHigh[i] ?? '', this._seedHigh[i] ?? ''));
    this._hourlyLow = oldLow.map((c, i) => convert(c, oldSeedLow[i] ?? '', this._seedLow[i] ?? ''));
    const values = { ...this._values };
    for (const name of SCALAR_TEMP_FIELDS) {
      const stored = this._scalarF[name];
      if (stored === undefined || values[name] === undefined) continue;
      const oldSeed = this._scalarSeed[name] ?? '';
      const newSeed = this._scalarDisplay(name, stored, to);
      this._scalarSeed[name] = newSeed;
      const cur = values[name] ?? '';
      if (cur === oldSeed) {
        values[name] = newSeed;
      } else {
        const f = parseTempInput(cur, from);
        if (f !== null) values[name] = this._scalarDisplay(name, f, to);
      }
    }
    this._values = values;
    // An edited cell that converted may now equal the new seed; it is then
    // untouched, and saves the stored value. A real edit keeps its text.
    if (Object.keys(this._errors).length > 0) this._errors = this._validate(this._values);
  }

  /** Water heater values show as whole degrees; the rest to the nearest 0.5. */
  private _scalarDisplay(name: string, f: number, unit: TempUnit): string {
    if (unit === 'C' && name !== 'base_temperature') return String(Math.round(fToC(f)));
    return displayTemp(f, unit);
  }

  /** The °F a scalar field saves: the stored value while untouched, else the parsed text. */
  private _scalarCellF(name: string): { f: number | null; edited: boolean } {
    const cur = this._values[name] ?? '';
    const stored = this._scalarF[name];
    if (stored !== undefined && cur === (this._scalarSeed[name] ?? '')) {
      return { f: stored, edited: false };
    }
    return { f: parseTempInput(cur, this.temperatureUnit), edited: true };
  }

  private _seedScalars(values: Record<string, string>, raw: Record<string, number | null>): Record<string, string> {
    const unit = this.temperatureUnit;
    this._scalarF = {};
    this._scalarSeed = {};
    const out = { ...values };
    for (const name of SCALAR_TEMP_FIELDS) {
      const f = raw[name];
      if (f === null || f === undefined) continue;
      this._scalarF[name] = f;
      this._scalarSeed[name] = this._scalarDisplay(name, f, unit);
      out[name] = this._scalarSeed[name] as string;
    }
    return out;
  }

  private _hourlyCellF(
    display: string[],
    seed: string[],
    storedF: number[],
    i: number,
  ): { f: number | null; edited: boolean } {
    const cur = display[i] ?? '';
    if (cur === (seed[i] ?? '') && storedF[i] !== undefined) {
      return { f: storedF[i] as number, edited: false };
    }
    return { f: parseTempInput(cur, this.temperatureUnit), edited: true };
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
      case 'water_heater': {
        const floor = toNumber((c as Record<string, unknown>)['floor_temp_f']);
        const sanitizeTemp = toNumber((c as Record<string, unknown>)['sanitize_temp_f']);
        const sanitizeEnabledRaw = (c as Record<string, unknown>)['sanitize_enabled'];
        const sanitizeHold = toNumber((c as Record<string, unknown>)['sanitize_hold_minutes']);
        const sanitizeDays = toNumber((c as Record<string, unknown>)['sanitize_interval_days']);
        return this._seedScalars(
          {
            max_temp_f: s('max_temp_f'),
            min_temp_f: s('min_temp_f'),
            sanitize_enabled: sanitizeEnabledRaw === false ? '' : '1',
            sanitize_hold_minutes: sanitizeHold === null ? '60' : String(sanitizeHold),
            sanitize_interval_days: sanitizeDays === null ? '2' : String(sanitizeDays),
          },
          {
            max_temp_f: toNumber((c as Record<string, unknown>)['max_temp_f']),
            min_temp_f: toNumber((c as Record<string, unknown>)['min_temp_f']),
            floor_temp_f: floor === null ? 120 : floor,
            sanitize_temp_f: sanitizeTemp === null ? 140 : sanitizeTemp,
          },
        );
      }
      case 'robot':
        // Defaults mirror the backend's own fallbacks (_optimize_robot in
        // nightly.py) so a first-time editor shows the same plan the
        // optimizer would already assume, not blank fields.
        return {
          target_charge_pct: s('target_charge_pct') || '90',
          min_charge_pct: s('min_charge_pct') || '25',
          current_charge_pct: s('current_charge_pct') || '50',
          tasks_window_start: s('tasks_window_start') || '09:00',
          tasks_window_end: s('tasks_window_end') || '17:00',
        };
      case 'pool_pump':
        // Defaults mirror the backend's own fallbacks
        // (_pool_pump_plan_inputs in nightly.py).
        return {
          run_hours: s('run_hours') || '8',
          window_start: s('window_start') || '08:00',
          window_end: s('window_end') || '20:00',
        };
      case 'hot_tub': {
        const ready = toNumber((c as Record<string, unknown>)['ready_temp_f']);
        const eco = toNumber((c as Record<string, unknown>)['eco_temp_f']);
        this._soakRows = parseSoakWindows((c as Record<string, unknown>)['soak_windows']);
        return this._seedScalars(
          {},
          {
            ready_temp_f: ready === null ? 102 : ready,
            eco_temp_f: eco === null ? 95 : eco,
          },
        );
      }
      case 'hvac':
      default: {
        const base = toNumber((c as Record<string, unknown>)['base_temperature']);
        const savings = toNumber((c as Record<string, unknown>)['savings_level']);
        const mode = toString((c as Record<string, unknown>)['optimization_mode']);
        const timeAway = toString((c as Record<string, unknown>)['time_away']);
        const timeHome = toString((c as Record<string, unknown>)['time_home']);
        // Phase C/D opt-ins. Default both off so existing users see no
        // behavior change unless they explicitly tick the box.
        const optFan = (c as Record<string, unknown>)['optimize_hvac_fan'];
        const optMode = (c as Record<string, unknown>)['optimize_hvac_mode'];
        // Per-appliance pause switch. Default ON so
        // a missing field on legacy callers doesn't accidentally pause
        // the appliance — the editor only saves false when the user
        // explicitly unchecks the box.
        const optEnabledRaw = (c as Record<string, unknown>)['optimization_enabled'];
        const optEnabled = optEnabledRaw === false ? '' : '1';
        return this._seedScalars({
          base_temperature: base === null ? '72' : String(base),
          savings_level: savings === null ? '1' : String(savings),
          optimization_mode: (OPTIMIZATION_MODES as ReadonlyArray<string>).includes(mode)
            ? mode
            : 'auto',
          time_away: timeAway,
          time_home: timeHome,
          optimize_hvac_fan: optFan === true ? '1' : '',
          optimize_hvac_mode: optMode === true ? '1' : '',
          optimization_enabled: optEnabled,
        }, { base_temperature: base === null ? 72 : base });
      }
    }
  }

  private _setValue(name: string, value: string): void {
    this._dirty = true;
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
    const reqTemp = (name: string, field: LimitField = 'water_heater') => {
      const raw = values[name] ?? '';
      if (raw === '') {
        errors[name] = 'Required';
        return null;
      }
      if (!this._scalarCellF(name).edited) return this._scalarCellF(name).f;
      const lim = limitsFor(field, this.temperatureUnit);
      const n = Number(raw);
      if (!Number.isFinite(n) || n < lim.min || n > lim.max) {
        errors[name] = `Must be ${lim.min}–${lim.max}`;
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
    const reqTempRange = (name: string, minF: number, maxF: number): number | null => {
      const raw = values[name] ?? '';
      if (raw === '') {
        errors[name] = 'Required';
        return null;
      }
      if (!this._scalarCellF(name).edited) return this._scalarCellF(name).f;
      const f = parseTempInput(raw, this.temperatureUnit);
      if (f === null || f < minF || f > maxF) {
        errors[name] =
          `Must be ${displayTemp(minF, this.temperatureUnit)}–${displayTemp(maxF, this.temperatureUnit)}`;
        return null;
      }
      return f;
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
        let maxT = reqTemp('max_temp_f');
        let minT = reqTemp('min_temp_f');
        if (
          maxT !== null &&
          minT !== null &&
          (this._scalarCellF('max_temp_f').edited || this._scalarCellF('min_temp_f').edited)
        ) {
          // Compare what the user sees, not the converted °F.
          maxT = Number(values['max_temp_f']);
          minT = Number(values['min_temp_f']);
        }
        if (maxT !== null && minT !== null && minT >= maxT) {
          errors['min_temp_f'] = 'Must be less than max';
        }
        reqTemp('floor_temp_f', 'water_heater_floor');
        reqTemp('sanitize_temp_f', 'water_heater_sanitize');
        const holdRaw = values['sanitize_hold_minutes'] ?? '';
        if (holdRaw === '') {
          errors['sanitize_hold_minutes'] = 'Required';
        } else {
          const n = Number(holdRaw);
          if (!Number.isFinite(n) || n < 30 || n > 180) {
            errors['sanitize_hold_minutes'] = 'Must be 30–180';
          }
        }
        const daysRaw = values['sanitize_interval_days'] ?? '';
        if (daysRaw === '') {
          errors['sanitize_interval_days'] = 'Required';
        } else {
          const n = Number(daysRaw);
          if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 14) {
            errors['sanitize_interval_days'] = 'Must be a whole number 1–14';
          }
        }
        break;
      }
      case 'robot': {
        const target = reqPct('target_charge_pct');
        const min = reqPct('min_charge_pct');
        reqPct('current_charge_pct');
        reqTime('tasks_window_start');
        reqTime('tasks_window_end');
        if (target !== null && min !== null && min >= target) {
          errors['min_charge_pct'] = 'Must be less than target';
        }
        const start = values['tasks_window_start'] ?? '';
        const end = values['tasks_window_end'] ?? '';
        if (
          start !== '' &&
          end !== '' &&
          TIME_PATTERN.test(start) &&
          TIME_PATTERN.test(end) &&
          start === end
        ) {
          errors['tasks_window_end'] = 'Must differ from start';
        }
        break;
      }
      case 'pool_pump': {
        const hoursRaw = values['run_hours'] ?? '';
        let hours: number | null = null;
        if (hoursRaw === '') {
          errors['run_hours'] = 'Required';
        } else {
          const n = Number(hoursRaw);
          if (!Number.isFinite(n) || n < 0.5 || n > 24) {
            errors['run_hours'] = 'Must be 0.5–24';
          } else {
            hours = n;
          }
        }
        reqTime('window_start');
        reqTime('window_end');
        const pStart = values['window_start'] ?? '';
        const pEnd = values['window_end'] ?? '';
        if (
          pStart !== '' &&
          pEnd !== '' &&
          TIME_PATTERN.test(pStart) &&
          TIME_PATTERN.test(pEnd)
        ) {
          const [sh, sm] = pStart.split(':').map(Number);
          const [eh, em] = pEnd.split(':').map(Number);
          const startMin = sh * 60 + sm;
          const endMin = eh * 60 + em;
          if (startMin >= endMin) {
            errors['window_end'] = 'Must be after start';
          } else if (hours !== null && hours > (endMin - startMin) / 60) {
            errors['run_hours'] = 'The window is shorter than the run time';
          }
        }
        break;
      }
      case 'hot_tub': {
        let ready = reqTempRange('ready_temp_f', 80, 104);
        let eco = reqTempRange('eco_temp_f', 50, 104);
        if (
          ready !== null &&
          eco !== null &&
          (this._scalarCellF('ready_temp_f').edited || this._scalarCellF('eco_temp_f').edited)
        ) {
          ready = Number(values['ready_temp_f']);
          eco = Number(values['eco_temp_f']);
        }
        if (ready !== null && eco !== null && eco > ready) {
          errors['eco_temp_f'] = 'Must be at or below ready';
        }
        this._soakRows.forEach((row, i) => {
          const startKey = `soak_start_${i}`;
          const endKey = `soak_end_${i}`;
          if (row.start === '') {
            errors[startKey] = 'Required';
          } else if (!TIME_PATTERN.test(row.start)) {
            errors[startKey] = 'Use HH:MM';
          }
          if (row.end === '') {
            errors[endKey] = 'Required';
          } else if (!TIME_PATTERN.test(row.end)) {
            errors[endKey] = 'Use HH:MM';
          }
          if (TIME_PATTERN.test(row.start) && TIME_PATTERN.test(row.end)) {
            const [sh, sm] = row.start.split(':').map(Number);
            const [eh, em] = row.end.split(':').map(Number);
            if (sh * 60 + sm >= eh * 60 + em) {
              errors[endKey] = 'Must be after start';
            }
          }
          if (!row.days.some(Boolean)) {
            errors[`soak_days_${i}`] = 'Pick at least one day';
          }
        });
        break;
      }
      case 'hvac': {
        const baseRaw = values['base_temperature'] ?? '';
        const baseCell = this._scalarCellF('base_temperature');
        if (baseRaw.trim() === '' || !Number.isFinite(Number(baseRaw))) {
          errors['base_temperature'] = 'Required';
        } else if (baseCell.edited) {
          const bl = limitsFor('base', this.temperatureUnit);
          const bn = Number(baseRaw);
          if (bn < bl.min || bn > bl.max) {
            errors['base_temperature'] = `Must be ${bl.min}–${bl.max} ${unitLabel(this.temperatureUnit)}`;
          }
        }
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
            const lim = limitsFor('hourly', this.temperatureUnit);
            const rangeMsg = `Must be ${lim.min}–${lim.max} ${unitLabel(this.temperatureUnit)}`;
            const lowCell = this._hourlyCellF(this._hourlyLow, this._seedLow, this._hourlyLowF, i);
            const highCell = this._hourlyCellF(this._hourlyHigh, this._seedHigh, this._hourlyHighF, i);
            const inRange = (raw: string) => {
              const n = Number(raw);
              return raw.trim() !== '' && Number.isFinite(n) && n >= lim.min && n <= lim.max;
            };
            // Range applies to edited cells only; a stored 50 or 90 °F that
            // rounds just outside the display range must not block save.
            const lowOk = lowCell.edited ? inRange(this._hourlyLow[i] ?? '') : lowCell.f !== null;
            const highOk = highCell.edited ? inRange(this._hourlyHigh[i] ?? '') : highCell.f !== null;
            if (!lowOk) errors[`hourly_low_${i}`] = rangeMsg;
            if (!highOk) errors[`hourly_high_${i}`] = rangeMsg;
            if (lowOk && highOk) {
              // Edited rows compare what the user sees; untouched rows compare
              // the stored °F, where display rounding could tie two values.
              const rowEdited = lowCell.edited || highCell.edited;
              const low = rowEdited ? Number(this._hourlyLow[i]) : (lowCell.f as number);
              const high = rowEdited ? Number(this._hourlyHigh[i]) : (highCell.f as number);
              if (low >= high) errors[`hourly_row_${i}`] = 'High must be greater than low';
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
          max_temp_f: this._scalarCellF('max_temp_f').f,
          min_temp_f: this._scalarCellF('min_temp_f').f,
          floor_temp_f: this._scalarCellF('floor_temp_f').f,
          sanitize_enabled: v['sanitize_enabled'] === '1',
          sanitize_temp_f: this._scalarCellF('sanitize_temp_f').f,
          sanitize_hold_minutes: Number(v['sanitize_hold_minutes']),
          sanitize_interval_days: Number(v['sanitize_interval_days']),
        };
      case 'robot':
        return {
          target_charge_pct: Number(v['target_charge_pct']),
          min_charge_pct: Number(v['min_charge_pct']),
          current_charge_pct: Number(v['current_charge_pct']),
          tasks_window_start: v['tasks_window_start'] ?? '',
          tasks_window_end: v['tasks_window_end'] ?? '',
        };
      case 'pool_pump':
        return {
          run_hours: Number(v['run_hours']),
          window_start: v['window_start'] ?? '',
          window_end: v['window_end'] ?? '',
        };
      case 'hot_tub':
        return {
          ready_temp_f: this._scalarCellF('ready_temp_f').f,
          eco_temp_f: this._scalarCellF('eco_temp_f').f,
          soak_windows: soakRowsToPayload(this._soakRows),
        };
      case 'hvac':
      default: {
        const payload: Record<string, unknown> = {
          base_temperature: this._scalarCellF('base_temperature').f,
          savings_level: Number(v['savings_level']),
          optimization_mode: (v['optimization_mode'] ?? 'auto') as OptimizationMode,
          optimize_hvac_fan: v['optimize_hvac_fan'] === '1',
          optimize_hvac_mode: v['optimize_hvac_mode'] === '1',
          // Per-appliance pause switch. Always send
          // explicit booleans so a paused unit can be re-enabled by
          // checking the box and saving — exclude_unset on the server
          // would otherwise drop a clear-back-to-true PUT.
          optimization_enabled: v['optimization_enabled'] === '1',
        };
        const timeAway = v['time_away'] ?? '';
        if (timeAway !== '') payload['time_away'] = timeAway;
        const timeHome = v['time_home'] ?? '';
        if (timeHome !== '') payload['time_home'] = timeHome;
        // Hourly limits are always the saved comfort band —
        // the table is the primary control, not an opt-in override.
        const shown = this._shownBand(true) as DayBand;
        Object.assign(payload, toStorage(this._preset, this._weekWith(shown)));
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
        // Per-HVAC preferences: each registered HVAC
        // carries its own appliance_preferences row, so the save path
        // is keyed on this.applianceId and never touches the user-level
        // /api/v1/preferences endpoint. Two HVACs editing in succession
        // hold and persist independent values.
        await updateAppliancePreferences(this.applianceId, payload);
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

  /**
   * Re-fetch the shaped default band from the live
   * `/preferences/default-bands` endpoint, using whatever the user has
   * typed into base temperature / savings level / time away / time home
   * so far (not necessarily the saved row), and fill the hourly table
   * with it. Falls back to the local mirror (`deriveHourlyComfortBand`
   * via `_loadDerivedHourlyBands`) and says so inline when the request
   * fails — the table is never left empty.
   */
  private async _onResetDefaults(): Promise<void> {
    this._dirty = true;
    this._resetting = true;
    this._resetError = null;
    const v = this._values;
    const baseNum = this._scalarCellF('base_temperature').f;
    const savingsNum = toNumber(v['savings_level']);
    const modeStr = v['optimization_mode'] ?? 'auto';
    const mode =
      modeStr === 'cool' || modeStr === 'heat' || modeStr === 'auto' ? modeStr : undefined;
    const timeAway = v['time_away'] || undefined;
    const timeHome = v['time_home'] || undefined;
    try {
      const result = await fetchDefaultBands(this.applianceId, {
        base_temperature: baseNum ?? undefined,
        savings_level: savingsNum ?? undefined,
        time_away: timeAway,
        time_home: timeHome,
        optimization_mode: mode,
      });
      this._setHourlyFromF(result.hourly_high_temps_f, result.hourly_low_temps_f);
    } catch {
      this._loadDerivedHourlyBands();
      this._resetError = 'Could not reach the server — showing the built-in defaults.';
    } finally {
      this._resetting = false;
      this._errors = this._validate(this._values);
    }
  }

  private _onCancel(): void {
    this.open = false;
    this.dispatchEvent(
      new CustomEvent('constraints-cancelled', { bubbles: true, composed: true }),
    );
  }

  private _renderDays() {
    const preset = this._preset;
    const sel = this._sel;
    const live = this._shownBand(true) as DayBand;
    const chips: Array<[WeekdayKey, string, string]> =
      preset === 'weekend'
        ? [
            ['mon', 'Mon–Fri', 'Monday to Friday'],
            ['sat', 'Sat–Sun', 'Saturday and Sunday'],
          ]
        : preset === 'each'
          ? WEEKDAY_KEYS.map((k): [WeekdayKey, string, string] => [k, DAY_LETTERS[k], DAY_NAMES[k]])
          : [];
    return html`
      <div class="days" data-region="days">
        <div class="day-modes" role="radiogroup" aria-label="Days">
          ${PRESET_LABELS.map(
            ([id, label]) => html`
              <label>
                <input
                  type="radio"
                  name="day_preset"
                  value=${id}
                  .checked=${preset === id}
                  @change=${() => this._onSetPreset(id)}
                />
                ${label}
              </label>
            `,
          )}
        </div>
        ${chips.length
          ? html`<div class="day-chips" role="group" aria-label="Day">
              ${chips.map(
                ([k, label, full]) => html`
                  <button
                    type="button"
                    class="day-chip ${k !== sel && bandsEqual(this._week[k], live) ? 'same' : ''}"
                    data-day=${k}
                    aria-label=${full}
                    aria-pressed=${k === sel ? 'true' : 'false'}
                    @click=${() => this._onSelectDay(k)}
                  >
                    ${label}
                  </button>
                `,
              )}
            </div>`
          : null}
        <p class="day-help">Days run midnight to midnight.</p>
        ${this._dayError ? html`<div class="field-error" data-region="day-error">${this._dayError}</div>` : null}
        ${this._replaceNote
          ? html`<p class="day-note" data-region="day-note">Days with their own band will be replaced when you save.</p>`
          : null}
        ${preset === 'each'
          ? html`<div class="day-copy">
              <button
                type="button"
                class="reset-defaults copy-toggle"
                @click=${() => {
                  this._copyOpen = !this._copyOpen;
                }}
              >
                Copy this day to…
              </button>
              ${this._copyOpen
                ? html`<span class="copy-targets">${WEEKDAY_KEYS.filter((k) => k !== sel).map(
                      (k) => html`
                        <label>
                          <input
                            type="checkbox"
                            name="copy_${k}"
                            .checked=${this._copyTargets.includes(k)}
                            @change=${(e: Event) => {
                              const on = (e.target as HTMLInputElement).checked;
                              this._copyTargets = on
                                ? [...this._copyTargets, k]
                                : this._copyTargets.filter((x) => x !== k);
                            }}
                          />
                          ${DAY_NAMES[k]}
                        </label>
                      `,
                    )}</span>
                    <button type="button" class="copy-go" @click=${() => this._onCopyDay()}>Copy</button>`
                : null}
            </div>`
          : null}
      </div>
    `;
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
      this._dirty = true;
      const next = [...this._hourlyLow];
      next[i] = (e.target as HTMLInputElement).value;
      this._hourlyLow = next;
      this._errors = this._validate(this._values);
    };
    const onHourlyHigh = (i: number) => (e: Event) => {
      this._dirty = true;
      const next = [...this._hourlyHigh];
      next[i] = (e.target as HTMLInputElement).value;
      this._hourlyHigh = next;
      this._errors = this._validate(this._values);
    };
    const onResetDefaults = () => {
      void this._onResetDefaults();
    };
    const unit = this.temperatureUnit;
    const hLim = limitsFor('hourly', unit);
    const wLim = limitsFor('water_heater', unit);
    const floorLim = limitsFor('water_heater_floor', unit);
    const sanitizeLim = limitsFor('water_heater_sanitize', unit);
    const hotTubLim = limitsFor('hot_tub', unit);
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
            : type === 'robot'
              ? 'Home robot constraints'
              : type === 'pool_pump'
                ? 'Pool pump schedule'
                : type === 'hot_tub'
                  ? 'Hot tub constraints'
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
                  <span class="label-text">Max temperature (${unitLabel(unit)})</span>
                  <input
                    name="max_temp_f"
                    type="number"
                    min=${wLim.min}
                    max=${wLim.max}
                    step=${wLim.step}
                    .value=${v['max_temp_f'] ?? ''}
                    @input=${onNum('max_temp_f')}
                  />
                  ${errs['max_temp_f']
                    ? html`<div class="field-error">${errs['max_temp_f']}</div>`
                    : null}
                </label>
                <label>
                  <span class="label-text">Min temperature (${unitLabel(unit)})</span>
                  <input
                    name="min_temp_f"
                    type="number"
                    min=${wLim.min}
                    max=${wLim.max}
                    step=${wLim.step}
                    .value=${v['min_temp_f'] ?? ''}
                    @input=${onNum('min_temp_f')}
                  />
                  ${errs['min_temp_f']
                    ? html`<div class="field-error">${errs['min_temp_f']}</div>`
                    : null}
                </label>
                <label>
                  <span class="label-text">Never plan below (${unitLabel(unit)})</span>
                  <input
                    name="floor_temp_f"
                    type="number"
                    min=${floorLim.min}
                    max=${floorLim.max}
                    step=${floorLim.step}
                    .value=${v['floor_temp_f'] ?? ''}
                    @input=${onNum('floor_temp_f')}
                  />
                  ${errs['floor_temp_f']
                    ? html`<div class="field-error">${errs['floor_temp_f']}</div>`
                    : null}
                </label>
                <label class="opt-toggle">
                  <input
                    name="sanitize_enabled"
                    type="checkbox"
                    .checked=${v['sanitize_enabled'] === '1'}
                    @change=${(e: Event) =>
                      this._setValue(
                        'sanitize_enabled',
                        (e.target as HTMLInputElement).checked ? '1' : '',
                      )}
                  />
                  <span>Heat the tank on a schedule</span>
                </label>
                <p class="opt-toggles-help">
                  Heats the tank to this temperature and holds it. Your
                  tank's own thermostat must be set at least this high,
                  and a mixing valve at the tank keeps tap water from
                  scalding. Health agencies advise storing hot water at
                  140 °F (60 °C).
                </p>
                <label>
                  <span class="label-text">Cycle temperature (${unitLabel(unit)})</span>
                  <input
                    name="sanitize_temp_f"
                    type="number"
                    min=${sanitizeLim.min}
                    max=${sanitizeLim.max}
                    step=${sanitizeLim.step}
                    .value=${v['sanitize_temp_f'] ?? ''}
                    @input=${onNum('sanitize_temp_f')}
                  />
                  ${errs['sanitize_temp_f']
                    ? html`<div class="field-error">${errs['sanitize_temp_f']}</div>`
                    : null}
                </label>
                <label>
                  <span class="label-text">Hold for (minutes)</span>
                  <input
                    name="sanitize_hold_minutes"
                    type="number"
                    min="30"
                    max="180"
                    step="1"
                    .value=${v['sanitize_hold_minutes'] ?? ''}
                    @input=${onNum('sanitize_hold_minutes')}
                  />
                  ${errs['sanitize_hold_minutes']
                    ? html`<div class="field-error">${errs['sanitize_hold_minutes']}</div>`
                    : null}
                </label>
                <label>
                  <span class="label-text">Every (days)</span>
                  <input
                    name="sanitize_interval_days"
                    type="number"
                    min="1"
                    max="14"
                    step="1"
                    .value=${v['sanitize_interval_days'] ?? ''}
                    @input=${onNum('sanitize_interval_days')}
                  />
                  ${errs['sanitize_interval_days']
                    ? html`<div class="field-error">${errs['sanitize_interval_days']}</div>`
                    : null}
                </label>
              `
            : null}
          ${type === 'robot'
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
                <p class="opt-toggles-help">
                  Your robot runs its own tasks in this window; charging is
                  scheduled around it.
                </p>
                <label>
                  <span class="label-text">Tasks window start (HH:MM)</span>
                  <input
                    name="tasks_window_start"
                    type="text"
                    inputmode="numeric"
                    placeholder="09:00"
                    pattern="\\d{2}:\\d{2}"
                    .value=${v['tasks_window_start'] ?? ''}
                    @input=${onNum('tasks_window_start')}
                  />
                  ${errs['tasks_window_start']
                    ? html`<div class="field-error">${errs['tasks_window_start']}</div>`
                    : null}
                </label>
                <label>
                  <span class="label-text">Tasks window end (HH:MM)</span>
                  <input
                    name="tasks_window_end"
                    type="text"
                    inputmode="numeric"
                    placeholder="17:00"
                    pattern="\\d{2}:\\d{2}"
                    .value=${v['tasks_window_end'] ?? ''}
                    @input=${onNum('tasks_window_end')}
                  />
                  ${errs['tasks_window_end']
                    ? html`<div class="field-error">${errs['tasks_window_end']}</div>`
                    : null}
                </label>
              `
            : null}
          ${type === 'pool_pump'
            ? html`
                <p class="opt-toggles-help">
                  The pump runs for this long each day, in the lowest-cost
                  half hours inside the window you allow. Change either
                  whenever you like.
                </p>
                <label>
                  <span class="label-text">Run time per day (hours)</span>
                  <input
                    name="run_hours"
                    type="number"
                    min="0.5"
                    max="24"
                    step="0.5"
                    .value=${v['run_hours'] ?? ''}
                    @input=${onNum('run_hours')}
                  />
                  ${errs['run_hours']
                    ? html`<div class="field-error">${errs['run_hours']}</div>`
                    : null}
                </label>
                <label>
                  <span class="label-text">Allowed from (HH:MM)</span>
                  <input
                    name="window_start"
                    type="text"
                    inputmode="numeric"
                    placeholder="08:00"
                    pattern="\\d{2}:\\d{2}"
                    .value=${v['window_start'] ?? ''}
                    @input=${onNum('window_start')}
                  />
                  ${errs['window_start']
                    ? html`<div class="field-error">${errs['window_start']}</div>`
                    : null}
                </label>
                <label>
                  <span class="label-text">Allowed until (HH:MM)</span>
                  <input
                    name="window_end"
                    type="text"
                    inputmode="numeric"
                    placeholder="20:00"
                    pattern="\\d{2}:\\d{2}"
                    .value=${v['window_end'] ?? ''}
                    @input=${onNum('window_end')}
                  />
                  ${errs['window_end']
                    ? html`<div class="field-error">${errs['window_end']}</div>`
                    : null}
                </label>
              `
            : null}
          ${type === 'hot_tub'
            ? html`
                <label>
                  <span class="label-text">Ready temperature (${unitLabel(unit)})</span>
                  <input
                    name="ready_temp_f"
                    type="number"
                    min=${hotTubLim.min}
                    max=${hotTubLim.max}
                    step=${hotTubLim.step}
                    .value=${v['ready_temp_f'] ?? ''}
                    @input=${onNum('ready_temp_f')}
                  />
                  ${errs['ready_temp_f']
                    ? html`<div class="field-error">${errs['ready_temp_f']}</div>`
                    : null}
                </label>
                <label>
                  <span class="label-text">Between soaks, no lower than (${unitLabel(unit)})</span>
                  <input
                    name="eco_temp_f"
                    type="number"
                    min=${hotTubLim.min}
                    max=${hotTubLim.max}
                    step=${hotTubLim.step}
                    .value=${v['eco_temp_f'] ?? ''}
                    @input=${onNum('eco_temp_f')}
                  />
                  ${errs['eco_temp_f']
                    ? html`<div class="field-error">${errs['eco_temp_f']}</div>`
                    : null}
                </label>
                <p class="opt-toggles-help">
                  Your tub is at the ready temperature for these times. In
                  between it may ease down to the lower limit and reheats
                  when power costs least.
                </p>
                <div class="soak-rows" data-region="soak-rows">
                  ${this._soakRows.map(
                    (row, i) => html`
                      <div class="soak-row" data-soak-row=${i}>
                        <label>
                          <span class="label-text">Start (HH:MM)</span>
                          <input
                            name="soak_start_${i}"
                            type="text"
                            inputmode="numeric"
                            placeholder="19:00"
                            pattern="\\d{2}:\\d{2}"
                            .value=${row.start}
                            @input=${(e: Event) =>
                              this._setSoakField(i, 'start', (e.target as HTMLInputElement).value)}
                          />
                          ${errs[`soak_start_${i}`]
                            ? html`<div class="field-error">${errs[`soak_start_${i}`]}</div>`
                            : null}
                        </label>
                        <label>
                          <span class="label-text">End (HH:MM)</span>
                          <input
                            name="soak_end_${i}"
                            type="text"
                            inputmode="numeric"
                            placeholder="21:00"
                            pattern="\\d{2}:\\d{2}"
                            .value=${row.end}
                            @input=${(e: Event) =>
                              this._setSoakField(i, 'end', (e.target as HTMLInputElement).value)}
                          />
                          ${errs[`soak_end_${i}`]
                            ? html`<div class="field-error">${errs[`soak_end_${i}`]}</div>`
                            : null}
                        </label>
                        <div class="soak-days" role="group" aria-label="Days">
                          ${WEEKDAY_KEYS.map(
                            (k, di) => html`
                              <label class="day-toggle">
                                <input
                                  type="checkbox"
                                  name="soak_day_${i}_${k}"
                                  .checked=${row.days[di]}
                                  @change=${(e: Event) =>
                                    this._setSoakDay(i, di, (e.target as HTMLInputElement).checked)}
                                />
                                ${DAY_LETTERS[k]}
                              </label>
                            `,
                          )}
                        </div>
                        ${errs[`soak_days_${i}`]
                          ? html`<div class="field-error">${errs[`soak_days_${i}`]}</div>`
                          : null}
                        ${this._soakRows.length > 1
                          ? html`<button
                              type="button"
                              class="soak-remove"
                              @click=${() => this._removeSoakRow(i)}
                            >
                              Remove
                            </button>`
                          : null}
                      </div>
                    `,
                  )}
                </div>
              `
            : null}
          ${type === 'hot_tub' && this._soakRows.length < MAX_SOAK_ROWS
            ? html`<button
                type="button"
                class="reset-defaults"
                @click=${() => this._addSoakRow()}
              >
                Add a soak time
              </button>`
            : null}
          ${type === 'hvac'
            ? html`
                <fieldset class="opt-toggles defaults-group">
                  <legend>Defaults</legend>
                  <p class="opt-toggles-help">
                    These feed the hourly table below — edit them and
                    click "Reset to defaults" to refill it, or edit the
                    table directly.
                  </p>
                  <label>
                    <span class="label-text">Base temperature (${unitLabel(unit)})</span>
                    <input
                      name="base_temperature"
                      type="number"
                      step=${limitsFor('base', unit).step}
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
                        .value=${v['savings_level'] ?? '1'}
                        @input=${onNum('savings_level')}
                      />
                      <span class="slider-value">${v['savings_level'] ?? '1'}</span>
                    </div>
                    ${errs['savings_level']
                      ? html`<div class="field-error">${errs['savings_level']}</div>`
                      : null}
                  </label>
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
                  <button
                    class="reset-defaults"
                    type="button"
                    ?disabled=${this._resetting}
                    @click=${onResetDefaults}
                  >
                    ${this._resetting ? 'Resetting…' : 'Reset to defaults'}
                  </button>
                  ${this._resetError
                    ? html`<p class="reset-note">${this._resetError}</p>`
                    : null}
                </fieldset>
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
                  <div class="opt-toggles-help" data-region="mode-help">
                    ${modeHelp(v['optimization_mode'] ?? 'auto')}
                  </div>
                  ${errs['optimization_mode']
                    ? html`<div class="field-error">${errs['optimization_mode']}</div>`
                    : null}
                </label>
                <fieldset class="opt-toggles">
                  <legend>Pause this unit</legend>
                  <p class="opt-toggles-help">
                    Pause optimization for this HVAC only — schedules are
                    still computed nightly but the integration leaves
                    this unit on manual control. The user-wide pause
                    switch (Dashboard header) overrides this per-unit
                    setting and pauses everything.
                  </p>
                  <label class="opt-toggle">
                    <input
                      name="optimization_enabled"
                      type="checkbox"
                      .checked=${v['optimization_enabled'] === '1'}
                      @change=${(e: Event) =>
                        this._setValue(
                          'optimization_enabled',
                          (e.target as HTMLInputElement).checked ? '1' : '',
                        )}
                    />
                    <span>
                      <strong>Optimization enabled</strong> — uncheck to
                      pause this HVAC. Re-enable any time; takes effect
                      on the next apply tick (within 30 minutes).
                    </span>
                  </label>
                </fieldset>
                <fieldset class="opt-toggles">
                  <legend>What can we optimize?</legend>
                  <p class="opt-toggles-help">
                    Temperature setpoints are always optimized within
                    your comfort band. Turn these on to let the
                    optimizer also pick fan speed and HVAC mode.
                  </p>
                  <label class="opt-toggle">
                    <input
                      name="optimize_hvac_fan"
                      type="checkbox"
                      .checked=${v['optimize_hvac_fan'] === '1'}
                      @change=${(e: Event) =>
                        this._setValue(
                          'optimize_hvac_fan',
                          (e.target as HTMLInputElement).checked ? '1' : '',
                        )}
                    />
                    <span>
                      <strong>Fan speed</strong> — high during pre-cool
                      bursts, low during maintenance.
                    </span>
                  </label>
                  <label class="opt-toggle">
                    <input
                      name="optimize_hvac_mode"
                      type="checkbox"
                      .checked=${v['optimize_hvac_mode'] === '1'}
                      @change=${(e: Event) =>
                        this._setValue(
                          'optimize_hvac_mode',
                          (e.target as HTMLInputElement).checked ? '1' : '',
                        )}
                    />
                    <span>
                      <strong>On / off control</strong> — turn the unit
                      on when cooling or heating is needed and off when
                      it isn't.
                    </span>
                  </label>
                </fieldset>
                <div class="hourly-bands">
                  <span class="label-text">Hourly comfort limits (${unitLabel(unit)})</span>
                  ${this._renderDays()}
                  <div class="hourly-content">
                    <table class="hourly-table">
                      <thead>
                        <tr>
                          <th>Hour</th>
                          <th>Low ${unitLabel(unit)}</th>
                          <th>High ${unitLabel(unit)}</th>
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
                                  step=${String(hLim.step)}
                                  min=${String(hLim.min)}
                                  max=${String(hLim.max)}
                                  class=${lowErr || rowErr ? 'invalid' : ''}
                                  .value=${this._hourlyLow[i] ?? ''}
                                  @input=${onHourlyLow(i)}
                                />
                              </td>
                              <td>
                                <input
                                  name="hourly_high_${i}"
                                  type="number"
                                  step=${String(hLim.step)}
                                  min=${String(hLim.min)}
                                  max=${String(hLim.max)}
                                  class=${highErr || rowErr ? 'invalid' : ''}
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
