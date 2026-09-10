import { describe, it, expect } from 'vitest';
import {
  SAVINGS_ESTIMATE_TITLE,
  averagePricingCents,
  formatSavingsEstimate,
  savingsEstimateTitle,
} from '../src/utils/savings.js';

// US-CTL-012: savings_pct is the model's baseline minus the plan, both
// priced on the plan's own curve. Nothing here changes the number — it
// only changes what the UI claims the number is.
describe('savings estimate labelling (US-CTL-012)', () => {
  it('rounds the same way the raw template did, behind an "est." prefix', () => {
    expect(formatSavingsEstimate(18.5)).toBe('est. 19% savings today');
    expect(formatSavingsEstimate(32.1)).toBe('est. 32% savings today');
    expect(formatSavingsEstimate(0)).toBe('est. 0% savings today');
    expect(formatSavingsEstimate(-4.4)).toBe('est. -4% savings today');
  });

  it('averages the plan curve the backend persisted', () => {
    const curve = Array.from({ length: 48 }, (_, i) => (i < 24 ? 10 : 20));
    expect(averagePricingCents({ pricing_cents_48: curve })).toBeCloseTo(15.0, 10);
  });

  it('returns null for a schedule with no usable curve', () => {
    expect(averagePricingCents(undefined)).toBeNull();
    expect(averagePricingCents(null)).toBeNull();
    expect(averagePricingCents({})).toBeNull();
    expect(averagePricingCents({ pricing_cents_48: [] })).toBeNull();
    expect(averagePricingCents({ pricing_cents_48: 'nope' })).toBeNull();
    // One bad slot poisons the mean, so refuse the whole array.
    expect(averagePricingCents({ pricing_cents_48: [10, null, 20] })).toBeNull();
    expect(averagePricingCents({ pricing_cents_48: [10, Number.NaN] })).toBeNull();
  });

  it('appends the average price to the title only when the curve is there', () => {
    expect(savingsEstimateTitle({})).toBe(SAVINGS_ESTIMATE_TITLE);
    expect(SAVINGS_ESTIMATE_TITLE).toBe(
      "Estimated from the model's baseline at the plan's price curve",
    );
    expect(
      savingsEstimateTitle({ pricing_cents_48: Array<number>(48).fill(12.34) }),
    ).toBe(
      "Estimated from the model's baseline at the plan's price curve (avg 12.3 ¢/kWh)",
    );
  });
});
