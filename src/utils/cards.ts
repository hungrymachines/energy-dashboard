import type { ApplianceScheduleEntry, InlineIntegrationHealth } from '../api/schedules.js';

/** Where Home Assistant serves the Hungry Machines panel. */
export const PANEL_PATH = '/hungry-machines';

/** How long a card keeps a loaded plan before asking for it again. */
export const CARD_REFRESH_MS = 5 * 60 * 1000;

/** How long a card waits after a failed load before trying again. */
export const CARD_RETRY_MS = 60 * 1000;

const SLOTS_PER_DAY = 48;

/** Go to the panel the way Home Assistant navigates, with no page reload. */
export function openPanel(): void {
  history.pushState(null, '', PANEL_PATH);
  window.dispatchEvent(new CustomEvent('location-changed', { bubbles: true, composed: true }));
}

/** The half-hour slot (0-47) the local clock is in. */
export function currentSlot(now: Date = new Date()): number {
  return Math.floor((now.getHours() * 60 + now.getMinutes()) / 30);
}

/** A half-hour slot as a local clock time, e.g. slot 28 -> "2:00 PM". */
export function slotTimeLabel(slot: number): string {
  const d = new Date();
  d.setHours(Math.floor(slot / 2), slot % 2 === 0 ? 0 : 30, 0, 0);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** "Paused until 3:45 PM" for a timed pause, "Paused" when the time is unreadable. */
export function pausedUntilLabel(pausedUntil: string | null | undefined): string {
  const until = pausedUntil ? new Date(pausedUntil) : null;
  return until && !Number.isNaN(until.getTime())
    ? `Paused until ${until.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
    : 'Paused';
}

/** The text for a sensor-health badge. Empty when there is nothing to say. */
export function healthLabel(health: InlineIntegrationHealth | undefined): string {
  if (!health) return '';
  if (health.message) return health.message;
  switch (health.status) {
    case 'stale_data':
      return 'Sensor data is stale.';
    case 'frozen_sensor':
      return 'Indoor sensor appears stuck.';
    case 'no_data':
      return 'No recent sensor data.';
    default:
      return '';
  }
}

/**
 * When an on/off appliance is next scheduled on today: `now` when the
 * current half-hour is on, else the next on slot, else null. HVAC plans
 * carry slot numbers, not on/off flags, so they give null too.
 */
export function nextScheduledSlot(
  entry: ApplianceScheduleEntry,
  fromSlot: number = currentSlot(),
): { slot: number; now: boolean } | null {
  const intervals = entry.schedule?.['intervals'];
  if (!Array.isArray(intervals) || intervals.length !== SLOTS_PER_DAY) return null;
  if (!intervals.every((v) => typeof v === 'boolean')) return null;
  for (let i = fromSlot; i < SLOTS_PER_DAY; i++) {
    if (intervals[i]) return { slot: i, now: i === fromSlot };
  }
  return null;
}

/** A Home Assistant power reading as "850 W" or "1.5 kW". Null when unreadable. */
export function formatPower(state: unknown, unit: unknown): string | null {
  const raw = typeof state === 'string' || typeof state === 'number' ? Number(state) : NaN;
  if (typeof state === 'string' && state.trim() === '') return null;
  if (!Number.isFinite(raw)) return null;
  const watts = unit === 'kW' ? raw * 1000 : raw;
  if (Math.abs(watts) >= 1000) return `${(watts / 1000).toFixed(1)} kW`;
  return `${Math.round(watts)} W`;
}
