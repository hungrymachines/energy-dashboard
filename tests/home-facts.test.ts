import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HmHomeFacts, factSentence } from '../src/ui/home-facts.js';
import { setApiBase, setTokens } from '../src/api/client.js';
import { temperatureUnitStore } from '../src/utils/temperature.js';

if (!customElements.get('hm-home-facts')) customElements.define('hm-home-facts', HmHomeFacts);

type El = HmHomeFacts & { updateComplete: Promise<boolean> };

async function flush(el: El): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await el.updateComplete;
    await Promise.resolve();
  }
}

const fact = (key: string, value: unknown, unit: string | null = null, detail: unknown = null) =>
  ({ key, value, unit, detail }) as never;

describe('factSentence', () => {
  it('holds_temperature gives the rate and the hours', () => {
    const s = factSentence(fact('holds_temperature', 2.4, 'delta_f', 6.3), 'F')!;
    expect(s).toContain('20 °F');
    expect(s).toContain('about 2.4 °F an hour');
    expect(s).toContain('within 3 °F for about 6 hours');
    expect(s).toContain('learned from your readings');
  });
  it('sun, internal_heat, capacities', () => {
    expect(factSentence(fact('sun', 1.2), 'F')).toBe('Midday sun adds up to about 1.2 °F an hour.');
    expect(factSentence(fact('internal_heat', 0.4), 'F')).toBe('Lights, appliances and people add about 0.4 °F an hour.');
    expect(factSentence(fact('cooling_capacity', 5), 'F')).toBe('Cools this room about 5.0 °F an hour at full output.');
    expect(factSentence(fact('heating_capacity', 6), 'F')).toBe('Heats this room about 6.0 °F an hour at full output.');
  });
  it('sensor_gap reads by sign', () => {
    expect(factSentence(fact('sensor_gap', 1.8, 'delta_f'), 'F')).toBe("The unit's own sensor reads about 1.8 °F cooler than your room sensor.");
    expect(factSentence(fact('sensor_gap', -1.5, 'delta_f'), 'F')).toContain('warmer');
  });
  it('shares_heat names the sibling', () => {
    expect(factSentence(fact('shares_heat', true, null, 'Upstairs'), 'F')).toBe('Heat moves between this room and Upstairs.');
  });
  it('prediction, standby_loss, solar', () => {
    expect(factSentence(fact('prediction', 0.6), 'F')).toBe('Predicts this room within about 0.6 °F a day ahead.');
    expect(factSentence(fact('standby_loss', 0.8), 'F')).toBe('The tank loses about 0.8 °F an hour when idle.');
    expect(factSentence(fact('full_sun_pct', 82.4), 'F')).toBe('Produces about 82% of its rating in full sun.');
    expect(factSentence(fact('shaded_hours', 2, 'hours', [9, 15]), 'F')).toContain('(9 AM, 3 PM)');
  });
  it('Celsius converts deltas, not offsets', () => {
    expect(factSentence(fact('sun', 1.8), 'C')).toBe('Midday sun adds up to about 1.0 °C an hour.');
    const s = factSentence(fact('holds_temperature', 3.6, 'delta_f', 6), 'C')!;
    expect(s).toContain('11.1 °C');
    expect(s).toContain('about 2.0 °C an hour');
    expect(s).toContain('within 1.7 °C');
  });
  it('an unknown key is skipped', () => {
    expect(factSentence(fact('mystery', 3), 'F')).toBeNull();
  });
});

describe('<hm-home-facts>', () => {
  beforeEach(() => {
    setApiBase('https://api.test');
    setTokens({ access: 'a', refresh: 'r' });
    temperatureUnitStore.setPreference('F');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    temperatureUnitStore.setPreference(null);
    document.body.innerHTML = '';
  });

  async function mount(body: unknown, status = 200): Promise<El> {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })));
    const el = document.createElement('hm-home-facts') as El;
    document.body.appendChild(el);
    await flush(el);
    return el;
  }

  it('renders facts per appliance and omits absent ones', async () => {
    const el = await mount({
      appliances: [{ appliance_id: 'a1', name: 'Main AC', appliance_type: 'hvac', learning: false, facts: [fact('sun', 1.2), fact('cooling_capacity', 5)] }],
    });
    const text = el.shadowRoot!.textContent!;
    expect(text).toContain('Main AC');
    expect(text).toContain('Midday sun adds up to about 1.2 °F an hour.');
    expect(text).not.toContain('Predicts this room');
    expect(text).not.toContain('Still learning');
  });

  it('learning=true says so and shows no facts', async () => {
    const el = await mount({
      appliances: [{ appliance_id: 'a1', name: 'Main AC', appliance_type: 'hvac', learning: true, facts: [fact('sun', 1.2)] }],
    });
    const text = el.shadowRoot!.textContent!;
    expect(text).toContain('Still learning this unit from its readings');
    expect(text).not.toContain('Midday sun');
  });

  it('leaves out a machine with nothing to learn instead of calling it learning', async () => {
    const el = await mount({
      appliances: [
        { appliance_id: 'a1', name: 'Main AC', appliance_type: 'hvac', learning: false, facts: [fact('sun', 1.2)] },
        { appliance_id: 'p1', name: 'Pool Pump', appliance_type: 'pool_pump', learning: false, facts: [] },
      ],
    });
    const text = el.shadowRoot!.textContent!;
    expect(text).toContain('Main AC');
    expect(text).not.toContain('Pool Pump');
    expect(text).not.toContain('Still learning');
  });

  it('a home with only machines that have nothing to learn says when facts appear', async () => {
    const el = await mount({
      appliances: [{ appliance_id: 'p1', name: 'Pool Pump', appliance_type: 'pool_pump', learning: false, facts: [] }],
    });
    const text = el.shadowRoot!.textContent!;
    expect(text).not.toContain('Pool Pump');
    expect(text).toContain('Facts appear here for heating and cooling');
  });

  it('formats in Celsius when the unit store says so, and re-renders on change', async () => {
    const el = await mount({
      appliances: [{ appliance_id: 'a1', name: 'AC', appliance_type: 'hvac', learning: false, facts: [fact('sun', 1.8)] }],
    });
    expect(el.shadowRoot!.textContent).toContain('1.8 °F an hour');
    temperatureUnitStore.setPreference('C');
    await flush(el);
    expect(el.shadowRoot!.textContent).toContain('1.0 °C an hour');
  });

  it('shows a retry banner on failure', async () => {
    const el = await mount({ detail: 'x' }, 500);
    expect(el.shadowRoot!.textContent).toContain('not available');
  });
});
