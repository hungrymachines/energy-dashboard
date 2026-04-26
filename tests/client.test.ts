import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  apiFetch,
  setApiBase,
  setTokens,
  clearTokens,
  getAccessToken,
  getRefreshToken,
  ApiError,
} from '../src/api/client.js';

function jsonResponse(status: number, body: unknown): Response {
  const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('apiFetch', () => {
  beforeEach(() => {
    clearTokens();
    setApiBase('https://api.example.test');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    clearTokens();
  });

  it('attaches the bearer header on a happy-path GET and parses JSON', async () => {
    setTokens({ access: 'AAA', refresh: 'RRR' });
    const fetchMock = vi.fn(async () => jsonResponse(200, { ok: true, value: 42 }));
    vi.stubGlobal('fetch', fetchMock);

    const data = await apiFetch<{ ok: boolean; value: number }>('/ping');

    expect(data).toEqual({ ok: true, value: 42 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example.test/ping');
    const headers = new Headers(init.headers ?? undefined);
    expect(headers.get('Authorization')).toBe('Bearer AAA');
  });

  it('on 401 refreshes tokens and retries the original request once', async () => {
    setTokens({ access: 'OLD', refresh: 'R1' });

    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const testCalls = calls.filter((c) => c.url.endsWith('/secure')).length;
      if (url.endsWith('/auth/refresh')) {
        return jsonResponse(200, { access_token: 'NEW', refresh_token: 'R2' });
      }
      if (url.endsWith('/secure') && testCalls === 1) {
        return jsonResponse(401, { detail: 'token expired' });
      }
      return jsonResponse(200, { ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);

    const data = await apiFetch<{ ok: boolean }>('/secure');

    expect(data).toEqual({ ok: true });
    expect(calls).toHaveLength(3);
    expect(calls[0].url).toBe('https://api.example.test/secure');
    expect(new Headers(calls[0].init.headers ?? undefined).get('Authorization')).toBe('Bearer OLD');
    expect(calls[1].url).toBe('https://api.example.test/auth/refresh');
    expect(calls[1].init.body).toBe(JSON.stringify({ refresh_token: 'R1' }));
    expect(calls[2].url).toBe('https://api.example.test/secure');
    expect(new Headers(calls[2].init.headers ?? undefined).get('Authorization')).toBe('Bearer NEW');
    expect(getAccessToken()).toBe('NEW');
    expect(getRefreshToken()).toBe('R2');
  });

  it('clears tokens and throws ApiError when refresh itself returns 401', async () => {
    setTokens({ access: 'OLD', refresh: 'R1' });

    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/auth/refresh')) {
        return jsonResponse(401, { detail: 'refresh token revoked' });
      }
      return jsonResponse(401, { detail: 'token expired' });
    });
    vi.stubGlobal('fetch', fetchMock);

    let caught: unknown = null;
    try {
      await apiFetch('/secure');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(401);
    expect((caught as ApiError).detail).toBe('token expired');
    expect(getAccessToken()).toBeNull();
    expect(getRefreshToken()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws ApiError with .status and .detail on non-2xx non-401 responses', async () => {
    setTokens({ access: 'AAA', refresh: 'RRR' });
    const fetchMock = vi.fn(async () => jsonResponse(400, { detail: 'bad input' }));
    vi.stubGlobal('fetch', fetchMock);

    let caught: unknown = null;
    try {
      await apiFetch('/validate');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(400);
    expect((caught as ApiError).detail).toBe('bad input');
    expect(getAccessToken()).toBe('AAA');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
