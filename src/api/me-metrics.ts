import { apiFetch } from './client.js';

/**
 * Typed wrappers for the signed-in customer's own numbers:
 * `/api/v1/me/metrics/summary`, `/api/v1/me/metrics/daily` and
 * `/api/v1/me/rankings`.
 *
 * Every metric is nullable. A field the server has not computed stays null
 * (the panel shows an em dash), never a made-up 0. `machines.active` is a
 * real count, so it is a plain number.
 */

export interface MetricsSavings {
  /** Simulated baseline cost minus planned cost. */
  modeled_usd: number | null;
  /** Measured use priced against the baseline; null when it cannot be trusted. */
  realized_usd: number | null;
  /** Days in the window that contributed each total. */
  realized_days: number;
  modeled_days: number;
  savings_pct: number | null;
  /** True when savings_pct is at or below 0, or at or above 95. */
  degenerate: boolean;
}

export interface MetricsPeaks {
  peak_hours_idle: number | null;
  /** Same measure over the three priciest hours only (max 3.0 a day). */
  top_peak_hours_idle: number | null;
  off_peak_kwh_share_pct: number | null;
}

export interface MetricsSummary {
  window: number;
  latest_date: string | null;
  days_counted: number;
  savings: MetricsSavings;
  peaks: MetricsPeaks;
  flexibility: { degree_hours: number | null; percent_hours: number | null };
  comfort: { in_band_home_pct: number | null };
  adherence: {
    conformance_pct: number | null;
    override_events: number | null;
    /** 24 counts, index 0 = local midnight; null until there is data. */
    override_by_hour: number[] | null;
  };
  machines: { active: number; by_type: Record<string, number> };
}

export interface DailyEntry {
  /** ISO YYYY-MM-DD, local day. */
  date: string;
  savings: {
    modeled_usd: number | null;
    realized_usd: number | null;
    savings_pct: number | null;
    degenerate: boolean;
  };
  peaks: MetricsPeaks;
  flexibility: { degree_hours: number | null; percent_hours: number | null };
  comfort: { in_band_home_pct: number | null };
}

export interface DailyResponse {
  start: string | null;
  end: string | null;
  days: DailyEntry[];
}

export interface Ranking {
  /** e.g. savings_pct, off_peak_kwh_share_pct, flexibility_degree_hours. */
  metric: string;
  cohort_kind: string | null;
  /** Generic label such as "your ZIP code". Never raw digits or a count. */
  cohort_label: string | null;
  /** 1-based, higher is better; null (never 0) when unranked. */
  rank: number | null;
  percentile: number | null;
  your_value: number | null;
}

