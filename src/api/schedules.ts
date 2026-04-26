import { apiFetch } from './client.js';
import type { ApplianceType } from './appliances.js';

export interface HvacScheduleBody {
  intervals: number[];
  high_temps: number[];
  low_temps: number[];
}

export interface HvacScheduleResponse {
  date: string;
  schedule: HvacScheduleBody;
  mode: string;
  estimated_savings_pct: number;
  model_confidence: number | null;
  generated_at: string;
  stale?: boolean;
  source: 'optimization' | 'defaults';
}

export interface ApplianceScheduleEntry {
  appliance_id: string;
  appliance_type: ApplianceType;
  name: string;
  schedule: Record<string, unknown>;
  savings_pct: number;
  source: 'optimization' | 'defaults';
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
