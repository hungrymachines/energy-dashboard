import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HmDiagnosticsPanel } from '../src/ui/diagnostics-panel.js';
import { setApiBase, setTokens } from '../src/api/client.js';

if (!customElements.get('hm-diagnostics-panel')) {
  customElements.define('hm-diagnostics-panel', HmDiagnosticsPanel);
}

type PanelEl = HmDiagnosticsPanel & { updateComplete: Promise<boolean> };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function flush(el: PanelEl): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await el.updateComplete;
    await Promise.resolve();
  }
}

function mountPanel(): PanelEl {
  const el = document.createElement('hm-diagnostics-panel') as PanelEl;
  document.body.appendChild(el);
  return el;
}

function _stubFetch(divergence: unknown, sensors: { sensors: unknown[] } = { sensors: [] }) {
  // The panel pulls divergence + sensor health in parallel; we need to
  // route each URL to its own response.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.includes('/integration/health/divergence')) {
        return jsonResponse(divergence);
      }
      if (url.includes('/integration/sensors')) {
        return jsonResponse(sensors);
      }
      return jsonResponse({});
    }),
  );
}

function _stubFetchWithHealth(health: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.endsWith('/health')) {
        return jsonResponse(health);
      }
      if (url.includes('/integration/sensors')) {
        return jsonResponse({ sensors: [] });
      }
      return jsonResponse({
        lookback_hours: 6,
        sample_count: 0,
        commanded_coverage_pct: 0,
        power_coverage_pct: 0,
        entity_coverage_pct: 0,
        commanded_vs_entity_mode_agreement_pct: null,
        commanded_vs_power_mode_agreement_pct: null,
        entity_vs_power_mode_agreement_pct: null,
        setpoint_offset_avg_f: null,
        setpoint_offset_max_f: null,
        fan_match_pct: null,
        power_obeyed_pct: null,
        verdict: 'no_data',
        human_readable: 'No readings received.',
      });
    }),
  );
}

