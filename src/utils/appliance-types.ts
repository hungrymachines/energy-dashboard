import type { ApplianceType } from '../api/appliances.js';

/** Every machine type a home can add, in the order the panel lists them. */
export const ALL_TYPES: ReadonlyArray<ApplianceType> = [
  'hvac', 'ev_charger', 'home_battery', 'water_heater', 'solar', 'robot',
  'pool_pump', 'hot_tub',
];

/** The type names shown on the Connection Health tab. */
export const TYPE_NAMES: Partial<Record<ApplianceType, string>> = {
  hvac: 'Heating and cooling',
  ev_charger: 'EV charger',
  home_battery: 'Home battery',
  water_heater: 'Water heater',
  solar: 'Solar',
  robot: 'Robot',
  pool_pump: 'Pool pump',
  hot_tub: 'Hot tub',
};
