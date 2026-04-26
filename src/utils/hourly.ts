export function expandHourlyTo48(arr: number[]): number[] {
  if (!Array.isArray(arr) || arr.length !== 24) {
    throw new RangeError(
      `expandHourlyTo48 expects exactly 24 values, got ${Array.isArray(arr) ? arr.length : 0}`,
    );
  }
  const out: number[] = new Array(48);
  for (let i = 0; i < 24; i++) {
    out[2 * i] = arr[i];
    out[2 * i + 1] = arr[i];
  }
  return out;
}

export function collapse48ToHourly(arr: number[]): number[] {
  if (!Array.isArray(arr) || arr.length !== 48) {
    throw new RangeError(
      `collapse48ToHourly expects exactly 48 values, got ${Array.isArray(arr) ? arr.length : 0}`,
    );
  }
  const out: number[] = new Array(24);
  for (let i = 0; i < 24; i++) {
    out[i] = arr[2 * i];
  }
  return out;
}

export function hasHourlyComfortBands(prefs: {
  hourly_high_temps_f?: number[] | null;
  hourly_low_temps_f?: number[] | null;
}): boolean {
  const high = prefs.hourly_high_temps_f;
  const low = prefs.hourly_low_temps_f;
  return Array.isArray(high) && Array.isArray(low) && high.length === 24 && low.length === 24;
}

export function hasCustomRates(rates: { source: 'custom' | 'zone' }): boolean {
  return rates.source === 'custom';
}
