import { apiFetch } from './client.js';

/**
 * Typed wrappers for `/api/v1/integration/health` and
 * `/api/v1/integration/health/divergence`.
 *
 * The basic integration-health endpoint already powers the existing
 * "Connection: OK / Stale / Frozen" banner. The divergence endpoint
 * is new (Phase 6 of the ground-truth signal layer) — it summarizes
 * how well the three signal sources (commanded / power / entity)
 * agree, so users with misbehaving thermostats (Tuya, mini-splits)
 * see "your AC reports unreliable state" instead of silently bad
 * thermal models.
 */

export type IntegrationHealthStatus =
  | 'healthy'
  | 'stale_data'
  | 'frozen_sensor'
  | 'no_data';

export interface IntegrationHealth {
  status: IntegrationHealthStatus;
  last_reading_at: string | null;
  last_reading_age_seconds: number | null;
  sample_count: number;
  indoor_temp_variance_f: number | null;
  distinct_indoor_temps: number | null;
  distinct_hvac_states: number | null;
  message: string;
  lookback_hours: number;
}

export type DivergenceVerdict =
  | 'healthy'
  | 'entity_unreliable'
  | 'thermostat_ignoring_commands'
  | 'commanded_missing'
  | 'no_data'
  | 'unknown';

export interface DivergenceReport {
  lookback_hours: number;
  sample_count: number;
  commanded_coverage_pct: number;
  power_coverage_pct: number;
  entity_coverage_pct: number;
  commanded_vs_entity_mode_agreement_pct: number | null;
  commanded_vs_power_mode_agreement_pct: number | null;
  entity_vs_power_mode_agreement_pct: number | null;
  setpoint_offset_avg_f: number | null;
  setpoint_offset_max_f: number | null;
  fan_match_pct: number | null;
  power_obeyed_pct: number | null;
  verdict: DivergenceVerdict;
  human_readable: string;
}

export function getIntegrationHealth(): Promise<IntegrationHealth> {
  return apiFetch<IntegrationHealth>('/api/v1/integration/health');
}

export function getDivergenceReport(): Promise<DivergenceReport> {
  return apiFetch<DivergenceReport>('/api/v1/integration/health/divergence');
}

export type SensorVerdict =
  | 'healthy'
  | 'intermittent'
  | 'missing_or_broken'
  | 'no_data';

export interface ConfiguredSensor {
  appliance_id: string;
  appliance_name: string;
  config_key: string;       // e.g. 'power_sensor_entity_id'
  label: string;            // e.g. 'Power'
  entity_id: string;
  payload_field: string;    // e.g. 'power_watts'
  populated_pct: number | null;
  verdict: SensorVerdict;
  message: string;
}

export interface SensorHealthResponse {
  sensors: ConfiguredSensor[];
}

export function getSensorHealth(): Promise<SensorHealthResponse> {
  return apiFetch<SensorHealthResponse>('/api/v1/integration/sensors');
}
