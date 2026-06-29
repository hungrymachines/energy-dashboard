// Pricing-zone presentation helpers. The catalog itself is API-driven via
// /api/v1/rates -> available_pricing_zones; these helpers format that list
// for the dropdown + hint, and fall back to "Zone N" when the API hasn't
// loaded (or the saved id isn't in the catalog).
import type { PricingZoneOption } from '../api/rates.js';

export function findPricingZone(
  id: number,
  available: readonly PricingZoneOption[],
): PricingZoneOption | undefined {
  return available.find((z) => z.id === id);
}

export function pricingZoneOptionLabel(
  id: number,
  available: readonly PricingZoneOption[],
): string {
  const found = findPricingZone(id, available);
  return found ? found.label : `Zone ${id}`;
}

export function pricingZoneFullLabel(
  id: number,
  available: readonly PricingZoneOption[],
): string {
  const found = findPricingZone(id, available);
  return found ? `${found.utility} — ${found.region}` : `Zone ${id}`;
}

export interface PricingZoneGroup {
  key: string; // utility + region — used as the <optgroup> label
  utility: string;
  region: string;
  zones: PricingZoneOption[];
}

// Group zones by provider for the dropdown's <optgroup> headers. Groups appear
// in the order their utility is first seen in `available`, so the backend
// controls provider ordering (ConEd → SDG&E → PG&E) and we just preserve it.
export function groupPricingZones(
  available: readonly PricingZoneOption[],
): PricingZoneGroup[] {
  const groups: PricingZoneGroup[] = [];
  for (const z of available) {
    const key = `${z.utility} — ${z.region}`;
    let group = groups.find((g) => g.key === key);
    if (!group) {
      group = { key, utility: z.utility, region: z.region, zones: [] };
      groups.push(group);
    }
    group.zones.push(z);
  }
  return groups;
}
