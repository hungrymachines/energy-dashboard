import { apiFetch } from './client.js';

export type ApplianceType = 'hvac' | 'ev_charger' | 'home_battery' | 'water_heater';

export interface Appliance {
  id: string;
  user_id: string;
  appliance_type: ApplianceType;
  name: string;
  config: Record<string, unknown>;
  is_active: boolean;
  created_at: string;
}

export interface CreateApplianceBody {
  appliance_type: ApplianceType;
  name: string;
  config: Record<string, unknown>;
}

export interface UpdateApplianceBody {
  name?: string;
  config?: Record<string, unknown>;
}

export interface CreateApplianceResponse {
  appliance_id: string;
}

export interface ConstraintsResponse {
  status: string;
  constraints: Record<string, unknown>;
}

export interface ApplianceSchedule {
  appliance_id: string;
  date: string;
  schedule: Record<string, unknown>;
  savings_pct: number;
  source: 'optimization' | 'defaults';
}

export function list(): Promise<Appliance[]> {
  return apiFetch<Appliance[]>('/api/v1/appliances');
}

export function create(body: CreateApplianceBody): Promise<CreateApplianceResponse> {
  return apiFetch<CreateApplianceResponse>('/api/v1/appliances', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function update(id: string, body: UpdateApplianceBody): Promise<Appliance> {
  return apiFetch<Appliance>(`/api/v1/appliances/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

export function setConstraints(id: string, body: Record<string, unknown>): Promise<ConstraintsResponse> {
  return apiFetch<ConstraintsResponse>(`/api/v1/appliances/${encodeURIComponent(id)}/constraints`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function getSchedule(id: string): Promise<ApplianceSchedule> {
  return apiFetch<ApplianceSchedule>(`/api/v1/appliances/${encodeURIComponent(id)}/schedule`);
}
