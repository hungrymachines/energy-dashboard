import { describe, it, expect } from 'vitest';
import {
  PRICING_ZONE_LABELS,
  pricingZoneFullLabel,
  pricingZoneOptionLabel,
} from '../src/data/pricing-zones.js';

describe('PRICING_ZONE_LABELS', () => {
  it('zone 1 provider matches /SDG.?E/', () => {
    expect(PRICING_ZONE_LABELS[1].provider).toMatch(/SDG.?E/);
  });

  it('all eight keys 1..8 are present', () => {
    expect(Object.keys(PRICING_ZONE_LABELS).length).toBe(8);
    for (const z of [1, 2, 3, 4, 5, 6, 7, 8] as const) {
      expect(PRICING_ZONE_LABELS[z]).toBeDefined();
      expect(typeof PRICING_ZONE_LABELS[z].provider).toBe('string');
      expect(typeof PRICING_ZONE_LABELS[z].region).toBe('string');
    }
  });

  it('option label includes the provider, region, and zone number', () => {
    const label = pricingZoneOptionLabel(1);
    expect(label).toMatch(/SDG.?E/);
    expect(label).toContain('San Diego');
    expect(label).toContain('Zone 1');
  });

  it('full label omits the zone number', () => {
    expect(pricingZoneFullLabel(2)).toContain('ConEd');
    expect(pricingZoneFullLabel(2)).toContain('New York City');
    expect(pricingZoneFullLabel(2)).not.toContain('Zone');
  });
});
