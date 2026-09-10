/**
 * How the UI talks about `savings_pct`.
 *
 * The number is the model's own arithmetic: the baseline it predicts a
 * naive thermostat would have cost, minus the plan it chose, both priced
 * on the curve the plan was built against. Neither side of that
 * subtraction was metered, so every surface labels it an estimate rather
 * than letting it read as a measured bill difference (US-CTL-012).
 */

/** Shown on hover wherever a savings figure appears. */
export const SAVINGS_ESTIMATE_TITLE =
  "Estimated from the model's baseline at the plan's price curve";

/** `est. 19% savings today` — the rounding is unchanged from before. */
export function formatSavingsEstimate(pct: number): string {
  return `est. ${Math.round(pct)}% savings today`;
}

/**
 * Mean of the schedule's own price curve, or null when the plan doesn't
 * carry one. Backend blobs have carried `pricing_cents_48` since
 * US-RTG-003; plans written before that don't, and neither does a solar
 * row, so callers must handle the null.
 */
export function averagePricingCents(
  schedule?: Record<string, unknown> | null,
): number | null {
  const raw = schedule?.['pricing_cents_48'];
  if (!Array.isArray(raw) || raw.length === 0) return null;
  let sum = 0;
  for (const value of raw) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    sum += value;
  }
  return sum / raw.length;
}

/**
 * The estimate title, naming the plan's average price when the schedule
 * carries the curve it was optimized against.
 */
export function savingsEstimateTitle(
  schedule?: Record<string, unknown> | null,
): string {
  const avg = averagePricingCents(schedule);
  if (avg === null) return SAVINGS_ESTIMATE_TITLE;
  return `${SAVINGS_ESTIMATE_TITLE} (avg ${avg.toFixed(1)} ¢/kWh)`;
}
