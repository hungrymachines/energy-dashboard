import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HmApplianceForm } from '../src/ui/appliance-form.js';
import { clearTokens, setApiBase, setTokens } from '../src/api/client.js';
import type { DiscoveryHass } from '../src/utils/entity-discovery.js';

if (!customElements.get('hm-appliance-form')) {
  customElements.define('hm-appliance-form', HmApplianceForm);
}

type FormEl = HmApplianceForm & { updateComplete: Promise<boolean> };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function flush(el: FormEl): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await el.updateComplete;
    await Promise.resolve();
  }
}

// v2.0+: appliance form now requires `hass` to populate the entity picker.
// Tests stub a small set of climate/switch/sensor entities so the dropdowns
// are non-empty and the entity_id field can be filled.
const TEST_HASS = {
  states: {
    'climate.living_room': { entity_id: 'climate.living_room' },
    'climate.bedroom': { entity_id: 'climate.bedroom' },
    'switch.tesla_charger': { entity_id: 'switch.tesla_charger' },
    'switch.water_heater': { entity_id: 'switch.water_heater' },
    'switch.home_battery': { entity_id: 'switch.home_battery' },
    'sensor.tesla_battery_level': { entity_id: 'sensor.tesla_battery_level' },
    'sensor.tank_temp': { entity_id: 'sensor.tank_temp' },
    'sensor.indoor_temp': { entity_id: 'sensor.indoor_temp' },
    'sensor.ac_power': { entity_id: 'sensor.ac_power' },
    'sensor.solar_production': {
      entity_id: 'sensor.solar_production',
      attributes: { device_class: 'power' },
    },
    'humidifier.basement': { entity_id: 'humidifier.basement' },
    'sensor.basement_rh': { entity_id: 'sensor.basement_rh' },
    'vacuum.living_room': { entity_id: 'vacuum.living_room' },
    'lawn_mower.backyard': { entity_id: 'lawn_mower.backyard' },
    'sensor.robot_battery': { entity_id: 'sensor.robot_battery' },
    'switch.pool_pump': { entity_id: 'switch.pool_pump' },
    'water_heater.hot_tub': { entity_id: 'water_heater.hot_tub' },
    'sensor.hot_tub_temp': { entity_id: 'sensor.hot_tub_temp' },
  },
};

// adds the entity/device registries TEST_HASS omits, so
// rankEntities/companionsFor have something to score and fill from.
// 'switch.tank_heater' is the only water_heater switch that scores above
// zero (keyword "tank"); 'switch.garage_light' is a same-domain decoy that
// scores zero and has no sibling sensors.
const TEST_HASS_DISCOVERY: DiscoveryHass = {
  states: {
    'switch.tank_heater': {},
    'switch.boiler_unit': {},
    'switch.garage_light': {},
    'climate.living_room': {},
    'sensor.tank_heater_temp': { attributes: { device_class: 'temperature' } },
    'sensor.unrelated': {},
  },
  entities: {
    'switch.tank_heater': { device_id: 'wh-dev' },
    'switch.boiler_unit': { device_id: 'boiler-dev' },
    'switch.garage_light': { device_id: 'light-dev' },
    'sensor.tank_heater_temp': { device_id: 'wh-dev' },
    'sensor.unrelated': { device_id: 'light-dev' },
  },
  devices: {},
};

// A hass with no entity/device registry at all — rankEntities can still
// score by keyword, but companionsFor has no device_id to look siblings
// up from, so no aux field can ever auto-fill against it.
const TEST_HASS_NO_REGISTRY: DiscoveryHass = {
  states: {
    'switch.garage_light': {},
    'switch.other': {},
  },
};

// a Balboa-platform spa entity scores 3 (a platform match) for
// hot_tub — above findDevices' threshold, unlike TEST_HASS_DISCOVERY's
// keyword-only (score 2) water_heater candidates — with a sibling
// temperature sensor so picking the suggestion also exercises the
// Companion fill.
const TEST_HASS_FOUND_DEVICES: DiscoveryHass = {
  states: {
    'climate.spa': { attributes: { friendly_name: 'Spa' } },
    'sensor.spa_temp': { attributes: { device_class: 'temperature' } },
  },
  entities: {
    'climate.spa': { device_id: 'spa-dev', platform: 'balboa' },
    'sensor.spa_temp': { device_id: 'spa-dev' },
  },
  devices: {},
};

function mountForm(hass: DiscoveryHass = TEST_HASS): FormEl {
  const el = document.createElement('hm-appliance-form') as FormEl;
  el.hass = hass;
  el.open = true;
  document.body.appendChild(el);
  return el;
}

function selectByName(root: ShadowRoot, name: string): HTMLSelectElement {
  const el = root.querySelector<HTMLSelectElement>(`select[name="${name}"]`);
  if (!el) throw new Error(`select[name="${name}"] not found`);
  return el;
}

function pickEntity(root: ShadowRoot, value: string): void {
  const sel = selectByName(root, 'entity_id');
  sel.value = value;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
}

function buttonByText(root: ShadowRoot, text: string): HTMLButtonElement | undefined {
  return Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(
    (b) => b.textContent?.trim() === text,
  );
}

function buttonByDataType(root: ShadowRoot, t: string): HTMLButtonElement | undefined {
  return root.querySelector<HTMLButtonElement>(`button[data-type="${t}"]`) ?? undefined;
}

function inputByName(root: ShadowRoot, name: string): HTMLInputElement {
  const el = root.querySelector<HTMLInputElement>(`input[name="${name}"]`);
  if (!el) throw new Error(`input[name="${name}"] not found`);
  return el;
}

