import { apiFetch } from './client.js';
import type { ApplianceType } from './appliances.js';

export type HvacScheduleBody = {
  intervals: number[];
  high_temps: number[];
  low_temps: number[];
};

export interface HvacScheduleResponse {
  date: string;
  schedule: HvacScheduleBody;
  mode: string;
  estimated_savings_pct: number;
  model_confidence: number | null;
  generated_at: string;
  stale: boolean;
  source: 'optimization' | 'defaults';
}

export type IntegrationHealthStatus =
  | 'healthy'
  | 'stale_data'
  | 'frozen_sensor'
  | 'no_data';

export interface InlineIntegrationHealth {
  status: IntegrationHealthStatus;
  message: string;
  last_reading_at?: string | null;
  last_reading_age_seconds?: number | null;
  sample_count?: number;
  indoor_temp_variance_f?: number | null;
  distinct_indoor_temps?: number | null;
  distinct_hvac_states?: number | null;
  lookback_hours?: number;
}

export interface ApplianceScheduleEntry {
  appliance_id: string;
  appliance_type: ApplianceType;
  name: string;
  schedule: Record<string, unknown>;
  savings_pct: number;
  source: 'optimization' | 'defaults';
  optimization_enabled?: boolean;
  integration_health?: InlineIntegrationHealth;
}

export interface SchedulesResponse {
  date: string;
  appliances: ApplianceScheduleEntry[];
}

export function getAllSchedules(): Promise<SchedulesResponse> {
  return apiFetch<SchedulesResponse>('/api/v1/schedules');
}

export function getHvacSchedule(): Promise<HvacScheduleResponse> {
  return apiFetch<HvacScheduleResponse>('/api/v1/schedule');
}

/**
 * Trigger an immediate, synchronous re-optimization for the
 * authenticated user and return the freshly written schedules.
 *
 * Latency: typically 1-5s, worst case ~30s (HVAC optimizer's
 * bounded backtrack budget). Callers should show a progress
 * indicator while this is in flight.
 */
export function recomputeSchedule(): Promise<SchedulesResponse> {
  return apiFetch<SchedulesResponse>('/api/v1/schedule/recompute', {
    method: 'POST',
  });
}
