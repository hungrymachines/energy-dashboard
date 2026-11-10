// Measured solar output for today, read from the production sensor's own
// history in Home Assistant and averaged into the schedule's 48 half-hour
// slots so it plots against the forecast curve.
//
// Read from HA rather than the API: the integration buffers readings and
// flushes hourly, so HA's recorder is the live copy. Slots are keyed to the
// home's LOCAL wall clock (slot 0 = local midnight), same as every schedule.

const SLOTS = 48;
const MINUTE_MS = 60_000;
// A slot needs this many minutes of valid readings to get a value; fewer and
// it stays null (a gap in the line), never a made-up zero.
const MIN_SLOT_MINUTES = 10;

export type SolarActuals = (number | null)[];

/** One sample from HA's compressed history: state + last-updated seconds. */
interface CompressedState {
  s?: unknown;
  lu?: unknown;
}

export interface HassWs {
  callWS?: (msg: Record<string, unknown>) => Promise<unknown>;
  states?: Record<string, { attributes?: Record<string, unknown> } | undefined>;
}

/** A sensor value in its own unit to kW; null for unavailable/unknown. */
export function toKw(raw: unknown, unit: string): number | null {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (typeof raw === 'string' && raw.trim() === '') return null;
  if (!Number.isFinite(n)) return null;
  const u = unit.trim().toLowerCase();
  // Same sign handling as the integration's upload: some inverters report
  // production as negative.
  const v = Math.abs(n);
  if (u === 'kw' || u === 'kilowatt' || u === 'kilowatts') return v;
  if (u === 'mw' || u === 'megawatt' || u === 'megawatts') return v * 1000;
  return v / 1000; // W, the HA default
}

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

interface WallClock {
  date: string; // YYYY-MM-DD
  hour: number;
  minute: number;
}

function wallClock(fmt: Intl.DateTimeFormat, ms: number): WallClock {
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(new Date(ms))) p[part.type] = part.value;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    hour: Number(p.hour),
    minute: Number(p.minute),
  };
}

/** Epoch ms of local midnight on `date` (YYYY-MM-DD) in `timeZone`. */
export function localMidnightMs(date: string, timeZone: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const fmt = partsFormatter(timeZone);
  const offsetAt = (ms: number): number => {
    const w = wallClock(fmt, ms);
    const [wy, wm, wd] = w.date.split('-').map(Number);
    return Date.UTC(wy, wm - 1, wd, w.hour, w.minute) - Math.floor(ms / MINUTE_MS) * MINUTE_MS;
  };
  // Two passes so a DST change between the guess and midnight settles.
  let t = guess - offsetAt(guess);
  t = guess - offsetAt(t);
  return t;
}

/**
 * Time-weighted mean kW per local half-hour slot of `date`, from a step
 * series of samples (each value holds until the next sample). Slots after
 * `nowMs`, or with under MIN_SLOT_MINUTES of valid readings, are null.
 */
export function slotAveragesKw(
  samples: { t: number; kw: number | null }[],
  date: string,
  timeZone: string,
  nowMs: number,
): SolarActuals {
  const sorted = [...samples].sort((a, b) => a.t - b.t);
  const sums = Array<number>(SLOTS).fill(0);
  const counts = Array<number>(SLOTS).fill(0);
  const fmt = partsFormatter(timeZone);
  const start = localMidnightMs(date, timeZone);
  // A local day is 23-25 h; walk minutes until the wall-clock date moves on.
  const end = Math.min(nowMs, start + 25 * 60 * MINUTE_MS);
  let i = -1;
  for (let t = start; t < end; t += MINUTE_MS) {
    while (i + 1 < sorted.length && sorted[i + 1].t <= t) i++;
    if (i < 0) continue;
    const kw = sorted[i].kw;
    if (kw === null) continue;
    const w = wallClock(fmt, t);
    if (w.date !== date) break;
    const slot = w.hour * 2 + (w.minute >= 30 ? 1 : 0);
    sums[slot] += kw;
    counts[slot] += 1;
  }
  return sums.map((s, k) => (counts[k] >= MIN_SLOT_MINUTES ? s / counts[k] : null));
}