export interface RankingsResponse {
  window: number;
  latest_date: string | null;
  rankings: Ranking[];
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

/** A finite number or null: null, a missing key or garbage all become null. */
function numOrNull(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

/** 24 finite non-negative numbers, or null. Any other shape collapses to null. */
function hist24OrNull(v: unknown): number[] | null {
  if (!Array.isArray(v) || v.length !== 24) return null;
  const out: number[] = [];
  for (const x of v) {
    const n = numOrNull(x);
    if (n === null || n < 0) return null;
    out.push(n);
  }
  return out;
}

function normalizePeaks(p: Record<string, unknown>): MetricsPeaks {
  return {
    peak_hours_idle: numOrNull(p.peak_hours_idle),
    top_peak_hours_idle: numOrNull(p.top_peak_hours_idle),
    off_peak_kwh_share_pct: numOrNull(p.off_peak_kwh_share_pct),
  };
}

function normalizeFlex(f: Record<string, unknown>): MetricsSummary['flexibility'] {
  return { degree_hours: numOrNull(f.degree_hours), percent_hours: numOrNull(f.percent_hours) };
}

/** Fill a thin or empty body out to the full shape, with nulls where absent. */
export function normalizeSummary(data: unknown): MetricsSummary {
  const d = asRecord(data);
  const s = asRecord(d.savings);
  const a = asRecord(d.adherence);
  const m = asRecord(d.machines);

  const by_type: Record<string, number> = {};
  for (const [k, v] of Object.entries(asRecord(m.by_type))) {
    const n = numOrNull(v);
    if (n !== null) by_type[k] = n;
  }

  return {
    window: numOrNull(d.window) ?? 30,
    latest_date: strOrNull(d.latest_date),
    days_counted: numOrNull(d.days_counted) ?? 0,
    savings: {
      modeled_usd: numOrNull(s.modeled_usd),
      realized_usd: numOrNull(s.realized_usd),
      realized_days: numOrNull(s.realized_days) ?? 0,
      modeled_days: numOrNull(s.modeled_days) ?? 0,
      savings_pct: numOrNull(s.savings_pct),
      degenerate: s.degenerate === true,
    },
    peaks: normalizePeaks(asRecord(d.peaks)),
    flexibility: normalizeFlex(asRecord(d.flexibility)),
    comfort: { in_band_home_pct: numOrNull(asRecord(d.comfort).in_band_home_pct) },
    adherence: {
      conformance_pct: numOrNull(a.conformance_pct),
      override_events: numOrNull(a.override_events),
      override_by_hour: hist24OrNull(a.override_by_hour),
    },
    machines: { active: numOrNull(m.active) ?? 0, by_type },
  };
}

function normalizeEntry(v: unknown): DailyEntry | null {
  const d = asRecord(v);
  const date = strOrNull(d.date);
  // A row with no date cannot anchor a streak, so drop it.
  if (date === null) return null;
  const s = asRecord(d.savings);
  return {
    date,
    savings: {
      modeled_usd: numOrNull(s.modeled_usd),
      realized_usd: numOrNull(s.realized_usd),
      savings_pct: numOrNull(s.savings_pct),
      degenerate: s.degenerate === true,
    },
    peaks: normalizePeaks(asRecord(d.peaks)),
    flexibility: normalizeFlex(asRecord(d.flexibility)),
    comfort: { in_band_home_pct: numOrNull(asRecord(d.comfort).in_band_home_pct) },
  };
}

/** A thin or empty body becomes `{start: null, end: null, days: []}`. */
export function normalizeDaily(data: unknown): DailyResponse {
  const d = asRecord(data);
  const raw = Array.isArray(d.days) ? d.days : [];
  const days: DailyEntry[] = [];
  for (const r of raw) {
    const e = normalizeEntry(r);
    if (e !== null) days.push(e);
  }
  return { start: strOrNull(d.start), end: strOrNull(d.end), days };
}

/** A rank below 1 is never a real placement, so it becomes null. */
function rankOrNull(v: unknown): number | null {
  const n = numOrNull(v);
  if (n === null || n < 1) return null;
  return Math.round(n);
}

/**
 * Each entry is rebuilt from a fixed field set, so a population count the
 * server might add later never reaches the UI.
 */
export function normalizeRankings(data: unknown): RankingsResponse {
  const d = asRecord(data);
  const raw = Array.isArray(d.rankings) ? d.rankings : [];
  const rankings: Ranking[] = raw.map((r) => {
    const row = asRecord(r);
    return {
      metric: strOrNull(row.metric) ?? '',
      cohort_kind: strOrNull(row.cohort_kind),
      cohort_label: strOrNull(row.cohort_label),
      rank: rankOrNull(row.rank),
      percentile: numOrNull(row.percentile),
      your_value: numOrNull(row.your_value),
    };
  });
  return { window: numOrNull(d.window) ?? 30, latest_date: strOrNull(d.latest_date), rankings };
}

/** Trailing window in days (default 30, server maximum 90). */
export async function getMetricsSummary(window = 30): Promise<MetricsSummary> {
  return normalizeSummary(
    await apiFetch<unknown>(`/api/v1/me/metrics/summary?window=${encodeURIComponent(String(window))}`),
  );
}

/** Per-day series; with no bounds the server returns its default 30 days. */
export async function getDailyMetrics(
  bounds: { start?: string; end?: string } = {},
): Promise<DailyResponse> {
  const qs = new URLSearchParams();
  if (bounds.start) qs.set('start', bounds.start);
  if (bounds.end) qs.set('end', bounds.end);
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return normalizeDaily(await apiFetch<unknown>(`/api/v1/me/metrics/daily${suffix}`));
}

export async function getRankings(window = 30): Promise<RankingsResponse> {
  return normalizeRankings(
    await apiFetch<unknown>(`/api/v1/me/rankings?window=${encodeURIComponent(String(window))}`),
  );
}
