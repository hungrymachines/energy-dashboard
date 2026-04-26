import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { authStore } from '../src/store.js';
import { setApiBase, getAccessToken, getRefreshToken } from '../src/api/client.js';

function jsonResponse(status: number, body: unknown): Response {
  const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const SAMPLE_ME = {
  user_id: 'user-123',
  email: 'test@example.com',
  location_zip: '94107',
  home_size_sqft: 1800,
  pricing_location: 3,
  timezone: 'America/Los_Angeles',
  subscription_tier: 'free',
};

const SAMPLE_SESSION = {
  access_token: 'ACCESS-1',
  refresh_token: 'REFRESH-1',
  token_type: 'bearer',
  expires_in: 3600,
  user: { id: 'user-123', email: 'test@example.com' },
};

function resetStoreState(): void {
  authStore.state = {
    access: null,
    refresh: null,
    user: null,
    status: 'unauthed',
    error: null,
  };
}

describe('authStore', () => {
  beforeEach(() => {
    setApiBase('https://api.example.test');
    localStorage.clear();
    resetStoreState();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
    resetStoreState();
  });

  it('hydrate with saved tokens populates user and transitions to authed', async () => {
    localStorage.setItem('hm_access_token', 'ACCESS-1');
    localStorage.setItem('hm_refresh_token', 'REFRESH-1');

    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/auth/me')) return jsonResponse(200, SAMPLE_ME);
      return jsonResponse(404, { detail: 'unexpected route' });
    });
    vi.stubGlobal('fetch', fetchMock);

    await authStore.hydrate();

    expect(authStore.state.status).toBe('authed');
    expect(authStore.state.user).toEqual(SAMPLE_ME);
    expect(authStore.state.access).toBe('ACCESS-1');
    expect(authStore.state.refresh).toBe('REFRESH-1');
    expect(getAccessToken()).toBe('ACCESS-1');
    expect(calls[0].url).toBe('https://api.example.test/auth/me');
    expect(new Headers(calls[0].init.headers ?? undefined).get('Authorization')).toBe(
      'Bearer ACCESS-1',
    );
  });

  it('hydrate with saved tokens clears them when /auth/me fails', async () => {
    localStorage.setItem('hm_access_token', 'BAD');
    localStorage.setItem('hm_refresh_token', 'ALSOBAD');

    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/auth/refresh')) return jsonResponse(401, { detail: 'revoked' });
      return jsonResponse(401, { detail: 'bad token' });
    });
    vi.stubGlobal('fetch', fetchMock);

    await authStore.hydrate();

    expect(authStore.state.status).toBe('unauthed');
    expect(authStore.state.user).toBeNull();
    expect(authStore.state.access).toBeNull();
    expect(authStore.state.refresh).toBeNull();
    expect(authStore.state.error).not.toBeNull();
    expect(localStorage.getItem('hm_access_token')).toBeNull();
    expect(localStorage.getItem('hm_refresh_token')).toBeNull();
    expect(getAccessToken()).toBeNull();
    expect(getRefreshToken()).toBeNull();
  });

  it('login success persists tokens to localStorage and populates user', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/auth/login')) return jsonResponse(200, SAMPLE_SESSION);
      if (url.endsWith('/auth/me')) return jsonResponse(200, SAMPLE_ME);
      return jsonResponse(404, { detail: 'unexpected' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const observed: string[] = [];
    const unsubscribe = authStore.subscribe((s) => observed.push(s.status));

    await authStore.login('test@example.com', 'hunter2');

    expect(authStore.state.status).toBe('authed');
    expect(authStore.state.user).toEqual(SAMPLE_ME);
    expect(authStore.state.error).toBeNull();
    expect(localStorage.getItem('hm_access_token')).toBe('ACCESS-1');
    expect(localStorage.getItem('hm_refresh_token')).toBe('REFRESH-1');
    expect(getAccessToken()).toBe('ACCESS-1');
    expect(observed).toContain('loading');
    expect(observed[observed.length - 1]).toBe('authed');

    unsubscribe();
  });

  it('login failure sets error and leaves status unauthed', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(401, { detail: 'Invalid login credentials' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await authStore.login('wrong@example.com', 'nope');

    expect(authStore.state.status).toBe('unauthed');
    expect(authStore.state.user).toBeNull();
    expect(authStore.state.error).toBe('Invalid login credentials');
    expect(localStorage.getItem('hm_access_token')).toBeNull();
    expect(localStorage.getItem('hm_refresh_token')).toBeNull();
    expect(getAccessToken()).toBeNull();
  });

  it('logout clears localStorage, resets tokens, and resets state', async () => {
    localStorage.setItem('hm_access_token', 'ACCESS-1');
    localStorage.setItem('hm_refresh_token', 'REFRESH-1');
    authStore.state = {
      access: 'ACCESS-1',
      refresh: 'REFRESH-1',
      user: SAMPLE_ME,
      status: 'authed',
      error: null,
    };

    authStore.logout();

    expect(authStore.state.status).toBe('unauthed');
    expect(authStore.state.user).toBeNull();
    expect(authStore.state.access).toBeNull();
    expect(authStore.state.refresh).toBeNull();
    expect(localStorage.getItem('hm_access_token')).toBeNull();
    expect(localStorage.getItem('hm_refresh_token')).toBeNull();
    expect(getAccessToken()).toBeNull();
    expect(getRefreshToken()).toBeNull();
  });
});
