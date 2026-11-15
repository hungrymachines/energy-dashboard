import { apiFetch } from './client.js';

/**
 * Typed wrappers for `/api/v1/integration/appliances/health` (connection
 * health for every machine in one call) and `/api/v1/me/home` (plain facts
 * about the home, learned from its readings).
 *
 * `alert` is set only for a clear failure, and `status` is `attention`
 * exactly when it is set. Anything the panel does not know how to show is
 * kept loose so a newer server cannot break the render.
 */

export type ApplianceHealthState = 'ok' | 'attention' | 'nothing_to_check';

export type ReadingsStatus = 'healthy' | 'stale_data' | 'frozen_sensor' | 'no_data' | 'unknown';

export interface ReadingsHealth {
  status: ReadingsStatus | string;
  newest_age_seconds: number | null;
  message: string;
}

export interface SensorHealthRow {
  label: string;
  config_key: string;
  verdict: string;
  populated_pct: number | null;
  message: string;
}

export interface PowerHealth {
  mapped: boolean;
  coverage_pct: number | null;
  matched_pct: number | null;
}

/** The command check; fields vary by machine type, so they are optional. */
export interface CommandHealth {
  verdict: string | null;
  human_readable: string | null;
  message: string | null;
  [key: string]: unknown;
}

export interface ApplianceHealthEntry {
  appliance_id: string;
  name: string | null;
  appliance_type: string;
  status: ApplianceHealthState;
  alert: { message: string } | null;
  readings: ReadingsHealth;
  command: CommandHealth | null;
  sensors: SensorHealthRow[];
  power: PowerHealth;
  notes: string[];
}

export interface AppliancesHealth {
  lookback_hours: number;
  appliances: ApplianceHealthEntry[];
}

export interface HomeFact {
  key: string;
  value: number | string | boolean | null;
  unit: string | null;
  detail: unknown;
}

export interface HomeMachine {
  appliance_id: string;
  name: string | null;
  appliance_type: string;
  /** True while there is too little data to state facts. */
  learning: boolean;
  facts: HomeFact[];
}

export interface HomeFacts {
  appliances: HomeMachine[];
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

function normalizeSensor(v: unknown): SensorHealthRow {
  const s = asRecord(v);
  return {
    label: strOrNull(s.label) ?? '',
    config_key: strOrNull(s.config_key) ?? '',
    verdict: strOrNull(s.verdict) ?? 'no_data',
    populated_pct: numOrNull(s.populated_pct),
    message: strOrNull(s.message) ?? '',
  };
}

function normalizeState(v: unknown): ApplianceHealthState {
  return v === 'attention' || v === 'nothing_to_check' ? v : 'ok';
}

function normalizeEntry(v: unknown): ApplianceHealthEntry | null {
  const e = asRecord(v);
  const id = strOrNull(e.appliance_id);
  if (id === null) return null;
  const r = asRecord(e.readings);
  const p = asRecord(e.power);
  const alert = asRecord(e.alert);
  const cmd = e.command && typeof e.command === 'object' ? asRecord(e.command) : null;
  return {
    appliance_id: id,
    name: strOrNull(e.name),
    appliance_type: strOrNull(e.appliance_type) ?? '',
    status: normalizeState(e.status),
    alert: e.alert && typeof e.alert === 'object' ? { message: strOrNull(alert.message) ?? '' } : null,
    readings: {
      status: strOrNull(r.status) ?? 'unknown',
      newest_age_seconds: numOrNull(r.newest_age_seconds),
      message: strOrNull(r.message) ?? '',
    },
    command: cmd && {
      ...cmd,
      verdict: strOrNull(cmd.verdict),
      human_readable: strOrNull(cmd.human_readable),
      message: strOrNull(cmd.message),
    },
    sensors: Array.isArray(e.sensors) ? e.sensors.map(normalizeSensor) : [],
    power: {
      mapped: p.mapped === true,
      coverage_pct: numOrNull(p.coverage_pct),
      matched_pct: numOrNull(p.matched_pct),
    },
    notes: Array.isArray(e.notes) ? e.notes.filter((n): n is string => typeof n === 'string') : [],
  };
}

/** A thin or empty body becomes an empty list of machines. */
export function normalizeAppliancesHealth(data: unknown): AppliancesHealth {
  const d = asRecord(data);
  const raw = Array.isArray(d.appliances) ? d.appliances : [];
  const appliances: ApplianceHealthEntry[] = [];
  for (const r of raw) {
    const e = normalizeEntry(r);
    if (e !== null) appliances.push(e);
  }
  return { lookback_hours: numOrNull(d.lookback_hours) ?? 24, appliances };
}

function normalizeFact(v: unknown): HomeFact | null {
  const f = asRecord(v);
  const key = strOrNull(f.key);
  if (key === null) return null;
  const val = f.value;
  return {
    key,
    value:
      typeof val === 'number' ? (Number.isFinite(val) ? val : null)
      : typeof val === 'string' || typeof val === 'boolean' ? val
      : null,
    unit: strOrNull(f.unit),
    detail: f.detail ?? null,
  };
}

/** A machine with no facts is treated as still learning unless the server says otherwise. */
export function normalizeHomeFacts(data: unknown): HomeFacts {
  const d = asRecord(data);
  const raw = Array.isArray(d.appliances) ? d.appliances : [];
  const appliances: HomeMachine[] = [];
  for (const r of raw) {
    const m = asRecord(r);
    const id = strOrNull(m.appliance_id);
    if (id === null) continue;
    const facts: HomeFact[] = [];
    for (const f of Array.isArray(m.facts) ? m.facts : []) {
      const nf = normalizeFact(f);
      if (nf !== null) facts.push(nf);
    }
    appliances.push({
      appliance_id: id,
      name: strOrNull(m.name),
      appliance_type: strOrNull(m.appliance_type) ?? '',
      learning: typeof m.learning === 'boolean' ? m.learning : facts.length === 0,
      facts,
    });
  }
  return { appliances };
}

export async function getAppliancesHealth(): Promise<AppliancesHealth> {
  return normalizeAppliancesHealth(await apiFetch<unknown>('/api/v1/integration/appliances/health'));
}

export async function getHomeFacts(): Promise<HomeFacts> {
  return normalizeHomeFacts(await apiFetch<unknown>('/api/v1/me/home'));
}
