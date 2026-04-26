import { apiFetch } from './client.js';

export interface RatesResponse {
  pricing_location: number;
  intervals: number[];
  rates_cents_per_kwh: number[];
  unit: string;
  source: 'custom' | 'zone';
  hourly_rates_cents_per_kwh: number[] | null;
}

export interface UpdateRatesBody {
  hourly_rates_cents_per_kwh: number[] | null;
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
