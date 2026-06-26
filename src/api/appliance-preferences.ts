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
