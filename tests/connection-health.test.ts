import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HmConnectionHealth } from '../src/ui/connection-health.js';
import { setApiBase, setTokens } from '../src/api/client.js';

if (!customElements.get('hm-connection-health')) {
  customElements.define('hm-connection-health', HmConnectionHealth);
}

type El = HmConnectionHealth & { updateComplete: Promise<boolean> };

async function flush(el: El): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await el.updateComplete;
    await Promise.resolve();
  }
}

function stub(body: unknown, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })),
  );
}

async function mount(): Promise<El> {
  const el = document.createElement('hm-connection-health') as El;
  document.body.appendChild(el);
  await flush(el);
  return el;
}

const READINGS = { status: 'healthy', newest_age_seconds: 60, message: 'Readings are arriving.' };

function entry(over: Record<string, unknown>) {
  return {
    appliance_id: 'a1',
    name: 'Main',
    appliance_type: 'hvac',
    status: 'ok',
    alert: null,
    readings: READINGS,
    command: null,
    sensors: [],
    power: { mapped: false, coverage_pct: null, matched_pct: null },
    notes: [],
    ...over,
  };
}

describe('hm-connection-health', () => {
  beforeEach(() => {
    setApiBase('https://api.test');
    setTokens({ access: 'a', refresh: 'r' });
  });
  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('shows an HVAC unit with its command rows on the left and power on the right', async () => {
    stub({
      lookback_hours: 24,
      appliances: [
        entry({
          command: {
            verdict: 'healthy',
            human_readable: 'Following commands.',
            sample_count: 100,
            commanded_coverage_pct: 90,
            commanded_vs_entity_mode_agreement_pct: 95,
            setpoint_hold_fail_pct: 10,
            setpoint_offset_avg_f: 1,
            setpoint_offset_max_f: 3,
            fan_match_pct: null,
          },
          power: { mapped: true, coverage_pct: 85, matched_pct: 90 },
        }),
      ],
    });
    const el = await mount();
    const root = el.shadowRoot!;
    const machine = root.querySelector('.machine[data-appliance="a1"]')!;
    expect(machine.querySelector('.control')!.textContent).toContain('Mode matched');
    expect(machine.querySelector('.control')!.textContent).toContain('Setpoint held');
    expect(machine.querySelector('.control')!.textContent).not.toContain('Fan speed');
    const power = machine.querySelector('.power')!.textContent!;
    expect(power).toContain('Readings with power');
    expect(power).toContain('85%');
  });

  it('shows matched share, compared and unavailable counts for a switch machine', async () => {
    stub({
      appliances: [
        entry({
          appliance_type: 'ev_charger',
          name: 'Garage EV',
          command: { verdict: 'healthy', message: 'Garage EV is following its plan.', matched_pct: 92.4, compared: 40, unavailable_count: 2 },
        }),
      ],
    });
    const text = (await mount()).shadowRoot!.querySelector('.control')!.textContent!;
    expect(text).toContain('Matched its plan');
    expect(text).toContain('92%');
    expect(text).toContain('Readings compared');
    expect(text).toContain('40');
    expect(text).toContain('Unavailable readings');
  });

  it('greys one line when no power sensor is mapped', async () => {
    stub({ appliances: [entry({})] });
    const power = (await mount()).shadowRoot!.querySelector('.power')!.textContent!;
    expect(power).toContain('No power sensor');
  });

  it('lists types the home has not added as greyed rows', async () => {
    stub({ appliances: [entry({})] });
    const root = (await mount()).shadowRoot!;
    expect(root.querySelector('[data-example="hvac"]')).toBeNull();
    expect(root.querySelector('[data-example="hot_tub"]')).not.toBeNull();
    expect(root.querySelectorAll('.machine.example').length).toBe(7);
  });

  it('marks a clear failure as needing attention', async () => {
    stub({ appliances: [entry({ status: 'attention', alert: { message: 'x' } })] });
    const root = (await mount()).shadowRoot!;
    expect(root.querySelector('.machine.bad .badge')!.textContent).toContain('Needs attention');
  });

  it('has one collapsed About section with the planned-vs-reported, power and 90-minute notes', async () => {
    stub({ appliances: [] });
    const root = (await mount()).shadowRoot!;
    const about = root.querySelectorAll('details.about');
    expect(about.length).toBe(1);
    expect((about[0] as HTMLDetailsElement).open).toBe(false);
    const text = about[0].textContent!;
    expect(text).toContain('Robots, hot tubs');
    expect(text).toContain('never raise an alert');
    expect(text).toContain('90 minutes');
  });

  it('has no version footer', async () => {
    stub({ appliances: [] });
    const root = (await mount()).shadowRoot!;
    expect(root.querySelector('.versions')).toBeNull();
  });

  it('shows an error line when the call fails', async () => {
    stub({ detail: 'boom' }, 500);
    const root = (await mount()).shadowRoot!;
    expect(root.querySelector('.banner')!.textContent).toContain("Couldn't load");
  });
});