/**
 * Today's measured output for `entityId`, or null when HA can't answer
 * (no websocket, recorder off, entity excluded). Never throws.
 */
export async function fetchSolarActuals(
  hass: HassWs | undefined,
  entityId: string,
  date: string,
  timeZone: string,
  nowMs: number = Date.now(),
): Promise<SolarActuals | null> {
  if (!hass?.callWS || !entityId || !date || !timeZone) return null;
  const start = localMidnightMs(date, timeZone);
  if (!Number.isFinite(start) || nowMs <= start) return null;
  const unitRaw = hass.states?.[entityId]?.attributes?.['unit_of_measurement'];
  const unit = typeof unitRaw === 'string' ? unitRaw : 'W';
  let resp: unknown;
  try {
    resp = await hass.callWS({
      type: 'history/history_during_period',
      start_time: new Date(start).toISOString(),
      end_time: new Date(nowMs).toISOString(),
      entity_ids: [entityId],
      minimal_response: true,
      no_attributes: true,
      significant_changes_only: false,
    });
  } catch {
    return null;
  }
  const rows = (resp as Record<string, unknown> | null)?.[entityId];
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const samples: { t: number; kw: number | null }[] = [];
  for (const row of rows as CompressedState[]) {
    if (typeof row?.lu !== 'number') continue;
    // The first row is the state at start_time; HA may stamp it earlier.
    samples.push({ t: Math.max(start, row.lu * 1000), kw: toKw(row.s, unit) });
  }
  if (samples.length === 0) return null;
  const slots = slotAveragesKw(samples, date, timeZone, nowMs);
  return slots.some((v) => v !== null) ? slots : null;
}

/** kWh over the slots that have a measured value, and the forecast for those same slots. */
export function comparedKwh(
  actuals: SolarActuals,
  forecastKw48: number[],
): { actualKwh: number; forecastKwh: number; slots: number } {
  let actualKwh = 0;
  let forecastKwh = 0;
  let slots = 0;
  for (let k = 0; k < SLOTS; k++) {
    const a = actuals[k];
    if (a === null || a === undefined) continue;
    actualKwh += a * 0.5;
    forecastKwh += (forecastKw48[k] ?? 0) * 0.5;
    slots += 1;
  }
  return { actualKwh, forecastKwh, slots };
}

export type SolarSensorState = 'none' | 'missing' | 'offline' | 'connected';

export interface SolarSensorStatus {
  state: SolarSensorState;
  text: string;
}

type SensorStates = Record<
  string,
  { state?: unknown; attributes?: Record<string, unknown> } | undefined
>;

/**
 * Whether the solar appliance's production sensor is reporting to Home
 * Assistant right now, from its live state. Not a staleness check: a power
 * sensor can sit at 0 W for hours at night and still be healthy.
 */
export function solarSensorStatus(
  states: SensorStates | undefined,
  entityId: string,
): SolarSensorStatus {
  if (!entityId) return { state: 'none', text: 'No production sensor connected' };
  const s = states?.[entityId];
  if (!s) {
    return {
      state: 'missing',
      text: `Production sensor ${entityId} isn't in Home Assistant`,
    };
  }
  const unitRaw = s.attributes?.['unit_of_measurement'];
  const unit = typeof unitRaw === 'string' ? unitRaw : 'W';
  const kw = toKw(s.state, unit);
  if (kw === null) {
    const reported = typeof s.state === 'string' && s.state !== '' ? s.state : 'no value';
    return {
      state: 'offline',
      text:
        `Production sensor offline: ${entityId} reports ${reported}. ` +
        'Some inverters stop reporting at night.',
    };
  }
  // An energy total (kWh) is still a live sensor, but its value isn't power.
  if (/wh$/i.test(unit.trim())) {
    return { state: 'connected', text: 'Production sensor connected' };
  }
  return { state: 'connected', text: `Production sensor connected: ${kw.toFixed(1)} kW now` };
}
