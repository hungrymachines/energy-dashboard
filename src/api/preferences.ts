import { apiFetch } from './client.js';

export interface Preferences {
  base_temperature: number;
  savings_level: number;
  time_away: string;
  time_home: string;
  optimization_mode: string;
  hourly_high_temps_f?: number[] | null;
  hourly_low_temps_f?: number[] | null;
}

export interface UpdatePreferencesBody {
  base_temperature?: number;
  savings_level?: number;
  time_away?: string;
  time_home?: string;
  optimization_mode?: string;
  hourly_high_temps_f?: number[] | null;
  hourly_low_temps_f?: number[] | null;
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
