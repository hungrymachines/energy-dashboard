import { apiFetch } from './client.js';

export interface AppliancePreferences {
  base_temperature: number;
  savings_level: number;
  time_away: string;
  time_home: string;
  optimization_mode: string;
  hourly_high_temps_f?: number[] | null;
  hourly_low_temps_f?: number[] | null;
  optimize_hvac_fan?: boolean;
  optimize_hvac_mode?: boolean;
  /** Per-appliance pause switch — ANDed server-side with the
   * user-level user_preferences.optimization_enabled master flag. */
  optimization_enabled?: boolean;
}

export interface UpdateAppliancePreferencesBody {
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
 * editor (US-SDC-032). */
export function defaultBands(
  applianceId: string,
  params: DefaultBandsParams = {},
): Promise<DefaultBandsResponse> {
  return apiFetch<DefaultBandsResponse>(
    `/api/v1/appliances/${encodeURIComponent(applianceId)}/preferences/default-bands${buildDefaultBandsQuery(params)}`,
  );
}
