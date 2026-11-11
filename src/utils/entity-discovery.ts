// Ranks a user's existing Home Assistant entities against each appliance
// type so the add-appliance form can suggest a likely control entity
// instead of making the user hunt through every entity_id in the house.
// Pure — no Lit, no DOM, no network. Reads only the registry shapes HA's
// own frontend hands a custom panel (`hass.states` / `.entities` / `.devices`).

import type { ApplianceType } from '../api/appliances.js';

export interface DiscoveryState {
  // HA's real state objects always carry these two; neither is read by
  // rankEntities/companionsFor, but declaring them lets a caller pass a
  // real (or realistically-stubbed) hass.states entry without TS flagging
  // it as sharing no properties with this (otherwise all-optional) type.
  entity_id?: string;
  state?: unknown;
  attributes?: {
    friendly_name?: string;
    device_class?: string;
    [key: string]: unknown;
  };
}

export interface DiscoveryEntityEntry {
  device_id?: string;
  platform?: string;
}

export interface DiscoveryDeviceEntry {
  manufacturer?: string;
  model?: string;
  name?: string;
}

export interface DiscoveryHass {
  states?: Record<string, DiscoveryState>;
  entities?: Record<string, DiscoveryEntityEntry>;
  devices?: Record<string, DiscoveryDeviceEntry>;
}

export interface DiscoveryMatch {
  entityId: string;
  score: number;
  reason: string;
}

export type CompanionField = 'temp_entity_id' | 'soc_entity_id' | 'power_sensor_entity_id';

interface DiscoveryRule {
  domains: string[];
  platforms: string[];
  keywords: RegExp;
  avoid?: RegExp;
  noun: string;
}

// Platform names are Home Assistant integration domains, checked against
// each integration's manifest on 2026-11-11. `gecko`, `ocpp`, `easee` and
// `chargepoint` are HACS custom integrations; the rest ship with HA.
const HOT_TUB_PLATFORMS = ['balboa', 'gecko', 'smarttub', 'iaqualink', 'screenlogic'];
const HOT_TUB_KEYWORDS = /spa|hot.?tub|jacuzzi/i;

export const RULES: Record<ApplianceType, DiscoveryRule | null> = {
  water_heater: {
    domains: ['switch', 'climate'],
    platforms: [],
    keywords: /water.?heater|hot.?water|boiler|tank/i,
    noun: 'water heater',
  },
  hot_tub: {
    domains: ['climate', 'water_heater'],
    platforms: HOT_TUB_PLATFORMS,
    keywords: HOT_TUB_KEYWORDS,
    noun: 'spa',
  },
  pool_pump: {
    domains: ['switch'],
    platforms: ['screenlogic', 'iaqualink', 'omnilogic'],
    keywords: /pool|filter.?pump/i,
    noun: 'pool',
  },
  ev_charger: {
    domains: ['switch'],
    platforms: ['wallbox', 'ocpp', 'easee', 'chargepoint'],
    keywords: /charger|evse|wallbox|charging/i,
    noun: 'charger',
  },
  home_battery: {
    domains: ['switch'],
    platforms: ['powerwall', 'enphase_envoy', 'tesla_fleet'],
    keywords: /battery|powerwall|storage/i,
    noun: 'battery',
  },
  robot: {
    domains: ['vacuum', 'lawn_mower'],
    platforms: [],
    keywords: /vacuum|lawn.?mower|robot/i,
    noun: 'robot',
  },
  // A spa is frequently a `climate` entity too (Balboa/Gecko controllers), so
  // without the avoid penalty it would rank as a perfectly good thermostat.
  hvac: {
    domains: ['climate'],
    platforms: [],
    keywords: /thermostat|hvac|furnace|heat.?pump/i,
    avoid: new RegExp(`${HOT_TUB_KEYWORDS.source}|${HOT_TUB_PLATFORMS.join('|')}`, 'i'),
    noun: 'thermostat',
  },
  solar: null,
  dehumidifier: null,
};

function platformLabel(platform: string): string {
  return platform.length === 0 ? platform : platform[0].toUpperCase() + platform.slice(1);
}

function searchTexts(entityId: string, state: DiscoveryState | undefined, device: DiscoveryDeviceEntry | undefined): string[] {
  const texts = [entityId, state?.attributes?.friendly_name, device?.name, device?.manufacturer, device?.model];
  return texts.filter((t): t is string => typeof t === 'string' && t.length > 0);
}

/**
 * Ranks every entity in `domains` for `type`. Every matching entity is
 * returned — this never hides an entity, only orders and annotates it.
 */
