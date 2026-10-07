import { apiFetch } from './client.js';

export interface Preferences {
  base_temperature: number;
  savings_level: number;
  time_away: string;
  time_home: string;
  optimization_mode: string;
  hourly_high_temps_f?: number[] | null;
  hourly_low_temps_f?: number[] | null;
  // The five below are FastAPI fields with defaults, so the API always
  // emits them and openapi-typescript marks them REQUIRED. Declaring them
  // optional here breaks `Hand extends Generated` in tests/contract.test.ts.
  /** Phase C — let the optimizer pick fan speed per slot. */
  optimize_hvac_fan: boolean;
  /** Phase D — let the optimizer pick HVAC mode (cool/eco/off) per slot. */
  optimize_hvac_mode: boolean;
  /** Master pause switch — false stops the integration applying schedules. */
  optimization_enabled: boolean;
  /** Product-newsletter opt-in, set at signup and editable on the website. */
  newsletter_opt_in: boolean;
  /** Dodge real-time price spikes automatically (dynamic ComEd users only). */
  spike_guard_enabled: boolean;
  /** How many shiftable appliances may run at once. null = unlimited. */
  max_concurrent_appliances: number | null;
  /** Whole-home power cap in kW for charging + water heating. null = no cap. */
  power_cap_kw: number | null;
  /** Always-on load reserved out of the power cap, in kW. */
  base_load_reserve_kw: number;
  /** Demand charge in $ per kW of peak draw. null = no demand charge. */
  demand_charge_usd_per_kw: number | null;
  /** Demand window start, HH:MM. null with end null = all day. */
  demand_window_start: string | null;
  /** Demand window end, HH:MM. null with start null = all day. */
  demand_window_end: string | null;
}

export interface UpdatePreferencesBody {
  base_temperature?: number;
  savings_level?: number;
  time_away?: string;
  time_home?: string;
  optimization_mode?: string;
  hourly_high_temps_f?: number[] | null;
  hourly_low_temps_f?: number[] | null;
  optimize_hvac_fan?: boolean;
  optimize_hvac_mode?: boolean;
  optimization_enabled?: boolean;
  spike_guard_enabled?: boolean;
  max_concurrent_appliances?: number | null;
  power_cap_kw?: number | null;
  base_load_reserve_kw?: number;
  demand_charge_usd_per_kw?: number | null;
  demand_window_start?: string | null;
  demand_window_end?: string | null;
}

export function get(): Promise<Preferences> {
  return apiFetch<Preferences>('/api/v1/preferences');
}

export function update(body: UpdatePreferencesBody): Promise<Preferences> {
  return apiFetch<Preferences>('/api/v1/preferences', {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

export interface DefaultBandsParams {
  base_temperature?: number;
  savings_level?: number;
  time_away?: string;
  time_home?: string;
  optimization_mode?: string;
}

export interface DefaultBandsResponse {
  hourly_high_temps_f: number[];
  hourly_low_temps_f: number[];
  peak_hours: [number, number];
  precool_hours: [number, number];
}

function buildDefaultBandsQuery(params: DefaultBandsParams): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      q.set(key, String(value));
    }
  }
  const qs = q.toString();
  return qs ? `?${qs}` : '';
}

/** Preview the shaped default hourly band (`comfort.default_hourly_bands`,
 * US-SDC-030) without writing anything — every param optional, falling back
 * to this user's stored preferences. Powers "Reset to defaults" in the
 * constraint editor (US-SDC-032). */
export function defaultBands(params: DefaultBandsParams = {}): Promise<DefaultBandsResponse> {
  return apiFetch<DefaultBandsResponse>(
    `/api/v1/preferences/default-bands${buildDefaultBandsQuery(params)}`,
  );
}