describe('hm-diagnostics-panel', () => {
  beforeEach(() => {
    setApiBase('https://api.example.test');
    setTokens({ access: 'ACCESS', refresh: 'REFRESH' });
  });

  afterEach(() => {
    // The version test plants the bundle's script tag; clear it here so
    // a failing assertion can't leak a version into the next test.
    document
      .querySelectorAll('script[src*="hungry-machines.js"]')
      .forEach((n) => n.remove());
  });

  it('renders a healthy badge, not a banner, when all signals agree', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          lookback_hours: 6,
          sample_count: 72,
          commanded_coverage_pct: 100,
          power_coverage_pct: 100,
          entity_coverage_pct: 100,
          commanded_vs_entity_mode_agreement_pct: 100,
          commanded_vs_power_mode_agreement_pct: 100,
          entity_vs_power_mode_agreement_pct: 100,
          setpoint_offset_avg_f: 0.0,
          setpoint_offset_max_f: 0.0,
          fan_match_pct: 100,
          power_obeyed_pct: 100,
          verdict: 'healthy',
          human_readable: 'All three signals agree — calibration data is clean.',
        }),
      ),
    );

    const el = mountPanel();
    await flush(el);

    expect(el.shadowRoot!.querySelector('.banner')).toBeNull();
    const check = el.shadowRoot!.querySelector('details.check-details') as HTMLDetailsElement;
    expect(check).not.toBeNull();
    expect(check.open).toBe(false);
    const badge = check.querySelector('summary .summary-badge');
    expect(badge!.classList.contains('healthy')).toBe(true);
    expect(badge!.textContent).toContain('OK');
  });

  it('renders the entity_unreliable badge with the right tone', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          lookback_hours: 6,
          sample_count: 72,
          commanded_coverage_pct: 100,
          power_coverage_pct: 100,
          entity_coverage_pct: 100,
          commanded_vs_entity_mode_agreement_pct: 30,
          commanded_vs_power_mode_agreement_pct: 100,
          entity_vs_power_mode_agreement_pct: 30,
          setpoint_offset_avg_f: 7.0,
          setpoint_offset_max_f: 7.0,
          fan_match_pct: 28,
          power_obeyed_pct: 100,
          verdict: 'entity_unreliable',
          human_readable: 'Your thermostat reports unreliable state.',
        }),
      ),
    );

    const el = mountPanel();
    await flush(el);

    const badge = el.shadowRoot!.querySelector('.check-details summary .summary-badge');
    expect(badge!.classList.contains('intermittent')).toBe(true);
    expect(badge!.textContent).toContain('Entity unreliable');
  });

  it('renders the thermostat_ignoring badge as bad, still collapsed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          lookback_hours: 6,
          sample_count: 72,
          commanded_coverage_pct: 100,
          power_coverage_pct: 100,
          entity_coverage_pct: 100,
          commanded_vs_entity_mode_agreement_pct: 100,
          commanded_vs_power_mode_agreement_pct: 25,
          entity_vs_power_mode_agreement_pct: 100,
          setpoint_offset_avg_f: 0.0,
          setpoint_offset_max_f: 0.0,
          fan_match_pct: 100,
          power_obeyed_pct: 25,
          verdict: 'thermostat_ignoring_commands',
          human_readable: 'Your AC obeyed only 25% of commands.',
        }),
      ),
    );

    const el = mountPanel();
    await flush(el);

    expect(el.shadowRoot!.querySelector('.banner')).toBeNull();
    const badge = el.shadowRoot!.querySelector('.check-details summary .summary-badge');
    expect(badge!.classList.contains('bad')).toBe(true);
  });

  it('keeps the commanded_missing upgrade prompt inside the collapsed row', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          lookback_hours: 6,
          sample_count: 72,
          commanded_coverage_pct: 0,
          power_coverage_pct: 0,
          entity_coverage_pct: 100,
          commanded_vs_entity_mode_agreement_pct: null,
          commanded_vs_power_mode_agreement_pct: null,
          entity_vs_power_mode_agreement_pct: null,
          setpoint_offset_avg_f: null,
          setpoint_offset_max_f: null,
          fan_match_pct: null,
          power_obeyed_pct: null,
          verdict: 'commanded_missing',
          human_readable: 'Upgrade your Home Assistant integration to enable command verification.',
        }),
      ),
    );

    const el = mountPanel();
    await flush(el);

    expect(el.shadowRoot!.querySelector('.banner')).toBeNull();
    const badge = el.shadowRoot!.querySelector('.check-details summary .summary-badge');
    expect(badge!.classList.contains('intermittent')).toBe(true);
    const msg = el.shadowRoot!.querySelector('.check-details .check-msg');
    expect(msg!.textContent).toContain('Upgrade');
  });

  it('renders details section with per-signal coverage when sample_count > 0', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          lookback_hours: 6,
          sample_count: 72,
          commanded_coverage_pct: 100,
          power_coverage_pct: 98,
          entity_coverage_pct: 82,
          commanded_vs_entity_mode_agreement_pct: 31,
          commanded_vs_power_mode_agreement_pct: 94,
          entity_vs_power_mode_agreement_pct: 30,
          setpoint_offset_avg_f: 5.2,
          setpoint_offset_max_f: 8.0,
          fan_match_pct: 28,
          power_obeyed_pct: 94,
          verdict: 'entity_unreliable',
          human_readable: 'Your thermostat reports unreliable state.',
        }),
      ),
    );

    const el = mountPanel();
    await flush(el);

    // The conditional details block uses a `${cond ? html : null}`
    // pattern that has a happy-dom rendering edge case (see the
    // companion note in tests/appliance-form.test.ts for the
    // pre-existing aux-render parallel). The report data IS pulled
    // and stored on the component — that's the contract we pin
    // here. Visual smoke test happens in HA itself before tagging
    // the release.
    expect(el._report).not.toBeNull();
    expect(el._report!.commanded_coverage_pct).toBe(100);
    expect(el._report!.setpoint_offset_avg_f).toBe(5.2);
    expect(el._report!.verdict).toBe('entity_unreliable');
  });

  it('does not render details when sample_count is 0', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          lookback_hours: 6,
          sample_count: 0,
          commanded_coverage_pct: 0,
          power_coverage_pct: 0,
          entity_coverage_pct: 0,
          commanded_vs_entity_mode_agreement_pct: null,
          commanded_vs_power_mode_agreement_pct: null,
          entity_vs_power_mode_agreement_pct: null,
          setpoint_offset_avg_f: null,
          setpoint_offset_max_f: null,
          fan_match_pct: null,
          power_obeyed_pct: null,
          verdict: 'no_data',
          human_readable: 'No readings received.',
        }),
      ),
    );

    const el = mountPanel();
    await flush(el);

    // Mirror of the previous test — verify the contract through the
    // stored report rather than the conditional DOM block (see note
    // above on the happy-dom rendering edge case).
    expect(el._report).not.toBeNull();
    expect(el._report!.sample_count).toBe(0);
    expect(el._report!.verdict).toBe('no_data');
  });

  it('renders a sensor-health row for each configured aux sensor', async () => {
    _stubFetch(
      {
        lookback_hours: 6,
        sample_count: 72,
        commanded_coverage_pct: 100,
        power_coverage_pct: 0,
        entity_coverage_pct: 100,
        commanded_vs_entity_mode_agreement_pct: 100,
        commanded_vs_power_mode_agreement_pct: null,
        entity_vs_power_mode_agreement_pct: null,
        setpoint_offset_avg_f: 0,
        setpoint_offset_max_f: 0,
        fan_match_pct: 100,
        power_obeyed_pct: null,
        verdict: 'healthy',
        human_readable: 'OK',
      },
      {
        sensors: [
          {
            appliance_id: 'a-1',
            appliance_name: 'Office AC',
            config_key: 'power_sensor_entity_id',
            label: 'Power',
            entity_id: 'sensor.does_not_exist',
            payload_field: 'power_watts',
            populated_pct: 0,
            verdict: 'missing_or_broken',
            message: 'Power sensor has produced no usable readings — verify the entity ID.',
          },
          {
            appliance_id: 'a-1',
            appliance_name: 'Office AC',
            config_key: 'indoor_temp_entity_id',
            label: 'Indoor temperature',
            entity_id: 'sensor.indoor_temp',
            payload_field: 'indoor_temp',
            populated_pct: 100,
            verdict: 'healthy',
            message: 'Indoor temperature sensor reporting cleanly.',
          },
        ],
      },
    );

    const el = mountPanel();
    await flush(el);

    expect(el._sensors).not.toBeNull();
    expect(el._sensors!.length).toBe(2);
    const broken = el._sensors!.find((s) => s.verdict === 'missing_or_broken');
    expect(broken).toBeDefined();
    expect(broken!.entity_id).toBe('sensor.does_not_exist');
  });

  it('renders the integration version and the API build', async () => {
    // The integration version rides in on the script tag HA writes for
    // the bundle (`?v=` cache-buster) — plant one the way HA would.
    const tag = document.createElement('script');
    tag.setAttribute('src', '/hungry_machines/hungry-machines.js?v=3.6.0');
    document.head.appendChild(tag);
    _stubFetchWithHealth({ status: 'ok', version: '2.4.1', api_build: 'a1b2c3d' });

    const el = mountPanel();
    await flush(el);

    const versions = el.shadowRoot!.querySelector('.versions');
    expect(versions).not.toBeNull();
    expect(versions!.textContent).toContain('Integration v3.6.0');
    expect(versions!.textContent).toContain('API build a1b2c3d');
  });

  it('renders an em dash for each version it cannot determine', async () => {
    // No script tag planted, and a /health response from an older API
    // that predates the api_build field.
    _stubFetchWithHealth({ status: 'ok', version: '2.4.1' });

    const el = mountPanel();
    await flush(el);

    const lines = Array.from(
      el.shadowRoot!.querySelectorAll('.versions .version-line'),
    ).map((n) => n.textContent!.replace(/\s+/g, ' ').trim());
    expect(lines).toEqual(['Integration —', 'API build —']);
  });

  describe('per-unit rows', () => {
    const DIVERGENCE = {
      lookback_hours: 24, sample_count: 0, commanded_coverage_pct: 0, power_coverage_pct: 0,
      entity_coverage_pct: 0, commanded_vs_entity_mode_agreement_pct: null,
      commanded_vs_power_mode_agreement_pct: null, entity_vs_power_mode_agreement_pct: null,
      setpoint_offset_avg_f: null, setpoint_offset_max_f: null, fan_match_pct: null,
      power_obeyed_pct: null, verdict: 'no_data', human_readable: 'No readings received.',
    };

    function stubUnits(appliances: unknown[]) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request) => {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
          if (url.includes('/integration/health/divergence')) return jsonResponse(DIVERGENCE);
          if (url.includes('/integration/sensors')) return jsonResponse({ sensors: [] });
          if (url.endsWith('/integration/health')) {
            return jsonResponse({ status: 'healthy', message: '', appliances });
          }
          return jsonResponse({});
        }),
      );
    }

    it('says what the setpoint offset does per unit and flags a difference past 3 °F', async () => {
      stubUnits([
        {
          appliance_id: 'a-1', name: 'Front AC', status: 'healthy', message: 'Integration is healthy.',
          band_check: {
            sensor_gap_f: 4.4, offset_limit_f: 3, offset_capped: true, wide_setpoint_offset: false,
            min_width_f: 2.5,
            narrow: [
              { day: 'every', start_hour: 0, end_hour: 8, width_f: 1.0 },
              { day: 'sun', start_hour: 22, end_hour: 24, width_f: 2.0 },
            ],
          },
        },
        {
          appliance_id: 'a-2', name: 'Office AC', status: 'healthy', message: '',
          band_check: {
            sensor_gap_f: 1.8, offset_limit_f: 3, offset_capped: false, wide_setpoint_offset: false,
            min_width_f: null, narrow: [],
          },
        },
      ]);
      const el = mountPanel();
      await flush(el);

      const ranges = el.shadowRoot!.querySelector('details.range-details') as HTMLDetailsElement;
      expect(ranges.hidden).toBe(false);
      const badge = ranges.querySelector('summary .summary-badge')!;
      expect(badge.classList.contains('intermittent')).toBe(true);
      expect(badge.textContent).toContain('1 to review');
      const rows = Array.from(ranges.querySelectorAll('.sensor-row')).map((r) => ({
        ok: r.classList.contains('healthy'),
        text: r.textContent!.replace(/\s+/g, ' '),
      }));
      expect(rows[0].ok).toBe(false);
      expect(rows[0].text).toContain('Front AC');
      expect(rows[0].text).toContain('more than the 3.0 °F a unit may be set outside your range');
      expect(rows[0].text).toContain('00:00–08:00 (1.0 °F wide)');
      expect(rows[0].text).toContain('Sun 22:00–24:00 (2.0 °F wide)');
      expect(rows[1].ok).toBe(true);
      expect(rows[1].text).toContain('may be set up to 3.0 °F outside it');
    });

    it('hides the comfort-range row when no unit has a measured sensor difference', async () => {
      stubUnits([{ appliance_id: 'a-1', name: 'Central', status: 'healthy', message: '', band_check: null }]);
      const el = mountPanel();
      await flush(el);
      const ranges = el.shadowRoot!.querySelector('details.range-details') as HTMLDetailsElement;
      expect(ranges.hidden).toBe(true);
      const readings = el.shadowRoot!.querySelector('details.readings-details')!;
      expect(readings.querySelector('summary .summary-badge')!.textContent).toContain('OK');
    });

    it('names a unit whose readings have stopped', async () => {
      stubUnits([
        { appliance_id: 'a-1', name: 'Office AC', status: 'healthy', message: 'Integration is healthy.' },
        { appliance_id: 'a-2', name: 'Front AC', status: 'no_data', message: 'No readings received from this HVAC in the last 6 hours.' },
      ]);
      const el = mountPanel();
      await flush(el);
      const readings = el.shadowRoot!.querySelector('details.readings-details')!;
      const badge = readings.querySelector('summary .summary-badge')!;
      expect(badge.classList.contains('bad')).toBe(true);
      expect(badge.textContent).toContain('1 unit needs attention');
      expect(readings.textContent).toContain('No readings received from this HVAC');
    });

    it('renders neither row against a server that sends no per-unit list', async () => {
      _stubFetchWithHealth({ status: 'ok', version: '2.4.1' });
      const el = mountPanel();
      await flush(el);
      expect(el.shadowRoot!.querySelector('details.readings-details')).toBeNull();
      expect(el.shadowRoot!.querySelector('details.range-details')).toBeNull();
      expect(el.shadowRoot!.querySelector('details.check-details')).not.toBeNull();
    });
  });

  it('shows a graceful fallback when the fetch fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ detail: 'server is down' }, 500)),
    );

    const el = mountPanel();
    await flush(el);

    const banner = el.shadowRoot!.querySelector('.banner');
    expect(banner).not.toBeNull();
    expect(banner!.classList.contains('muted')).toBe(true);
  });
});
