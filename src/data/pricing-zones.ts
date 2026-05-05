// Display labels for the eight preset pricing zones the backend supports.
// TODO: reconcile zones 3–8 against hungry-machines-api/app/services/pricing.py;
// the API is the source of truth and these labels follow when the mapping there
// is finalized. Today only zones 1 and 2 are confirmed.
export type PricingZone = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface PricingZoneLabel {
  provider: string;
  region: string;
}

export const PRICING_ZONE_LABELS: Record<PricingZone, PricingZoneLabel> = {
  1: { provider: 'SDG&E', region: 'San Diego' },
  2: { provider: 'ConEd', region: 'New York City' },
  3: { provider: 'Provider TBD', region: 'Region TBD' },
  4: { provider: 'Provider TBD', region: 'Region TBD' },
  5: { provider: 'Provider TBD', region: 'Region TBD' },
  6: { provider: 'Provider TBD', region: 'Region TBD' },
  7: { provider: 'Provider TBD', region: 'Region TBD' },
  8: { provider: 'Provider TBD', region: 'Region TBD' },
};

function labelFor(zone: number): PricingZoneLabel {
  return (
    PRICING_ZONE_LABELS[zone as PricingZone] ?? {
      provider: 'Provider TBD',
      region: 'Region TBD',
    }
  );
}

export function pricingZoneOptionLabel(zone: number): string {
  const { provider, region } = labelFor(zone);
  return `${provider} — ${region} (Zone ${zone})`;
}

export function pricingZoneFullLabel(zone: number): string {
  const { provider, region } = labelFor(zone);
  return `${provider} — ${region}`;
}
