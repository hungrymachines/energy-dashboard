import { describe, it, expect } from 'vitest';
import { rankEntities, companionsFor, findDevices, type DiscoveryHass } from '../src/utils/entity-discovery.js';

describe('rankEntities', () => {
  it('ranks a Balboa climate above a plain thermostat for hot_tub', () => {
    const hass: DiscoveryHass = {
      states: {
        'climate.balboa_spa': { attributes: { friendly_name: 'Spa' } },
        'climate.living_room': { attributes: { friendly_name: 'Living Room' } },
      },
      entities: {
        'climate.balboa_spa': { device_id: 'spa-dev', platform: 'balboa' },
        'climate.living_room': { device_id: 'lr-dev', platform: 'nest' },
      },
    };

    const results = rankEntities(hass, 'hot_tub', ['climate']);
    expect(results.map((r) => r.entityId)).toEqual(['climate.balboa_spa', 'climate.living_room']);
    expect(results[0].score).toBeGreaterThan(results[1].score);
    expect(results[0].reason).toBe('Balboa spa');
  });

  it('demotes the same Balboa climate for hvac, below a named thermostat', () => {
    const hass: DiscoveryHass = {
      states: {
        'climate.balboa_spa': { attributes: { friendly_name: 'Spa' } },
        'climate.living_room': { attributes: { friendly_name: 'Living Room Thermostat' } },
      },
      entities: {
        'climate.balboa_spa': { device_id: 'spa-dev', platform: 'balboa' },
        'climate.living_room': { device_id: 'lr-dev', platform: 'nest' },
      },
    };

    const results = rankEntities(hass, 'hvac', ['climate']);
    const bySpa = results.find((r) => r.entityId === 'climate.balboa_spa')!;
    const byThermostat = results.find((r) => r.entityId === 'climate.living_room')!;
    expect(bySpa.score).toBeLessThan(0);
    expect(byThermostat.score).toBeGreaterThan(bySpa.score);
    expect(results[0].entityId).toBe('climate.living_room');
  });

  it('matches on keywords alone with no entity/device registries present', () => {
    const hass: DiscoveryHass = {
      states: {
        'switch.pool_filter_pump': { attributes: { friendly_name: 'Pool Filter Pump' } },
        'switch.garage_light': { attributes: { friendly_name: 'Garage Light' } },
      },
    };

    const results = rankEntities(hass, 'pool_pump', ['switch']);
    const pump = results.find((r) => r.entityId === 'switch.pool_filter_pump')!;
    const other = results.find((r) => r.entityId === 'switch.garage_light')!;
    expect(pump.score).toBe(2);
    expect(pump.reason).toBe('name mentions pool');
    expect(other.score).toBe(0);
  });

  it('never drops an entity in the requested domains, even with zero score', () => {
    const hass: DiscoveryHass = {
      states: {
        'switch.a': {},
        'switch.b': {},
        'switch.c': {},
        'climate.ignored': {},
      },
    };

    const results = rankEntities(hass, 'ev_charger', ['switch']);
    expect(results.map((r) => r.entityId).sort()).toEqual(['switch.a', 'switch.b', 'switch.c']);
  });

  it('sorts descending by score, then by entity id for ties', () => {
    const hass: DiscoveryHass = {
      states: {
        'switch.b_charger': { attributes: { friendly_name: 'Charger' } },
        'switch.a_charger': { attributes: { friendly_name: 'Charger' } },
        'switch.unrelated': {},
      },
    };

    const results = rankEntities(hass, 'ev_charger', ['switch']);
    expect(results.map((r) => r.entityId)).toEqual(['switch.a_charger', 'switch.b_charger', 'switch.unrelated']);
  });
});

