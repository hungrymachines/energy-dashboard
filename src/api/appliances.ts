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

export async function create(body: CreateApplianceBody): Promise<Appliance> {
  const resp = await apiFetch<unknown>('/api/v1/appliances', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  // The server may return a full Appliance or a thin { appliance_id } envelope.
  // Normalize to Appliance so callers always get the same shape.
  if (resp && typeof resp === 'object') {
    const r = resp as Partial<Appliance> & { appliance_id?: string };
    if (typeof r.id === 'string' && typeof r.name === 'string' && typeof r.appliance_type === 'string') {
      return r as Appliance;
    }
    const id = typeof r.id === 'string' ? r.id : (r.appliance_id ?? '');
    return {
      id,
      user_id: typeof r.user_id === 'string' ? r.user_id : '',
      appliance_type: body.appliance_type,
      name: body.name,
      config: body.config,
      is_active: r.is_active ?? true,
      created_at: typeof r.created_at === 'string' ? r.created_at : new Date().toISOString(),
    };
  }
  return {
    id: '',
    user_id: '',
    appliance_type: body.appliance_type,
    name: body.name,
    config: body.config,
    is_active: true,
    created_at: new Date().toISOString(),
  };
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
