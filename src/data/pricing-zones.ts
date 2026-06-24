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