export function rankEntities(hass: DiscoveryHass, type: ApplianceType, domains: ReadonlyArray<string>): DiscoveryMatch[] {
  const rule = RULES[type];
  const states = hass.states ?? {};
  const entities = hass.entities ?? {};
  const devices = hass.devices ?? {};

  const results: DiscoveryMatch[] = [];

  for (const entityId of Object.keys(states)) {
    const domain = entityId.slice(0, entityId.indexOf('.'));
    if (!domains.includes(domain)) continue;

    if (!rule) {
      results.push({ entityId, score: 0, reason: '' });
      continue;
    }

    const state = states[entityId];
    const entry = entities[entityId];
    const device = entry?.device_id ? devices[entry.device_id] : undefined;
    const texts = searchTexts(entityId, state, device);

    let score = 0;
    let reason = '';

    if (entry?.platform && rule.platforms.includes(entry.platform)) {
      score += 3;
      reason = `${platformLabel(entry.platform)} ${rule.noun}`;
    } else if (texts.some((t) => rule.keywords.test(t))) {
      score += 2;
      reason = `name mentions ${rule.noun}`;
    }

    const avoided =
      rule.avoid !== undefined &&
      (texts.some((t) => rule.avoid!.test(t)) || (!!entry?.platform && rule.avoid.test(entry.platform)));
    if (avoided) score -= 3;

    results.push({ entityId, score, reason });
  }

  results.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.entityId.localeCompare(b.entityId)));
  return results;
}

const DEVICE_CLASS_FOR: Record<CompanionField, string> = {
  temp_entity_id: 'temperature',
  soc_entity_id: 'battery',
  power_sensor_entity_id: 'power',
};

// Which companion sensors are worth auto-filling for a given control type.
// power_sensor_entity_id is attempted for every type that has a device_id
// to look siblings up from.
const FIELDS_FOR: Record<ApplianceType, CompanionField[]> = {
  water_heater: ['temp_entity_id', 'power_sensor_entity_id'],
  hot_tub: ['temp_entity_id', 'power_sensor_entity_id'],
  ev_charger: ['soc_entity_id', 'power_sensor_entity_id'],
  home_battery: ['soc_entity_id', 'power_sensor_entity_id'],
  robot: ['soc_entity_id', 'power_sensor_entity_id'],
  pool_pump: ['power_sensor_entity_id'],
  hvac: ['power_sensor_entity_id'],
  solar: ['power_sensor_entity_id'],
  dehumidifier: ['power_sensor_entity_id'],
};

/**
 * Auxiliary sensor entities that share the control entity's device — a
 * temperature probe, a battery-% sensor, a power meter. Empty when the
 * entity registry is absent or the control entity has no device_id.
 */
export function companionsFor(
  hass: DiscoveryHass,
  entityId: string,
  type: ApplianceType,
): Partial<Record<CompanionField, string>> {
  const entities = hass.entities ?? {};
  const states = hass.states ?? {};
  const deviceId = entities[entityId]?.device_id;
  if (!deviceId) return {};

  const siblings = Object.keys(entities).filter(
    (id) => id.startsWith('sensor.') && entities[id]?.device_id === deviceId,
  );

  const result: Partial<Record<CompanionField, string>> = {};
  for (const field of FIELDS_FOR[type]) {
    const deviceClass = DEVICE_CLASS_FOR[field];
    const match = siblings.find((id) => states[id]?.attributes?.device_class === deviceClass);
    if (match) result[field] = match;
  }
  return result;
}

export interface DiscoveryFinding {
  type: ApplianceType;
  entityId: string;
  label: string;
  reason: string;
}

// Every type `findDevices` is willing to offer unprompted. hvac is left out
// on purpose — a bare thermostat is too common and too ambiguous a signal
// (half of all climate entities) to surface as a one-tap suggestion.
const DISCOVERABLE_TYPES = (Object.keys(RULES) as ApplianceType[]).filter(
  (t) => RULES[t] !== null && t !== 'hvac',
);

function displayLabel(hass: DiscoveryHass, entityId: string): string {
  const name = hass.states?.[entityId]?.attributes?.friendly_name;
  return typeof name === 'string' && name.length > 0 ? name : entityId;
}

/**
 * For the type-picker step's "Found in your Home Assistant" shortcut: the
 * single best-matching entity per discoverable type, when it scores high
 * enough to be worth a one-tap suggestion (a platform match, or for robot —
 * whose rule has no platforms to match — a plain keyword match). Never
 * offers an entity already bound to an existing appliance
 * (`existingEntityIds`), and never offers the same entity under two types;
 * when two types would both claim it, the higher-scoring type keeps it.
 */
export function findDevices(
  hass: DiscoveryHass,
  existingEntityIds: ReadonlyArray<string>,
): DiscoveryFinding[] {
  const existing = new Set(existingEntityIds);
  const byEntity = new Map<string, { type: ApplianceType; entityId: string; score: number; reason: string }>();

  for (const type of DISCOVERABLE_TYPES) {
    const rule = RULES[type];
    if (!rule) continue;
    const threshold = type === 'robot' ? 2 : 3;

    const top = rankEntities(hass, type, rule.domains).find((m) => !existing.has(m.entityId));
    if (!top || top.score < threshold) continue;

    const prior = byEntity.get(top.entityId);
    if (!prior || top.score > prior.score) {
      byEntity.set(top.entityId, { type, entityId: top.entityId, score: top.score, reason: top.reason });
    }
  }

  return [...byEntity.values()].map(({ type, entityId, reason }) => ({
    type,
    entityId,
    label: displayLabel(hass, entityId),
    reason,
  }));
}
