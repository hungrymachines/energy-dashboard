// Display conversion between the backend's °F and the user's chosen unit.
// The backend and every stored band stay in °F; only what a person reads or
// types goes through here. The HA-boundary conversion lives in Python.

export type TempUnit = 'F' | 'C';
export type LimitField = 'hourly' | 'base' | 'water_heater';

export interface TempLimits {
  min: number;
  max: number;
  step: number;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

export function fToC(f: number): number {
  return ((f - 32) * 5) / 9;
}

/** °C to °F, rounded to 0.1 °F so every 0.5 °C step lands on an exact value. */
export function cToF(c: number): number {
  return round1((c * 9) / 5 + 32);
}

/** A temperature difference: scale only, no offset. */
export function fDeltaToC(deltaF: number): number {
  return (deltaF * 5) / 9;
}

export function unitLabel(unit: TempUnit): string {
  return unit === 'C' ? '°C' : '°F';
}

/** The preference wins, then Home Assistant's system unit, then °F. */
export function resolveUnit(pref: TempUnit | null | undefined, haUnit: TempUnit | null | undefined): TempUnit {
  if (pref === 'F' || pref === 'C') return pref;
  if (haUnit === 'F' || haUnit === 'C') return haUnit;
  return 'F';
}

export function haUnitFrom(hass: unknown): TempUnit | null {
  const u = (hass as { config?: { unit_system?: { temperature?: unknown } } } | null | undefined)
    ?.config?.unit_system?.temperature;
  if (u === '°C') return 'C';
  if (u === '°F') return 'F';
  return null;
}

/** A stored °F value as a string for a field: °F untouched, °C to the nearest 0.5. */
export function displayTemp(f: number, unit: TempUnit): string {
  if (unit === 'F') return String(f);
  return String(Math.round(fToC(f) * 2) / 2);
}

/**
 * A live readout. `value` is in `sourceUnit`; °F shows whole degrees as before,
 * °C shows 0.1.
 */
export function liveTemp(value: number, sourceUnit: TempUnit, unit: TempUnit): string {
  if (unit === 'F') {
    const f = sourceUnit === 'F' ? value : (value * 9) / 5 + 32;
    return String(Math.round(f));
  }
  const c = sourceUnit === 'C' ? value : fToC(value);
  return round1(c).toFixed(1);
}

export function formatDelta(deltaF: number, unit: TempUnit, digits = 1): string {
  const v = unit === 'C' ? fDeltaToC(deltaF) : deltaF;
  return `${v.toFixed(digits)} ${unitLabel(unit)}`;
}

/** Typed text in the display unit to °F, or null when it is not a number. */
export function parseTempInput(str: string, unit: TempUnit): number | null {
  const s = (str ?? '').trim();
  if (s === '') return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return unit === 'C' ? cToF(n) : n;
}

// Rounded inward so anything the form accepts also passes the API's °F range.
const LIMITS: Record<LimitField, Record<TempUnit, TempLimits>> = {
  hourly: { F: { min: 50, max: 90, step: 0.5 }, C: { min: 10, max: 32, step: 0.5 } },
  base: { F: { min: 60, max: 85, step: 0.5 }, C: { min: 16, max: 29, step: 0.5 } },
  water_heater: { F: { min: 60, max: 180, step: 1 }, C: { min: 16, max: 82, step: 1 } },
};

export function limitsFor(field: LimitField, unit: TempUnit): TempLimits {
  return { ...LIMITS[field][unit] };
}

export interface TemperatureUnitState {
  preference: TempUnit | null;
  haUnit: TempUnit | null;
  unit: TempUnit;
}

export type TemperatureUnitListener = (state: TemperatureUnitState) => void;

class TemperatureUnitStore {
  state: TemperatureUnitState = { preference: null, haUnit: null, unit: 'F' };

  private readonly listeners = new Set<TemperatureUnitListener>();

  subscribe(listener: TemperatureUnitListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  setPreference(pref: TempUnit | null | undefined): void {
    this.update({ preference: pref === 'F' || pref === 'C' ? pref : null });
  }

  setHaUnit(haUnit: TempUnit | null | undefined): void {
    this.update({ haUnit: haUnit === 'F' || haUnit === 'C' ? haUnit : null });
  }

  private update(patch: Partial<TemperatureUnitState>): void {
    const prev = this.state.unit;
    const next = { ...this.state, ...patch };
    next.unit = resolveUnit(next.preference, next.haUnit);
    this.state = next;
    if (next.unit === prev) return;
    for (const l of this.listeners) l(this.state);
  }
}

export const temperatureUnitStore = new TemperatureUnitStore();
