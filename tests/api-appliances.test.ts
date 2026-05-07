import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getSchedule, type ApplianceSchedule } from '../src/api/appliances.js';
import { setApiBase, setTokens, clearTokens } from '../src/api/client.js';

function jsonResponse(status: number, body: unknown): Response {
  const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('getSchedule', () => {
  beforeEach(() => {
    clearTokens();
    setApiBase('https://api.example.test');
    setTokens({ access: 'AAA', refresh: 'RRR' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    clearTokens();
  });

  it('resolves typed shape with source: "defaults" without TS errors', async () => {
    const body = {
      appliance_id: 'a1',
      date: '2026-05-06',
      schedule: { intervals: [], high_temps: [], low_temps: [] },
      savings_pct: 0,
      source: 'defaults' as const,
    };
    const fetchMock = vi.fn(async () => jsonResponse(200, body));
    vi.stubGlobal('fetch', fetchMock);

    const result: ApplianceSchedule = await getSchedule('a1');

    expect(result.source).toBe('defaults');
    expect(result.appliance_id).toBe('a1');
    expect(result.date).toBe('2026-05-06');
    expect(result.savings_pct).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example.test/api/v1/appliances/a1/schedule');
  });
});
