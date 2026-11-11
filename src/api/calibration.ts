import { apiFetch } from './client.js';

/**
 * Typed wrappers for /api/v1/calibration/{status,start,skip}.
 *
 * See the API docs ("Calibration" section) for
 * payload shapes. On the first qualifying warm day the backend runs a
 * 6-hour cooling schedule (`fan_excitation`) so the thermal model gets
 * direct measurements of cool_low and cool_high; on a heating day the
 * run is three in-band holds instead (`setpoint_step`). `start` asks
 * for another run under the same rules and answers 409, with a
 * sentence in `detail`, when none can be scheduled.
 */

export type CalibrationStatus =
  | 'in_progress'
  | 'completed'
  | 'aborted'
  | 'skipped';

export interface CalibrationDerivedRates {
  cooling_effect_cool_low?: number | null;
  cooling_effect_cool_high?: number | null;
  coupling_rate?: number | null;
  sample_count?: number;
  indoor_range_f?: [number, number] | null;
  outdoor_range_f?: [number, number] | null;
  notes?: string[];
  // A setpoint_step run's derived_rates carries only these two fields —
  // no cooling slopes were measured, so the display fields above are
  // absent (not null) on that shape.
  kind?: string;
  phases_observed?: number;
}

export interface CalibrationPhase {
  phase: number;
  state: 'COOL' | 'HEAT' | 'OFF';
  fan: 'low' | 'high' | null;
  start_slot: number;
  end_slot: number;
  // Only on setpoint_step phases: the temperature the phase holds (°F).
  setpoint_f?: number | null;
}

export interface CalibrationRun {
  id: number | null;
  status: CalibrationStatus;
  kind?: 'fan_excitation' | 'setpoint_step';
  schedule_date: string | null;
  started_at: string | null;
  completed_at: string | null;
  aborted_reason: string | null;
  derived_rates: CalibrationDerivedRates | null;
  phases: CalibrationPhase[];
}

export interface CalibrationStatusResponse {
  appliance_id: string;
  is_complete: boolean;
  is_in_progress: boolean;
  latest_run: CalibrationRun | null;
  history: CalibrationRun[];
  can_skip: boolean;
}

export function getStatus(applianceId: string): Promise<CalibrationStatusResponse> {
  const qs = new URLSearchParams({ appliance_id: applianceId }).toString();
  return apiFetch<CalibrationStatusResponse>(`/api/v1/calibration/status?${qs}`);
}

export function start(applianceId: string): Promise<{
  appliance_id: string;
  started: boolean;
  run_id: number | null;
  run: CalibrationRun | null;
}> {
  return apiFetch(`/api/v1/calibration/start`, {
    method: 'POST',
    body: JSON.stringify({ appliance_id: applianceId }),
  });
}

export function skip(applianceId: string): Promise<{
  appliance_id: string;
  skipped: boolean;
}> {
  return apiFetch(`/api/v1/calibration/skip`, {
    method: 'POST',
    body: JSON.stringify({ appliance_id: applianceId }),
  });
}
