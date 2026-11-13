import { apiFetch } from './client.js';
import type { WeekdayBands } from '../utils/day-bands.js';

export interface AppliancePreferences {
  base_temperature: number;
  savings_level: number;
  time_away: string;
  time_home: string;
  optimization_mode: string;
  hourly_high_temps_f?: number[] | null;
  hourly_low_temps_f?: number[] | null;
  /** Per-weekday band overrides (°F, hour 0 = local midnight); a missing
   * day inherits the hourly arrays. null/absent = no overrides. */
  weekday_bands?: WeekdayBands | null;
  optimize_hvac_fan?: boolean;
  optimize_hvac_mode?: boolean;
  /** Per-appliance pause switch — ANDed server-side with the
   * user-level user_preferences.optimization_enabled master flag. */
  optimization_enabled?: boolean;
  /** UTC ISO timestamp the timed pause ends; absent/null when not paused.
   * Written only by `pause()` / `resume()`, never by `update()`. */
  paused_until?: string | null;
  /** Lets this unit's setpoint sit up to 6 °F outside the comfort range
   * instead of 3 °F. Off by default. */
  wide_setpoint_offset?: boolean;
}

export interface UpdateAppliancePreferencesBody {
  base_temperature?: number;
  savings_level?: number;
  time_away?: string;
  time_home?: string;
  optimization_mode?: string;
  hourly_high_temps_f?: number[] | null;
  hourly_low_temps_f?: number[] | null;
  /** Per-weekday band overrides (°F, hour 0 = local midnight); a missing
   * day inherits the hourly arrays. null/absent = no overrides. */
  weekday_bands?: WeekdayBands | null;
  optimize_hvac_fan?: boolean;
  optimize_hvac_mode?: boolean;
  optimization_enabled?: boolean;
  wide_setpoint_offset?: boolean;
}

export function get(applianceId: string): Promise<AppliancePreferences> {
  return apiFetch<AppliancePreferences>(
    `/api/v1/appliances/${encodeURIComponent(applianceId)}/preferences`,
  );
}

export function update(
  applianceId: string,
  body: UpdateAppliancePreferencesBody,
): Promise<AppliancePreferences> {
  return apiFetch<AppliancePreferences>(
    `/api/v1/appliances/${encodeURIComponent(applianceId)}/preferences`,
    {
      method: 'PUT',
      body: JSON.stringify(body),
    },
  );
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

/** Preview the shaped default hourly band for one appliance without
 * writing anything — identical semantics to the account-level endpoint
 * in `./preferences.ts`. Powers "Reset to defaults" in the constraint
 * editor. */
export function defaultBands(
  applianceId: string,
  params: DefaultBandsParams = {},
): Promise<DefaultBandsResponse> {
  return apiFetch<DefaultBandsResponse>(
    `/api/v1/appliances/${encodeURIComponent(applianceId)}/preferences/default-bands${buildDefaultBandsQuery(params)}`,
  );
}

export type PauseState = 'active' | 'timed' | 'manual' | 'master';

export interface PauseResponse {
  appliance_id: string;
  paused_until: string | null;
  optimization_enabled: boolean;
  pause_state: PauseState;
}

/** Hand one HVAC unit to the user for `minutes` (1-1440); the plan takes
 * it back on its own when the time is up. */
export function pause(applianceId: string, minutes: number): Promise<PauseResponse> {
  return apiFetch<PauseResponse>(
    `/api/v1/appliances/${encodeURIComponent(applianceId)}/pause`,
    { method: 'POST', body: JSON.stringify({ minutes }) },
  );
}

/** End a timed pause now. Never touches `optimization_enabled`. */
export function resume(applianceId: string): Promise<PauseResponse> {
  return apiFetch<PauseResponse>(
    `/api/v1/appliances/${encodeURIComponent(applianceId)}/resume`,
    { method: 'POST' },
  );
}