describe('hm-appliance-form', () => {
  beforeEach(() => {
    setApiBase('https://api.example.test');
    setTokens({ access: 'ACCESS', refresh: 'REFRESH' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    clearTokens();
  });

  it('initial render shows step 1 with all nine type buttons', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(null)));
    const el = mountForm();
    await flush(el);

    const root = el.shadowRoot!;
    const typeButtons = root.querySelectorAll<HTMLButtonElement>('button.type-btn');
    expect(typeButtons.length).toBe(9);
    const types = Array.from(typeButtons).map((b) => b.dataset.type);
    expect(types.sort()).toEqual([
      'dehumidifier',
      'ev_charger',
      'home_battery',
      'hot_tub',
      'hvac',
      'pool_pump',
      'robot',
      'solar',
      'water_heater',
    ]);
  });

  it("clicking 'HVAC' advances to step 2 with HVAC-specific fields", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(null)));
    const el = mountForm();
    await flush(el);

    buttonByDataType(el.shadowRoot!, 'hvac')!.click();
    await flush(el);

    const root = el.shadowRoot!;
    expect(root.querySelector('select[name="hvac_type"]')).not.toBeNull();
    expect(root.querySelector('input[name="home_size_sqft"]')).not.toBeNull();
    expect(root.querySelector('input[name="name"]')).not.toBeNull();
    // Step 1 type buttons no longer rendered.
    expect(root.querySelectorAll('button.type-btn').length).toBe(0);
  });

  it('submit with empty name does NOT call fetch', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: 'a-1' }));
    vi.stubGlobal('fetch', fetchMock);
    const el = mountForm();
    await flush(el);

    buttonByDataType(el.shadowRoot!, 'hvac')!.click();
    await flush(el);

    const root = el.shadowRoot!;
    // Fill HVAC but leave name empty.
    const homeSize = inputByName(root, 'home_size_sqft');
    homeSize.value = '1800';
    homeSize.dispatchEvent(new Event('input', { bubbles: true }));
    await flush(el);

    const submitBtn = buttonByText(root, 'Add');
    expect(submitBtn).toBeDefined();
    expect(submitBtn!.disabled).toBe(true);
    submitBtn!.click();
    await flush(el);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('successful submit posts to /api/v1/appliances and dispatches appliance-created', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      calls.push({ url, init });
      return jsonResponse({ appliance_id: 'app-123' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const el = mountForm();
    await flush(el);

    let createdEvent: CustomEvent | null = null;
    el.addEventListener('appliance-created', ((e: Event) => {
      createdEvent = e as CustomEvent;
    }) as EventListener);

    buttonByDataType(el.shadowRoot!, 'hvac')!.click();
    await flush(el);

    const root = el.shadowRoot!;
    const name = inputByName(root, 'name');
    name.value = 'My HVAC';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    const homeSize = inputByName(root, 'home_size_sqft');
    homeSize.value = '1800';
    homeSize.dispatchEvent(new Event('input', { bubbles: true }));
    await flush(el);

    const hvacType = root.querySelector<HTMLSelectElement>('select[name="hvac_type"]')!;
    hvacType.value = 'heat_pump';
    hvacType.dispatchEvent(new Event('change', { bubbles: true }));
    pickEntity(root, 'climate.living_room');
    await flush(el);

    const submitBtn = buttonByText(root, 'Add');
    expect(submitBtn!.disabled).toBe(false);
    submitBtn!.click();
    await flush(el);

    const postCall = calls.find(
      (c) => c.url.endsWith('/api/v1/appliances') && c.init?.method === 'POST',
    );
    expect(postCall).toBeDefined();
    const body = JSON.parse(String(postCall!.init!.body));
    expect(body.appliance_type).toBe('hvac');
    expect(body.name).toBe('My HVAC');
    expect(body.config).toMatchObject({
      hvac_type: 'heat_pump',
      home_size_sqft: 1800,
      entity_id: 'climate.living_room',
    });

    expect(createdEvent).not.toBeNull();
    expect(el.open).toBe(false);
  });

  it('hvac form seeds power_sensor_entity_id in default values', async () => {
    // Smoke test that the form's state model includes the new field.
    // Render-level visibility is a separate concern tracked alongside
    // the pre-existing aux-field render quirk (the indoor_temp_entity_id
    // picker has the same issue and was already silently missing from
    // the DOM — neither field renders today; both should). The
    // functional path (defaults → payload) is what this test pins.
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(null)));
    const el = mountForm();
    await flush(el);

    buttonByDataType(el.shadowRoot!, 'hvac')!.click();
    await flush(el);

    expect(
      el._values['power_sensor_entity_id'],
      'power_sensor_entity_id seeded into form state',
    ).toBe('');
  });

  it('hvac form posts power_sensor_entity_id when present in state', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      calls.push({ url, init });
      return jsonResponse({ appliance_id: 'app-123' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const el = mountForm();
    await flush(el);

    buttonByDataType(el.shadowRoot!, 'hvac')!.click();
    await flush(el);

    const root = el.shadowRoot!;
    const name = inputByName(root, 'name');
    name.value = 'AC with smart plug';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    const homeSize = inputByName(root, 'home_size_sqft');
    homeSize.value = '1200';
    homeSize.dispatchEvent(new Event('input', { bubbles: true }));
    pickEntity(root, 'climate.living_room');
    // Set the power sensor value directly in form state — the input
    // path via the rendered select would be cleaner but works around
    // the pre-existing aux-render issue (see note on the previous
    // test). The contract this pins: when the form's state has the
    // value set, the POST body includes it under the expected key.
    el._values = { ...el._values, power_sensor_entity_id: 'sensor.ac_power' };
    await flush(el);

    buttonByText(root, 'Add')!.click();
    await flush(el);

    const postCall = calls.find(
      (c) => c.url.endsWith('/api/v1/appliances') && c.init?.method === 'POST',
    );
    expect(postCall).toBeDefined();
    const body = JSON.parse(String(postCall!.init!.body));
    expect(body.config.power_sensor_entity_id).toBe('sensor.ac_power');
  });

  it('hvac form omits power_sensor_entity_id when blank in state', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      calls.push({ url, init });
      return jsonResponse({ appliance_id: 'app-123' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const el = mountForm();
    await flush(el);

    buttonByDataType(el.shadowRoot!, 'hvac')!.click();
    await flush(el);

    const root = el.shadowRoot!;
    const name = inputByName(root, 'name');
    name.value = 'Basic AC';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    const homeSize = inputByName(root, 'home_size_sqft');
    homeSize.value = '1200';
    homeSize.dispatchEvent(new Event('input', { bubbles: true }));
    pickEntity(root, 'climate.living_room');
    await flush(el);

    buttonByText(root, 'Add')!.click();
    await flush(el);

    const postCall = calls.find(
      (c) => c.url.endsWith('/api/v1/appliances') && c.init?.method === 'POST',
    );
    const body = JSON.parse(String(postCall!.init!.body));
    expect(body.config.power_sensor_entity_id).toBeUndefined();
  });

  it('failed submit (500) renders error message and leaves form open', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ detail: 'server is down' }, 500),
    );
    vi.stubGlobal('fetch', fetchMock);

    const el = mountForm();
    await flush(el);

    buttonByDataType(el.shadowRoot!, 'hvac')!.click();
    await flush(el);

    const root = el.shadowRoot!;
    const name = inputByName(root, 'name');
    name.value = 'My HVAC';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    const homeSize = inputByName(root, 'home_size_sqft');
    homeSize.value = '1800';
    homeSize.dispatchEvent(new Event('input', { bubbles: true }));
    pickEntity(root, 'climate.living_room');
    await flush(el);

    buttonByText(root, 'Add')!.click();
    await flush(el);

    expect(el.open).toBe(true);
    const root2 = el.shadowRoot!;
    expect(root2.querySelector('.top-error')).not.toBeNull();
    expect(root2.querySelector('.top-error')!.textContent).toContain('server is down');
    // Inputs preserved
    expect(inputByName(root2, 'name').value).toBe('My HVAC');
  });

  it("water heater: insulation_factor input defaults to '0.03'", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(null)));
    const el = mountForm();
    await flush(el);

    buttonByDataType(el.shadowRoot!, 'water_heater')!.click();
    await flush(el);

    const root = el.shadowRoot!;
    const insul = inputByName(root, 'insulation_factor');
    expect(insul.value).toBe('0.03');
    expect(insul.getAttribute('min')).toBe('0.01');
    expect(insul.getAttribute('max')).toBe('0.05');
    expect(insul.getAttribute('step')).toBe('0.005');
  });

  it("water heater: entering '0.5' for insulation_factor fails validation", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(null)));
    const el = mountForm();
    await flush(el);

    buttonByDataType(el.shadowRoot!, 'water_heater')!.click();
    await flush(el);

    const root = el.shadowRoot!;
    const name = inputByName(root, 'name');
    name.value = 'Tank';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    inputByName(root, 'tank_size_gallons').value = '50';
    inputByName(root, 'tank_size_gallons').dispatchEvent(new Event('input', { bubbles: true }));
    inputByName(root, 'element_watts').value = '4500';
    inputByName(root, 'element_watts').dispatchEvent(new Event('input', { bubbles: true }));
    const insul = inputByName(root, 'insulation_factor');
    insul.value = '0.5';
    insul.dispatchEvent(new Event('input', { bubbles: true }));
    await flush(el);

    const errEl = root.querySelector('.field-error');
    expect(errEl).not.toBeNull();
    const errs = Array.from(root.querySelectorAll('.field-error')).map((e) => e.textContent);
    expect(errs.some((t) => t?.includes('Must be 0.01-0.05'))).toBe(true);

    const submitBtn = buttonByText(root, 'Add');
    expect(submitBtn!.disabled).toBe(true);
  });

  it("water heater: entering '0.025' for insulation_factor validates clean", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(null)));
    const el = mountForm();
    await flush(el);

    buttonByDataType(el.shadowRoot!, 'water_heater')!.click();
    await flush(el);

    const root = el.shadowRoot!;
    const name = inputByName(root, 'name');
    name.value = 'Tank';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    inputByName(root, 'tank_size_gallons').value = '50';
    inputByName(root, 'tank_size_gallons').dispatchEvent(new Event('input', { bubbles: true }));
    inputByName(root, 'element_watts').value = '4500';
    inputByName(root, 'element_watts').dispatchEvent(new Event('input', { bubbles: true }));
    const insul = inputByName(root, 'insulation_factor');
    insul.value = '0.025';
    insul.dispatchEvent(new Event('input', { bubbles: true }));
    pickEntity(root, 'switch.water_heater');
    await flush(el);

    const errs = Array.from(root.querySelectorAll('.field-error')).map((e) => e.textContent);
    expect(errs.some((t) => t?.includes('Must be 0.01-0.05'))).toBe(false);

    const submitBtn = buttonByText(root, 'Add');
    expect(submitBtn!.disabled).toBe(false);
  });

  it('water heater: submitting with 0.03 calls create with config.insulation_factor === 0.03', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      calls.push({ url, init });
      return jsonResponse({ appliance_id: 'app-wh-1' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const el = mountForm();
    await flush(el);

    buttonByDataType(el.shadowRoot!, 'water_heater')!.click();
    await flush(el);

    const root = el.shadowRoot!;
    const name = inputByName(root, 'name');
    name.value = 'Tank';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    inputByName(root, 'tank_size_gallons').value = '50';
    inputByName(root, 'tank_size_gallons').dispatchEvent(new Event('input', { bubbles: true }));
    inputByName(root, 'element_watts').value = '4500';
    inputByName(root, 'element_watts').dispatchEvent(new Event('input', { bubbles: true }));
    // insulation_factor stays at default '0.03'
    pickEntity(root, 'switch.water_heater');
    await flush(el);

    const submitBtn = buttonByText(root, 'Add');
    expect(submitBtn!.disabled).toBe(false);
    submitBtn!.click();
    await flush(el);

    const postCall = calls.find(
      (c) => c.url.endsWith('/api/v1/appliances') && c.init?.method === 'POST',
    );
    expect(postCall).toBeDefined();
    const body = JSON.parse(String(postCall!.init!.body));
    expect(body.appliance_type).toBe('water_heater');
    expect(body.config.insulation_factor).toBe(0.03);
    expect(body.config.entity_id).toBe('switch.water_heater');
  });

  it("clicking 'Cancel' on step 2 dispatches cancelled and the form resets to step 1", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(null)));
    const el = mountForm();
    await flush(el);

    buttonByDataType(el.shadowRoot!, 'hvac')!.click();
    await flush(el);

    let cancelledFired = false;
    el.addEventListener('cancelled', () => {
      cancelledFired = true;
    });

    buttonByText(el.shadowRoot!, 'Cancel')!.click();
    await flush(el);

    expect(cancelledFired).toBe(true);
    expect(el.open).toBe(false);

    // Re-open the form: should be back to step 1 (type picker).
    el.open = true;
    await flush(el);
    const root = el.shadowRoot!;
    expect(root.querySelectorAll('button.type-btn').length).toBe(9);
    expect(root.querySelector('input[name="name"]')).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Solar — forecast-only appliance, no entity_id, system size + orientation
  // -----------------------------------------------------------------------

  it("clicking 'Solar PV' advances to step 2 with system_size_kw / azimuth / tilt and NO entity picker", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(null)));
    const el = mountForm();
    await flush(el);

    buttonByDataType(el.shadowRoot!, 'solar')!.click();
    await flush(el);

    const root = el.shadowRoot!;
    expect(root.querySelector('input[name="system_size_kw"]')).not.toBeNull();
    expect(root.querySelector('input[name="azimuth_degrees"]')).not.toBeNull();
    expect(root.querySelector('input[name="tilt_degrees"]')).not.toBeNull();
    // Solar is forecast-only — no Home Assistant control surface.
    expect(root.querySelector('select[name="entity_id"]')).toBeNull();
    // Orientation defaults: south-facing (180), 20° tilt.
    expect(inputByName(root, 'azimuth_degrees').value).toBe('180');
    expect(inputByName(root, 'tilt_degrees').value).toBe('20');
  });

  it('solar: submit posts the right config shape and dispatches appliance-created', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      calls.push({ url, init });
      return jsonResponse({ appliance_id: 'app-solar-1' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const el = mountForm();
    await flush(el);

    let createdEvent: CustomEvent | null = null;
    el.addEventListener('appliance-created', ((e: Event) => {
      createdEvent = e as CustomEvent;
    }) as EventListener);

    buttonByDataType(el.shadowRoot!, 'solar')!.click();
    await flush(el);

    const root = el.shadowRoot!;
    inputByName(root, 'name').value = 'Roof PV';
    inputByName(root, 'name').dispatchEvent(new Event('input', { bubbles: true }));
    inputByName(root, 'system_size_kw').value = '8.5';
    inputByName(root, 'system_size_kw').dispatchEvent(new Event('input', { bubbles: true }));
    // Leave azimuth and tilt at their defaults.
    await flush(el);

    const submitBtn = buttonByText(root, 'Add');
    expect(submitBtn!.disabled).toBe(false);
    submitBtn!.click();
    await flush(el);

    const postCall = calls.find(
      (c) => c.url.endsWith('/api/v1/appliances') && c.init?.method === 'POST',
    );
    expect(postCall).toBeDefined();
    const body = JSON.parse(String(postCall!.init!.body));
    expect(body.appliance_type).toBe('solar');
    expect(body.name).toBe('Roof PV');
    expect(body.config).toEqual({
      system_size_kw: 8.5,
      azimuth_degrees: 180,
      tilt_degrees: 20,
    });
    // The entity_id field must NOT be on the request.
    expect(body.config.entity_id).toBeUndefined();

    expect(createdEvent).not.toBeNull();
    expect(el.open).toBe(false);
  });

  it('solar: production-sensor picker renders inside typeFields, entity_id picker stays absent', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(null)));
    const el = mountForm();
    await flush(el);

    buttonByDataType(el.shadowRoot!, 'solar')!.click();
    await flush(el);

    const root = el.shadowRoot!;
    const picker = selectByName(root, 'production_sensor_entity_id');
    const options = Array.from(picker.options).map((o) => o.value);
    expect(options[0]).toBe('');
    expect(options).toContain('sensor.solar_production');
    // Solar still has no Home Assistant control surface.
    expect(root.querySelector('select[name="entity_id"]')).toBeNull();
  });

  it('solar: choosing the production sensor puts it on the POST config', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      calls.push({ url, init });
      return jsonResponse({ appliance_id: 'app-solar-2' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const el = mountForm();
    await flush(el);

    buttonByDataType(el.shadowRoot!, 'solar')!.click();
    await flush(el);

    const root = el.shadowRoot!;
    inputByName(root, 'name').value = 'Roof PV';
    inputByName(root, 'name').dispatchEvent(new Event('input', { bubbles: true }));
    inputByName(root, 'system_size_kw').value = '8.5';
    inputByName(root, 'system_size_kw').dispatchEvent(new Event('input', { bubbles: true }));
    const picker = selectByName(root, 'production_sensor_entity_id');
    picker.value = 'sensor.solar_production';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    await flush(el);

    buttonByText(root, 'Add')!.click();
    await flush(el);

    const postCall = calls.find(
      (c) => c.url.endsWith('/api/v1/appliances') && c.init?.method === 'POST',
    );
    const body = JSON.parse(String(postCall!.init!.body));
    expect(body.config).toEqual({
      system_size_kw: 8.5,
      azimuth_degrees: 180,
      tilt_degrees: 20,
      production_sensor_entity_id: 'sensor.solar_production',
    });
  });

  it('solar edit-mode pre-selects the stored production sensor', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ id: 'app-solar-1' })));
    const el = mountForm();
    const existing = {
      id: 'app-solar-1',
      user_id: 'user-1',
      appliance_type: 'solar' as const,
      name: 'Roof PV',
      config: {
        system_size_kw: 8.5,
        azimuth_degrees: 180,
        tilt_degrees: 20,
        production_sensor_entity_id: 'sensor.solar_production',
      },
      is_active: true,
      created_at: new Date().toISOString(),
    };
    el.existingAppliances = [existing];
    el.editing = existing;
    await flush(el);

    const root = el.shadowRoot!;
    expect(selectByName(root, 'production_sensor_entity_id').value).toBe('sensor.solar_production');
  });

  it('solar: empty system_size_kw blocks submit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(null)));
    const el = mountForm();
    await flush(el);

    buttonByDataType(el.shadowRoot!, 'solar')!.click();
    await flush(el);

    const root = el.shadowRoot!;
    inputByName(root, 'name').value = 'Roof PV';
    inputByName(root, 'name').dispatchEvent(new Event('input', { bubbles: true }));
    // system_size_kw left blank.
    await flush(el);

    const submitBtn = buttonByText(root, 'Add');
    expect(submitBtn!.disabled).toBe(true);
  });

  it('dehumidifier: submit posts humidifier entity + required temp sensor and optional extras', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        calls.push({ url, init });
        return jsonResponse({ appliance_id: 'app-dehu-1' });
      }),
    );

    const el = mountForm();
    await flush(el);
    buttonByDataType(el.shadowRoot!, 'dehumidifier')!.click();
    await flush(el);

    const root = el.shadowRoot!;
    inputByName(root, 'name').value = 'Basement Dehu';
    inputByName(root, 'name').dispatchEvent(new Event('input', { bubbles: true }));
    // Aux sensors are set directly in form state — the nested conditional
    // <select>s don't materialize under happy-dom (same pre-existing
    // aux-render quirk the HVAC power-sensor test works around). This pins
    // the contract: given the state, the POST body carries the right keys.
    (el as unknown as { _values: Record<string, string> })._values = {
      ...(el as unknown as { _values: Record<string, string> })._values,
      indoor_temp_entity_id: 'sensor.indoor_temp',
      indoor_humidity_entity_id: 'sensor.basement_rh',
    };
    // pickEntity fires last so _setValue re-validates the merged values
    // (clearing the required-temp error) and the entity picker renders.
    pickEntity(root, 'humidifier.basement');
    await flush(el);

    const submitBtn = buttonByText(root, 'Add');
    expect(submitBtn!.disabled).toBe(false);
    submitBtn!.click();
    await flush(el);

    const postCall = calls.find(
      (c) => c.url.endsWith('/api/v1/appliances') && c.init?.method === 'POST',
    );
    expect(postCall).toBeDefined();
    const body = JSON.parse(String(postCall!.init!.body));
    expect(body.appliance_type).toBe('dehumidifier');
    expect(body.name).toBe('Basement Dehu');
    expect(body.config.entity_id).toBe('humidifier.basement');
    expect(body.config.indoor_temp_entity_id).toBe('sensor.indoor_temp');
    expect(body.config.indoor_humidity_entity_id).toBe('sensor.basement_rh');
    // No power sensor picked → omitted; capacity omitted.
    expect(body.config.power_sensor_entity_id).toBeUndefined();
    expect(body.config.capacity_pints_per_day).toBeUndefined();
  });

  it('dehumidifier: missing required room-temp sensor blocks submit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(null)));
    const el = mountForm();
    await flush(el);
    buttonByDataType(el.shadowRoot!, 'dehumidifier')!.click();
    await flush(el);

    const root = el.shadowRoot!;
    inputByName(root, 'name').value = 'Basement Dehu';
    inputByName(root, 'name').dispatchEvent(new Event('input', { bubbles: true }));
    pickEntity(root, 'humidifier.basement');
    // indoor_temp_entity_id left unset.
    await flush(el);

    expect(buttonByText(root, 'Add')!.disabled).toBe(true);
  });

  // -----------------------------------------------------------------------
  // multi-HVAC support: distinct climate entities per HVAC,
  // client-side guard against binding two HVACs to the same entity.
  // -----------------------------------------------------------------------

  it('two HVAC appliances can be modeled back-to-back with distinct entity bindings', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      calls.push({ url, init });
      return jsonResponse({ appliance_id: 'app-' + calls.length });
    });
    vi.stubGlobal('fetch', fetchMock);

    // First HVAC — register against the Living Room climate entity.
    const el = mountForm();
    await flush(el);

    buttonByDataType(el.shadowRoot!, 'hvac')!.click();
    await flush(el);
    {
      const root = el.shadowRoot!;
      inputByName(root, 'name').value = 'Living Room';
      inputByName(root, 'name').dispatchEvent(new Event('input', { bubbles: true }));
      inputByName(root, 'home_size_sqft').value = '1200';
      inputByName(root, 'home_size_sqft').dispatchEvent(new Event('input', { bubbles: true }));
      pickEntity(root, 'climate.living_room');
      await flush(el);
      buttonByText(root, 'Add')!.click();
      await flush(el);
    }

    // After the first create, the panel would re-open the form with the
    // existing HVAC available. Simulate that by re-opening with the
    // new appliance in `existingAppliances`.
    el.existingAppliances = [
      {
        id: 'app-1',
        user_id: 'user-1',
        appliance_type: 'hvac',
        name: 'Living Room',
        config: { entity_id: 'climate.living_room', hvac_type: 'central_ac', home_size_sqft: 1200 },
        is_active: true,
        created_at: new Date().toISOString(),
      },
    ];
    el.open = true;
    await flush(el);

    // Second HVAC — bind to the bedroom entity. The form must accept it.
    buttonByDataType(el.shadowRoot!, 'hvac')!.click();
    await flush(el);
    {
      const root = el.shadowRoot!;
      inputByName(root, 'name').value = 'Bedroom';
      inputByName(root, 'name').dispatchEvent(new Event('input', { bubbles: true }));
      inputByName(root, 'home_size_sqft').value = '900';
      inputByName(root, 'home_size_sqft').dispatchEvent(new Event('input', { bubbles: true }));
      pickEntity(root, 'climate.bedroom');
      await flush(el);
      const submitBtn = buttonByText(root, 'Add');
      expect(submitBtn!.disabled).toBe(false);
      submitBtn!.click();
      await flush(el);
    }

    const posts = calls.filter(
      (c) => c.url.endsWith('/api/v1/appliances') && c.init?.method === 'POST',
    );
    expect(posts.length).toBe(2);

    const firstBody = JSON.parse(String(posts[0]!.init!.body));
    const secondBody = JSON.parse(String(posts[1]!.init!.body));
    expect(firstBody.appliance_type).toBe('hvac');
    expect(secondBody.appliance_type).toBe('hvac');
    expect(firstBody.name).toBe('Living Room');
    expect(secondBody.name).toBe('Bedroom');
    expect(firstBody.config.entity_id).toBe('climate.living_room');
    expect(secondBody.config.entity_id).toBe('climate.bedroom');
    // Distinct entity bindings — the multi-HVAC contract.
    expect(firstBody.config.entity_id).not.toBe(secondBody.config.entity_id);
  });

  it('hvac form blocks submit when entity_id collides with an existing HVAC', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ appliance_id: 'app-x' })));
    const el = mountForm();
    el.existingAppliances = [
      {
        id: 'app-1',
        user_id: 'user-1',
        appliance_type: 'hvac',
        name: 'Living Room',
        config: { entity_id: 'climate.living_room', hvac_type: 'central_ac', home_size_sqft: 1200 },
        is_active: true,
        created_at: new Date().toISOString(),
      },
    ];
    await flush(el);

    buttonByDataType(el.shadowRoot!, 'hvac')!.click();
    await flush(el);

    const root = el.shadowRoot!;
    inputByName(root, 'name').value = 'Duplicate Try';
    inputByName(root, 'name').dispatchEvent(new Event('input', { bubbles: true }));
    inputByName(root, 'home_size_sqft').value = '1000';
    inputByName(root, 'home_size_sqft').dispatchEvent(new Event('input', { bubbles: true }));
    pickEntity(root, 'climate.living_room');
    await flush(el);

    const errs = Array.from(root.querySelectorAll('.field-error')).map((e) => e.textContent ?? '');
    expect(
      errs.some((t) => t.includes('Living Room') && t.includes('climate.living_room')),
      'collision error mentions the conflicting appliance name and entity',
    ).toBe(true);
    expect(buttonByText(root, 'Add')!.disabled).toBe(true);
  });

  it('hvac edit-mode allows keeping the same entity_id (self-collision is not flagged)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ id: 'app-1' })));
    const el = mountForm();
    const existing = {
      id: 'app-1',
      user_id: 'user-1',
      appliance_type: 'hvac' as const,
      name: 'Living Room',
      config: { entity_id: 'climate.living_room', hvac_type: 'central_ac', home_size_sqft: 1200 },
      is_active: true,
      created_at: new Date().toISOString(),
    };
    el.existingAppliances = [existing];
    el.editing = existing;
    await flush(el);

    // No type-picker in edit mode; the form should land directly in
    // step 2 with the existing values seeded and no collision error.
    const root = el.shadowRoot!;
    const errs = Array.from(root.querySelectorAll('.field-error')).map((e) => e.textContent ?? '');
    expect(errs.some((t) => t.includes('already bound'))).toBe(false);
    const saveBtn = buttonByText(root, 'Save');
    expect(saveBtn).toBeDefined();
    expect(saveBtn!.disabled).toBe(false);
  });

  it('solar: out-of-range tilt is rejected', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(null)));
    const el = mountForm();
    await flush(el);

    buttonByDataType(el.shadowRoot!, 'solar')!.click();
    await flush(el);

    const root = el.shadowRoot!;
    inputByName(root, 'name').value = 'Roof PV';
    inputByName(root, 'name').dispatchEvent(new Event('input', { bubbles: true }));
    inputByName(root, 'system_size_kw').value = '5';
    inputByName(root, 'system_size_kw').dispatchEvent(new Event('input', { bubbles: true }));
    inputByName(root, 'tilt_degrees').value = '120';
    inputByName(root, 'tilt_degrees').dispatchEvent(new Event('input', { bubbles: true }));
    await flush(el);

    const errs = Array.from(root.querySelectorAll('.field-error')).map((e) => e.textContent);
    expect(errs.some((t) => t?.includes('Must be 0-90°'))).toBe(true);
    expect(buttonByText(root, 'Add')!.disabled).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Robot (vacuum / mower) — dock-charging POC, tasks-window-aware
  // -----------------------------------------------------------------------

  it("clicking 'Home robot' advances to step 2 with battery_capacity_kwh / max_charge_rate_kw defaults", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(null)));
    const el = mountForm();
    await flush(el);

    buttonByDataType(el.shadowRoot!, 'robot')!.click();
    await flush(el);

    const root = el.shadowRoot!;
    expect(inputByName(root, 'battery_capacity_kwh').value).toBe('0.2');
    expect(inputByName(root, 'max_charge_rate_kw').value).toBe('0.05');
    expect(root.querySelector('input[name="name"]')).not.toBeNull();
    // Step 1 type buttons no longer rendered.
    expect(root.querySelectorAll('button.type-btn').length).toBe(0);
  });

  it('robot: entity picker lists both vacuum.* and lawn_mower.* entities', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(null)));
    const el = mountForm();
    await flush(el);

    buttonByDataType(el.shadowRoot!, 'robot')!.click();
    await flush(el);

    const root = el.shadowRoot!;
    const sel = selectByName(root, 'entity_id');
    const optionValues = Array.from(sel.querySelectorAll('option')).map((o) => o.value);
    expect(optionValues).toContain('vacuum.living_room');
    expect(optionValues).toContain('lawn_mower.backyard');
  });

  it('robot: submit posts battery_capacity_kwh/max_charge_rate_kw as numbers, entity_id, and omits soc_entity_id when blank', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      calls.push({ url, init });
      return jsonResponse({ appliance_id: 'app-robot-1' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const el = mountForm();
    await flush(el);

    let createdEvent: CustomEvent | null = null;
    el.addEventListener('appliance-created', ((e: Event) => {
      createdEvent = e as CustomEvent;
    }) as EventListener);

    buttonByDataType(el.shadowRoot!, 'robot')!.click();
    await flush(el);

    const root = el.shadowRoot!;
    inputByName(root, 'name').value = 'Kitchen Vacuum';
    inputByName(root, 'name').dispatchEvent(new Event('input', { bubbles: true }));
    // Battery capacity + charge rate left at their defaults (0.2 / 0.05).
    pickEntity(root, 'vacuum.living_room');
    await flush(el);

    const submitBtn = buttonByText(root, 'Add');
    expect(submitBtn!.disabled).toBe(false);
    submitBtn!.click();
    await flush(el);

    const postCall = calls.find(
      (c) => c.url.endsWith('/api/v1/appliances') && c.init?.method === 'POST',
    );
    expect(postCall).toBeDefined();
    const body = JSON.parse(String(postCall!.init!.body));
    expect(body.appliance_type).toBe('robot');
    expect(body.name).toBe('Kitchen Vacuum');
    expect(body.config).toEqual({
      battery_capacity_kwh: 0.2,
      max_charge_rate_kw: 0.05,
      entity_id: 'vacuum.living_room',
    });
    expect(body.config.soc_entity_id).toBeUndefined();

    expect(createdEvent).not.toBeNull();
    expect(el.open).toBe(false);
  });

  it('robot: soc_entity_id included in config when a battery sensor is set, works with lawn_mower.* too', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      calls.push({ url, init });
      return jsonResponse({ appliance_id: 'app-robot-2' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const el = mountForm();
    await flush(el);

    buttonByDataType(el.shadowRoot!, 'robot')!.click();
    await flush(el);

    const root = el.shadowRoot!;
    inputByName(root, 'name').value = 'Backyard Mower';
    inputByName(root, 'name').dispatchEvent(new Event('input', { bubbles: true }));
    pickEntity(root, 'lawn_mower.backyard');
    // Aux (soc_entity_id) set directly in form state — same pre-existing
    // nested-conditional aux-render quirk the HVAC power-sensor test
    // works around (see the comment on that test above).
    (el as unknown as { _values: Record<string, string> })._values = {
      ...(el as unknown as { _values: Record<string, string> })._values,
      soc_entity_id: 'sensor.robot_battery',
    };
    await flush(el);

    buttonByText(root, 'Add')!.click();
    await flush(el);

    const postCall = calls.find(
      (c) => c.url.endsWith('/api/v1/appliances') && c.init?.method === 'POST',
    );
    expect(postCall).toBeDefined();
    const body = JSON.parse(String(postCall!.init!.body));
    expect(body.config.entity_id).toBe('lawn_mower.backyard');
    expect(body.config.soc_entity_id).toBe('sensor.robot_battery');
  });

  it('robot: battery_capacity_kwh of 0 blocks submit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(null)));
    const el = mountForm();
    await flush(el);

    buttonByDataType(el.shadowRoot!, 'robot')!.click();
    await flush(el);

    const root = el.shadowRoot!;
    inputByName(root, 'name').value = 'Kitchen Vacuum';
    inputByName(root, 'name').dispatchEvent(new Event('input', { bubbles: true }));
    const cap = inputByName(root, 'battery_capacity_kwh');
    cap.value = '0';
    cap.dispatchEvent(new Event('input', { bubbles: true }));
    pickEntity(root, 'vacuum.living_room');
    await flush(el);

    const errs = Array.from(root.querySelectorAll('.field-error')).map((e) => e.textContent);
    expect(errs.some((t) => t?.includes('Must be greater than 0'))).toBe(true);
    expect(buttonByText(root, 'Add')!.disabled).toBe(true);
  });

  it('robot: missing entity_id blocks submit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(null)));
    const el = mountForm();
    await flush(el);

    buttonByDataType(el.shadowRoot!, 'robot')!.click();
    await flush(el);

    const root = el.shadowRoot!;
    inputByName(root, 'name').value = 'Kitchen Vacuum';
    inputByName(root, 'name').dispatchEvent(new Event('input', { bubbles: true }));
    // entity_id left unpicked.
    await flush(el);

    expect(buttonByText(root, 'Add')!.disabled).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Pool pump — runs its daily hours when power costs least
  // -----------------------------------------------------------------------

  it("clicking 'Pool pump' advances to step 2 with pump_watts default", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(null)));
    const el = mountForm();
    await flush(el);

    buttonByDataType(el.shadowRoot!, 'pool_pump')!.click();
    await flush(el);

    const root = el.shadowRoot!;
    expect(inputByName(root, 'pump_watts').value).toBe('1500');
    expect(root.querySelector('input[name="name"]')).not.toBeNull();
    // Step 1 type buttons no longer rendered.
    expect(root.querySelectorAll('button.type-btn').length).toBe(0);
  });

  it('pool pump: entity picker lists switch.* entities', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(null)));
    const el = mountForm();
    await flush(el);

    buttonByDataType(el.shadowRoot!, 'pool_pump')!.click();
    await flush(el);

    const root = el.shadowRoot!;
    const sel = selectByName(root, 'entity_id');
    const optionValues = Array.from(sel.querySelectorAll('option')).map((o) => o.value);
    expect(optionValues).toContain('switch.pool_pump');
  });

  it('pool pump: submit posts pump_watts as a number and entity_id', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      calls.push({ url, init });
      return jsonResponse({ appliance_id: 'app-pool-pump-1' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const el = mountForm();
    await flush(el);

    let createdEvent: CustomEvent | null = null;
    el.addEventListener('appliance-created', ((e: Event) => {
      createdEvent = e as CustomEvent;
    }) as EventListener);

    buttonByDataType(el.shadowRoot!, 'pool_pump')!.click();
    await flush(el);

    const root = el.shadowRoot!;
    inputByName(root, 'name').value = 'Backyard Pool Pump';
    inputByName(root, 'name').dispatchEvent(new Event('input', { bubbles: true }));
    // Pump power left at its default (1500 W).
    pickEntity(root, 'switch.pool_pump');
    await flush(el);

    const submitBtn = buttonByText(root, 'Add');
    expect(submitBtn!.disabled).toBe(false);
    submitBtn!.click();
    await flush(el);

    const postCall = calls.find(
      (c) => c.url.endsWith('/api/v1/appliances') && c.init?.method === 'POST',
    );
    expect(postCall).toBeDefined();
    const body = JSON.parse(String(postCall!.init!.body));
    expect(body.appliance_type).toBe('pool_pump');
    expect(body.name).toBe('Backyard Pool Pump');
    expect(body.config).toEqual({
      pump_watts: 1500,
      entity_id: 'switch.pool_pump',
    });

    expect(createdEvent).not.toBeNull();
    expect(el.open).toBe(false);
  });

  it('pool pump: pump_watts of 0 blocks submit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(null)));
    const el = mountForm();
    await flush(el);

    buttonByDataType(el.shadowRoot!, 'pool_pump')!.click();
    await flush(el);

    const root = el.shadowRoot!;
    inputByName(root, 'name').value = 'Backyard Pool Pump';
    inputByName(root, 'name').dispatchEvent(new Event('input', { bubbles: true }));
    const watts = inputByName(root, 'pump_watts');
    watts.value = '0';
    watts.dispatchEvent(new Event('input', { bubbles: true }));
    pickEntity(root, 'switch.pool_pump');
    await flush(el);

    const errs = Array.from(root.querySelectorAll('.field-error')).map((e) => e.textContent);
    expect(errs.some((t) => t?.includes('Must be greater than 0'))).toBe(true);
    expect(buttonByText(root, 'Add')!.disabled).toBe(true);
  });

  it('pool pump: pump_watts over 5000 blocks submit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(null)));
    const el = mountForm();
    await flush(el);

    buttonByDataType(el.shadowRoot!, 'pool_pump')!.click();
    await flush(el);

    const root = el.shadowRoot!;
    inputByName(root, 'name').value = 'Backyard Pool Pump';
    inputByName(root, 'name').dispatchEvent(new Event('input', { bubbles: true }));
    const watts = inputByName(root, 'pump_watts');
    watts.value = '5001';
    watts.dispatchEvent(new Event('input', { bubbles: true }));
    pickEntity(root, 'switch.pool_pump');
    await flush(el);

    const errs = Array.from(root.querySelectorAll('.field-error')).map((e) => e.textContent);
    expect(errs.some((t) => t?.includes('at most 5000'))).toBe(true);
    expect(buttonByText(root, 'Add')!.disabled).toBe(true);
  });

  it('pool pump: missing entity_id blocks submit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(null)));
    const el = mountForm();
    await flush(el);

    buttonByDataType(el.shadowRoot!, 'pool_pump')!.click();
    await flush(el);

    const root = el.shadowRoot!;
    inputByName(root, 'name').value = 'Backyard Pool Pump';
    inputByName(root, 'name').dispatchEvent(new Event('input', { bubbles: true }));
    // entity_id left unpicked.
    await flush(el);

    expect(buttonByText(root, 'Add')!.disabled).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Hot tub — ready for soak times, eases off in between
  // -----------------------------------------------------------------------

  it("clicking 'Hot tub' advances to step 2 with volume/heater defaults", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(null)));
    const el = mountForm();
    await flush(el);

    buttonByDataType(el.shadowRoot!, 'hot_tub')!.click();
    await flush(el);

    const root = el.shadowRoot!;
    expect(inputByName(root, 'volume_gallons').value).toBe('400');
    expect(inputByName(root, 'heater_watts').value).toBe('4000');
    expect(root.querySelector('input[name="name"]')).not.toBeNull();
    expect(root.querySelectorAll('button.type-btn').length).toBe(0);
  });

  it('hot tub: entity picker lists both climate.* and water_heater.* entities', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(null)));
    const el = mountForm();
    await flush(el);

    buttonByDataType(el.shadowRoot!, 'hot_tub')!.click();
    await flush(el);

    const root = el.shadowRoot!;
    const sel = selectByName(root, 'entity_id');
    const optionValues = Array.from(sel.querySelectorAll('option')).map((o) => o.value);
    expect(optionValues).toContain('climate.living_room');
    expect(optionValues).toContain('water_heater.hot_tub');
  });

  it('hot tub: submit posts volume_gallons, heater_watts and entity_id', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      calls.push({ url, init });
      return jsonResponse({ appliance_id: 'app-hot-tub-1' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const el = mountForm();
    await flush(el);

    let createdEvent: CustomEvent | null = null;
    el.addEventListener('appliance-created', ((e: Event) => {
      createdEvent = e as CustomEvent;
    }) as EventListener);

    buttonByDataType(el.shadowRoot!, 'hot_tub')!.click();
    await flush(el);

    const root = el.shadowRoot!;
    inputByName(root, 'name').value = 'Backyard Hot Tub';
    inputByName(root, 'name').dispatchEvent(new Event('input', { bubbles: true }));
    // Volume and heater power left at their defaults (400 gal / 4000 W).
    pickEntity(root, 'water_heater.hot_tub');
    await flush(el);

    const submitBtn = buttonByText(root, 'Add');
    expect(submitBtn!.disabled).toBe(false);
    submitBtn!.click();
    await flush(el);

    const postCall = calls.find(
      (c) => c.url.endsWith('/api/v1/appliances') && c.init?.method === 'POST',
    );
    expect(postCall).toBeDefined();
    const body = JSON.parse(String(postCall!.init!.body));
    expect(body.appliance_type).toBe('hot_tub');
    expect(body.name).toBe('Backyard Hot Tub');
    expect(body.config).toEqual({
      volume_gallons: 400,
      heater_watts: 4000,
      entity_id: 'water_heater.hot_tub',
    });

    expect(createdEvent).not.toBeNull();
    expect(el.open).toBe(false);
  });

  it('hot tub: submit includes temp_entity_id when a sensor is picked', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      calls.push({ url, init });
      return jsonResponse({ appliance_id: 'app-hot-tub-2' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const el = mountForm();
    await flush(el);

    buttonByDataType(el.shadowRoot!, 'hot_tub')!.click();
    await flush(el);

    const root = el.shadowRoot!;
    inputByName(root, 'name').value = 'Backyard Hot Tub';
    inputByName(root, 'name').dispatchEvent(new Event('input', { bubbles: true }));
    pickEntity(root, 'water_heater.hot_tub');
    // Set the aux sensor value directly in form state — the input path
    // via the rendered select works around the pre-existing aux-render
    // issue noted on the hvac power-sensor tests above. The contract
    // this pins: when the form's state has the value set, the POST
    // body includes it under the expected key.
    el._values = { ...el._values, temp_entity_id: 'sensor.hot_tub_temp' };
    await flush(el);

    const submitBtn = buttonByText(root, 'Add');
    submitBtn!.click();
    await flush(el);

    const postCall = calls.find(
      (c) => c.url.endsWith('/api/v1/appliances') && c.init?.method === 'POST',
    );
    const body = JSON.parse(String(postCall!.init!.body));
    expect(body.config).toEqual({
      volume_gallons: 400,
      heater_watts: 4000,
      entity_id: 'water_heater.hot_tub',
      temp_entity_id: 'sensor.hot_tub_temp',
    });
  });

  it('hot tub: volume_gallons out of range blocks submit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(null)));
    const el = mountForm();
    await flush(el);

    buttonByDataType(el.shadowRoot!, 'hot_tub')!.click();
    await flush(el);

    const root = el.shadowRoot!;
    inputByName(root, 'name').value = 'Backyard Hot Tub';
    inputByName(root, 'name').dispatchEvent(new Event('input', { bubbles: true }));
    const vol = inputByName(root, 'volume_gallons');
    vol.value = '40';
    vol.dispatchEvent(new Event('input', { bubbles: true }));
    pickEntity(root, 'water_heater.hot_tub');
    await flush(el);

    const errs = Array.from(root.querySelectorAll('.field-error')).map((e) => e.textContent);
    expect(errs.some((t) => t?.includes('50-1000'))).toBe(true);
    expect(buttonByText(root, 'Add')!.disabled).toBe(true);
  });

  it('hot tub: heater_watts out of range blocks submit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(null)));
    const el = mountForm();
    await flush(el);

    buttonByDataType(el.shadowRoot!, 'hot_tub')!.click();
    await flush(el);

    const root = el.shadowRoot!;
    inputByName(root, 'name').value = 'Backyard Hot Tub';
    inputByName(root, 'name').dispatchEvent(new Event('input', { bubbles: true }));
    const heater = inputByName(root, 'heater_watts');
    heater.value = '12001';
    heater.dispatchEvent(new Event('input', { bubbles: true }));
    pickEntity(root, 'water_heater.hot_tub');
    await flush(el);

    const errs = Array.from(root.querySelectorAll('.field-error')).map((e) => e.textContent);
    expect(errs.some((t) => t?.includes('500-12000'))).toBe(true);
    expect(buttonByText(root, 'Add')!.disabled).toBe(true);
  });

  it('hot tub: missing entity_id blocks submit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(null)));
    const el = mountForm();
    await flush(el);

    buttonByDataType(el.shadowRoot!, 'hot_tub')!.click();
    await flush(el);

    const root = el.shadowRoot!;
    inputByName(root, 'name').value = 'Backyard Hot Tub';
    inputByName(root, 'name').dispatchEvent(new Event('input', { bubbles: true }));
    // entity_id left unpicked.
    await flush(el);

    expect(buttonByText(root, 'Add')!.disabled).toBe(true);
  });

  // ranked picker + companion auto-fill.
  describe('entity discovery', () => {
    it('groups scoring entities under "Suggested", ordered by score then id, ahead of the rest', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(null)));
      const el = mountForm(TEST_HASS_DISCOVERY);
      await flush(el);

      buttonByDataType(el.shadowRoot!, 'water_heater')!.click();
      await flush(el);

      const root = el.shadowRoot!;
      const sel = selectByName(root, 'entity_id');
      const groups = Array.from(sel.querySelectorAll('optgroup'));
      expect(groups.map((g) => g.label)).toEqual(['Suggested', 'All switch/climate entities']);

      const suggestedOptions = Array.from(groups[0].querySelectorAll('option'));
      expect(suggestedOptions.map((o) => o.value)).toEqual(['switch.boiler_unit', 'switch.tank_heater']);
      expect(suggestedOptions[0].textContent).toBe('switch.boiler_unit - name mentions water heater');
      expect(suggestedOptions[1].textContent).toBe('switch.tank_heater - name mentions water heater');

      const restOptions = Array.from(groups[1].querySelectorAll('option'));
      expect(restOptions.map((o) => o.value)).toEqual(['climate.living_room', 'switch.garage_light']);
    });

    it('renders a flat option list, no optgroups, when nothing scores above zero', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(null)));
      const el = mountForm(TEST_HASS_NO_REGISTRY);
      await flush(el);

      buttonByDataType(el.shadowRoot!, 'ev_charger')!.click();
      await flush(el);

      const root = el.shadowRoot!;
      const sel = selectByName(root, 'entity_id');
      expect(sel.querySelectorAll('optgroup').length).toBe(0);
      const optionValues = Array.from(sel.querySelectorAll('option')).map((o) => o.value);
      expect(optionValues).toEqual(['', 'switch.garage_light', 'switch.other']);
    });

    it('fills the empty companion sensor field from the picked entity\'s device, with a note', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(null)));
      const el = mountForm(TEST_HASS_DISCOVERY);
      await flush(el);

      buttonByDataType(el.shadowRoot!, 'water_heater')!.click();
      await flush(el);

      const root = el.shadowRoot!;
      expect(selectByName(root, 'temp_entity_id').value).toBe('');
      pickEntity(root, 'switch.tank_heater');
      await flush(el);

      expect(selectByName(root, 'temp_entity_id').value).toBe('sensor.tank_heater_temp');
      expect(root.textContent).toContain('Found on the same device');
    });

    it('never overwrites a companion field the user already set', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(null)));
      const el = mountForm(TEST_HASS_DISCOVERY);
      await flush(el);

      buttonByDataType(el.shadowRoot!, 'water_heater')!.click();
      await flush(el);

      const root = el.shadowRoot!;
      const tempSel = selectByName(root, 'temp_entity_id');
      tempSel.value = 'sensor.unrelated';
      tempSel.dispatchEvent(new Event('change', { bubbles: true }));
      await flush(el);

      pickEntity(root, 'switch.tank_heater');
      await flush(el);

      expect(selectByName(root, 'temp_entity_id').value).toBe('sensor.unrelated');
      expect(root.textContent).not.toContain('Found on the same device');
    });

    it('never auto-fills when editing an existing appliance', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ id: 'app-wh-1' })));
      const el = mountForm(TEST_HASS_DISCOVERY);
      const existing = {
        id: 'app-wh-1',
        user_id: 'user-1',
        appliance_type: 'water_heater' as const,
        name: 'Tank',
        config: {
          entity_id: 'switch.garage_light',
          tank_size_gallons: 50,
          element_watts: 4500,
          insulation_factor: 0.03,
        },
        is_active: true,
        created_at: new Date().toISOString(),
      };
      el.editing = existing;
      await flush(el);

      const root = el.shadowRoot!;
      expect(selectByName(root, 'temp_entity_id').value).toBe('');
      pickEntity(root, 'switch.tank_heater');
      await flush(el);

      expect(selectByName(root, 'temp_entity_id').value).toBe('');
      expect(root.textContent).not.toContain('Found on the same device');
    });
  });

  // the type-picker step's "Found in your Home Assistant" shortcut.
  describe('discovered device suggestions', () => {
    it('lists a finding above the type grid, naming the entity and the type it would be added as', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(null)));
      const el = mountForm(TEST_HASS_FOUND_DEVICES);
      await flush(el);

      const root = el.shadowRoot!;
      expect(root.textContent).toContain('Found in your Home Assistant');
      expect(buttonByText(root, 'Spa - add as Hot tub')).toBeTruthy();
    });

    it('is absent when nothing scores above the discovery threshold', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(null)));
      // TEST_HASS_DISCOVERY's best water_heater candidate only scores 2
      // (a keyword match) — below findDevices' threshold of 3.
      const el = mountForm(TEST_HASS_DISCOVERY);
      await flush(el);

      expect(el.shadowRoot!.textContent).not.toContain('Found in your Home Assistant');
    });

    it('is absent in edit mode', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ id: 'app-ht-1' })));
      const el = mountForm(TEST_HASS_FOUND_DEVICES);
      el.editing = {
        id: 'app-ht-1',
        user_id: 'user-1',
        appliance_type: 'hot_tub',
        name: 'Spa',
        config: { entity_id: 'climate.spa', ready_temp_f: '104', eco_temp_f: '90' },
        is_active: true,
        created_at: new Date().toISOString(),
      };
      await flush(el);

      expect(el.shadowRoot!.textContent).not.toContain('Found in your Home Assistant');
    });

    it('clicking a finding picks the type, moves to step 2, and pre-selects the entity with companions filled', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(null)));
      const el = mountForm(TEST_HASS_FOUND_DEVICES);
      await flush(el);

      buttonByText(el.shadowRoot!, 'Spa - add as Hot tub')!.click();
      await flush(el);

      const root = el.shadowRoot!;
      expect(selectByName(root, 'entity_id').value).toBe('climate.spa');
      expect(selectByName(root, 'temp_entity_id').value).toBe('sensor.spa_temp');
      expect(root.textContent).toContain('Found on the same device');
    });
  });
});
