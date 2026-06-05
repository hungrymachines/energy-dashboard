import { apiFetch } from './client.js';

/**
 * Typed wrappers for /api/v1/calibration/{status,start,skip}.
 *
 * See `hungry-machines-api/API_CONTRACT.md` ("Calibration" section) for
 * payload shapes. The backend runs a 6-hour forced schedule on the
 * first qualifying warm day after HVAC appliance registration so the
 * thermal model gets direct measurements of cool_low and cool_high.
 */

export type CalibrationStatus =
  | 'in_progress'
  | 'completed'
  | 'aborted'
  | 'skipped';

export interface CalibrationDerivedRates {
  cooling_effect_cool_low: number | null;
  cooling_effect_cool_high: number | null;
  coupling_rate: number | null;
  sample_count: number;
  indoor_range_f?: [number, number] | null;
  outdoor_range_f?: [number, number] | null;
  notes?: string[];
}

export interface CalibrationPhase {
  phase: number;
  state: 'COOL' | 'OFF';
  fan: 'low' | 'high' | null;
  start_slot: number;
  end_slot: number;
}

export interface CalibrationRun {
  id: number | null;
  status: CalibrationStatus;
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
