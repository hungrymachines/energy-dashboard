import { apiFetch } from './client.js';

export type DynamicZoneOption = { slug: string; iso: string; label: string };

export type PricingZoneOption = {
  id: number;
  slug: string;
  utility: string;
  plan: string;
  region: string;
  label: string;
  notes: string;
};

export type DeliveryTodCents = {
  morning: number;
  midday_peak: number;
  evening: number;
  overnight: number;
};

export type DeliveryTariffOption = {
  id: number;
  external_id: string;
  plan_name: string;
  utility: string;
  region: string;
  period_rates?: DeliveryTodCents;
};

export interface RatesResponse {
  pricing_location: number;
  intervals: number[];
  rates_cents_per_kwh: number[];
  unit: string;
  source: 'custom' | 'zone' | 'dynamic';
  hourly_rates_cents_per_kwh: number[] | null;
  pricing_source: 'zone' | 'custom' | 'dynamic';
  dynamic_zone: string | null;
  pricing_adder_cents_per_kwh: number | null;
  adder_grid_ruleset_id: number | null;
  delivery_tod_cents: DeliveryTodCents | null;
  available_dynamic_zones: DynamicZoneOption[];
  available_pricing_zones: PricingZoneOption[];
  available_delivery_tariffs: DeliveryTariffOption[];
}

export interface UpdateRatesBody {
  hourly_rates_cents_per_kwh?: number[] | null;
  pricing_source?: 'zone' | 'custom' | 'dynamic';
  pricing_location?: number;
  dynamic_zone?: string | null;
  pricing_adder_cents_per_kwh?: number | null;
  adder_grid_ruleset_id?: number | null;
  delivery_tod_cents?: DeliveryTodCents | null;
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
