import { apiFetch } from './client.js';

export interface Preferences {
  base_temperature: number;
  savings_level: number;
  time_away: string;
  time_home: string;
  optimization_mode: string;
  hourly_high_temps_f?: number[] | null;
  hourly_low_temps_f?: number[] | null;
  /** Phase C — let the optimizer pick fan speed per slot. */
  optimize_hvac_fan?: boolean;
  /** Phase D — let the optimizer pick HVAC mode (cool/eco/off) per slot. */
  optimize_hvac_mode?: boolean;
  /** Master pause switch — false stops the integration applying schedules. */
  optimization_enabled?: boolean;
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
