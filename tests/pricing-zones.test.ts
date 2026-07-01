import { describe, it, expect } from 'vitest';
import {
  findPricingZone,
  groupPricingZones,
  pricingZoneFullLabel,
  pricingZoneOptionLabel,
} from '../src/data/pricing-zones.js';
import type { PricingZoneOption } from '../src/api/rates.js';

const AVAILABLE: PricingZoneOption[] = [
  {
    id: 1,
    slug: 'sdge_tou_dr1',
    utility: 'SDG&E',
    plan: 'TOU-DR1',
    region: 'San Diego, CA',
    label: 'SDG&E TOU-DR1 — San Diego',
    notes: '',
  },
  {
    id: 2,
    slug: 'coned_nyc',
    utility: 'ConEd',
    plan: 'Default',
    region: 'New York City, NY',
    label: 'ConEd — New York City',
    notes: '',
  },
  {
    id: 5,
    slug: 'sdge_ev_tou_5',
    utility: 'SDG&E',
    plan: 'EV-TOU-5',
    region: 'San Diego, CA',
    label: 'SDG&E EV-TOU-5 — San Diego',
    notes: '',
  },
];

describe('pricingZoneOptionLabel (data-driven)', () => {
  it('returns the API-provided label when the id is in the available list', () => {
    expect(pricingZoneOptionLabel(1, AVAILABLE)).toBe('SDG&E TOU-DR1 — San Diego');
    expect(pricingZoneOptionLabel(5, AVAILABLE)).toBe('SDG&E EV-TOU-5 — San Diego');
  });

  it('falls back to "Zone N" for ids not in the available list', () => {
    expect(pricingZoneOptionLabel(99, AVAILABLE)).toBe('Zone 99');
  });

  it('falls back to "Zone N" when the available list is empty', () => {
    expect(pricingZoneOptionLabel(3, [])).toBe('Zone 3');
  });
});

describe('pricingZoneFullLabel (data-driven)', () => {
  it('returns "utility — region" for known ids', () => {
    expect(pricingZoneFullLabel(1, AVAILABLE)).toBe('SDG&E — San Diego, CA');
    expect(pricingZoneFullLabel(2, AVAILABLE)).toBe('ConEd — New York City, NY');
  });

  it('omits the trailing "(Zone N)" parenthetical', () => {
    expect(pricingZoneFullLabel(1, AVAILABLE)).not.toContain('Zone 1');
  });

  it('falls back to "Zone N" when the id is unknown', () => {
    expect(pricingZoneFullLabel(99, AVAILABLE)).toBe('Zone 99');
  });
});

describe('groupPricingZones', () => {
  it('groups zones by provider, preserving first-seen order', () => {
    // Pre-ordered as the backend sends them: ConEd first, then SDG&E.
    const ordered: PricingZoneOption[] = [AVAILABLE[1], AVAILABLE[0], AVAILABLE[2]];
    const groups = groupPricingZones(ordered);
    expect(groups.map((g) => g.utility)).toEqual(['ConEd', 'SDG&E']);
    expect(groups[0].key).toBe('ConEd — New York City, NY');
    // The two SDG&E zones collapse into one group.
    expect(groups[1].zones.map((z) => z.id)).toEqual([1, 5]);
  });

  it('returns an empty array for no zones', () => {
    expect(groupPricingZones([])).toEqual([]);
  });
});

describe('findPricingZone', () => {
  it('matches by numeric id', () => {
    expect(findPricingZone(5, AVAILABLE)?.slug).toBe('sdge_ev_tou_5');
  });

  it('returns undefined when no match', () => {
    expect(findPricingZone(99, AVAILABLE)).toBeUndefined();
  });
});