describe('companionsFor', () => {
  it('finds temperature, battery, and power sibling sensors per type', () => {
    const hass: DiscoveryHass = {
      states: {
        'sensor.tank_temp': { attributes: { device_class: 'temperature' } },
        'sensor.tank_power': { attributes: { device_class: 'power' } },
        'sensor.unrelated': { attributes: { device_class: 'humidity' } },
      },
      entities: {
        'water_heater.tank': { device_id: 'tank-dev' },
        'sensor.tank_temp': { device_id: 'tank-dev' },
        'sensor.tank_power': { device_id: 'tank-dev' },
        'sensor.unrelated': { device_id: 'tank-dev' },
      },
    };

    expect(companionsFor(hass, 'water_heater.tank', 'water_heater')).toEqual({
      temp_entity_id: 'sensor.tank_temp',
      power_sensor_entity_id: 'sensor.tank_power',
    });
  });

  it('finds a battery-% companion for an ev_charger', () => {
    const hass: DiscoveryHass = {
      states: {
        'sensor.charger_soc': { attributes: { device_class: 'battery' } },
        'sensor.charger_power': { attributes: { device_class: 'power' } },
      },
      entities: {
        'switch.charger': { device_id: 'dev1' },
        'sensor.charger_soc': { device_id: 'dev1' },
        'sensor.charger_power': { device_id: 'dev1' },
      },
    };

    expect(companionsFor(hass, 'switch.charger', 'ev_charger')).toEqual({
      soc_entity_id: 'sensor.charger_soc',
      power_sensor_entity_id: 'sensor.charger_power',
    });
  });

  it('only looks at sensors sharing the same device_id', () => {
    const hass: DiscoveryHass = {
      states: {
        'sensor.other_device_temp': { attributes: { device_class: 'temperature' } },
      },
      entities: {
        'water_heater.tank': { device_id: 'tank-dev' },
        'sensor.other_device_temp': { device_id: 'other-dev' },
      },
    };

    expect(companionsFor(hass, 'water_heater.tank', 'water_heater')).toEqual({});
  });

  it('returns empty when the entity registry is absent', () => {
    const hass: DiscoveryHass = {
      states: { 'water_heater.tank': {} },
    };

    expect(companionsFor(hass, 'water_heater.tank', 'water_heater')).toEqual({});
  });

  it('returns empty when the control entity has no device_id', () => {
    const hass: DiscoveryHass = {
      states: { 'water_heater.tank': {} },
      entities: { 'water_heater.tank': {} },
    };

    expect(companionsFor(hass, 'water_heater.tank', 'water_heater')).toEqual({});
  });
});

describe('findDevices', () => {
  it('offers a platform-matched entity, with its friendly name as the label', () => {
    const hass: DiscoveryHass = {
      states: { 'switch.pool_pump': { attributes: { friendly_name: 'Pool Pump' } } },
      entities: { 'switch.pool_pump': { device_id: 'dev1', platform: 'screenlogic' } },
    };

    expect(findDevices(hass, [])).toEqual([
      { type: 'pool_pump', entityId: 'switch.pool_pump', label: 'Pool Pump', reason: 'Screenlogic pool' },
    ]);
  });

  it('falls back to the entity id as the label when there is no friendly_name', () => {
    const hass: DiscoveryHass = {
      states: { 'switch.pool_pump': {} },
      entities: { 'switch.pool_pump': { device_id: 'dev1', platform: 'screenlogic' } },
    };

    expect(findDevices(hass, [])[0].label).toBe('switch.pool_pump');
  });

  it('requires only a keyword match (score 2) for robot, but a platform match (score 3) for other types', () => {
    const hass: DiscoveryHass = {
      states: {
        // Keyword-only "pool" match, score 2 — below pool_pump's threshold of 3.
        'switch.pool_filter_pump': { attributes: { friendly_name: 'Pool Filter Pump' } },
        // Keyword-only "vacuum" match (via the entity id), score 2 — meets robot's threshold of 2.
        'vacuum.living_room': {},
      },
    };

    const findings = findDevices(hass, []);
    expect(findings.map((f) => f.type)).toEqual(['robot']);
  });

  it('never offers hvac', () => {
    const hass: DiscoveryHass = {
      states: { 'climate.furnace': { attributes: { friendly_name: 'Furnace control' } } },
    };

    expect(findDevices(hass, [])).toEqual([]);
  });

  it('skips an entity already bound to an existing appliance, falling through to the next candidate', () => {
    const hass: DiscoveryHass = {
      states: {
        'switch.pool_a': { attributes: { friendly_name: 'Pool A' } },
        'switch.pool_b': { attributes: { friendly_name: 'Pool B' } },
      },
      entities: {
        'switch.pool_a': { device_id: 'a', platform: 'screenlogic' },
        'switch.pool_b': { device_id: 'b', platform: 'iaqualink' },
      },
    };

    expect(findDevices(hass, ['switch.pool_a'])).toEqual([
      { type: 'pool_pump', entityId: 'switch.pool_b', label: 'Pool B', reason: 'Iaqualink pool' },
    ]);
  });

  it('never offers the same entity under a second type whose own score falls short', () => {
    // 'climate.unit' is a platform match for hot_tub (score 3, over its
    // threshold) and, via its friendly name containing "tank", also a
    // keyword match for water_heater (score 2, under water_heater's own
    // threshold of 3 since water_heater has no platforms to match on) —
    // both rules allow the `climate` domain. Only the hot_tub finding
    // survives.
    const hass: DiscoveryHass = {
      states: { 'climate.unit': { attributes: { friendly_name: 'Balboa Tank' } } },
      entities: { 'climate.unit': { device_id: 'd1', platform: 'balboa' } },
    };

    expect(findDevices(hass, [])).toEqual([
      { type: 'hot_tub', entityId: 'climate.unit', label: 'Balboa Tank', reason: 'Balboa spa' },
    ]);
  });
});
