import { apiFetch } from './client.js';

export type PjmNodeOption = { slug: string; label: string };

export type PricingZoneOption = {
  id: number;
  slug: string;
  utility: string;
  plan: string;
  region: string;
  label: string;
  notes: string;
};

export interface RatesResponse {
  pricing_location: number;
  intervals: number[];
  rates_cents_per_kwh: number[];
  unit: string;
  source: 'custom' | 'zone' | 'dynamic';
  hourly_rates_cents_per_kwh: number[] | null;
  pricing_source: 'zone' | 'custom' | 'dynamic';
  pjm_pnode_id: string | null;
  pricing_adder_cents_per_kwh: number | null;
  available_pjm_nodes: PjmNodeOption[];
  available_pricing_zones: PricingZoneOption[];
}

export interface UpdateRatesBody {
  hourly_rates_cents_per_kwh?: number[] | null;
  pricing_source?: 'zone' | 'custom' | 'dynamic';
  pjm_node?: string | null;
  pricing_adder_cents_per_kwh?: number | null;
}

export function get(): Promise<RatesResponse> {
  return apiFetch<RatesResponse>('/api/v1/rates');
}

export function update(body: UpdateRatesBody): Promise<RatesResponse> {
  return apiFetch<RatesResponse>('/api/v1/rates', {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}
