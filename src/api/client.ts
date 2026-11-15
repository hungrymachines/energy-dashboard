export class ApiError extends Error {
  readonly status: number;
  readonly detail: string;

  constructor(status: number, detail: string) {
    super(`${status}: ${detail}`);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
  }
}

declare global {
  interface Window {
    HM_API_BASE?: string;
  }
}

const DEFAULT_BASE = 'https://api.hungrymachines.io';

let apiBaseOverride: string | null = null;
let accessToken: string | null = null;
let refreshToken: string | null = null;

function normalizeBase(url: string): string {
  return url.replace(/\/+$/, '');
}

export function setApiBase(url: string): void {
  apiBaseOverride = normalizeBase(url);
}

export function getApiBase(): string {
  if (apiBaseOverride) return apiBaseOverride;
  if (typeof window !== 'undefined' && typeof window.HM_API_BASE === 'string' && window.HM_API_BASE) {
    return normalizeBase(window.HM_API_BASE);
  }
  return DEFAULT_BASE;
}

export function setTokens(tokens: { access: string | null; refresh: string | null }): void {
  accessToken = tokens.access;
  refreshToken = tokens.refresh;
}

export function clearTokens(): void {
  accessToken = null;
  refreshToken = null;
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function getRefreshToken(): string | null {
  return refreshToken;
}

async function parseJson(resp: Response): Promise<unknown> {
  const text = await resp.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function pickDetail(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const obj = body as Record<string, unknown>;
    for (const key of ['detail', 'msg', 'error_description', 'error', 'message']) {
      const val = obj[key];
      if (typeof val === 'string' && val) return val;
    }
  }
  if (typeof body === 'string' && body) return body;
  return fallback;
}

interface RefreshResponse {
  access_token?: unknown;
  refresh_token?: unknown;
}

/** `ok`: new tokens in hand. `rejected`: the server refused the refresh
 * token, so the session is over. `unavailable`: the server could not be
 * reached or failed, so the session may be fine and is kept. */
type RefreshResult = 'ok' | 'rejected' | 'unavailable';

let refreshInFlight: Promise<RefreshResult> | null = null;
let tokenPersister: ((access: string, refresh: string) => void) | null = null;

/** Called with the new pair after every successful refresh. Each refresh
 * token works once, so a pair that is not saved signs the user out on the
 * next page load. */
export function setTokenPersister(fn: ((access: string, refresh: string) => void) | null): void {
  tokenPersister = fn;
}

/** One refresh at a time: requests that hit 401 together share it, so the
 * same refresh token is never sent twice. */
function attemptRefresh(): Promise<RefreshResult> {
  if (!refreshToken) return Promise.resolve('rejected');
  if (!refreshInFlight) {
    refreshInFlight = runRefresh(refreshToken).finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

async function runRefresh(currentRefresh: string): Promise<RefreshResult> {
  let resp: Response;
  try {
    resp = await fetch(`${getApiBase()}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: currentRefresh }),
    });
  } catch {
    return 'unavailable';
  }
  if (resp.status >= 500) return 'unavailable';
  if (!resp.ok) return 'rejected';
  const body = (await parseJson(resp)) as RefreshResponse | null;
  if (!body || typeof body !== 'object') return 'unavailable';
  const newAccess = body.access_token;
  const newRefresh = body.refresh_token;
  if (typeof newAccess !== 'string' || !newAccess) return 'unavailable';
  // Signed out while the refresh was in flight: don't bring the session back.
  if (refreshToken !== currentRefresh) return refreshToken ? 'ok' : 'rejected';
  accessToken = newAccess;
  if (typeof newRefresh === 'string' && newRefresh) {
    refreshToken = newRefresh;
  }
  tokenPersister?.(accessToken, refreshToken ?? currentRefresh);
  return 'ok';
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const url = /^https?:\/\//.test(path) ? path : `${getApiBase()}${path}`;

  const doFetch = async (): Promise<Response> => {
    const headers = new Headers(init.headers ?? undefined);
    if (init.body !== undefined && init.body !== null && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    if (accessToken) {
      headers.set('Authorization', `Bearer ${accessToken}`);
    }
    return fetch(url, { ...init, headers });
  };

  let resp = await doFetch();

  if (resp.status === 401 && refreshToken) {
    const refreshed = await attemptRefresh();
    if (refreshed === 'unavailable') {
      throw new ApiError(503, 'Hungry Machines could not be reached. Try again in a moment.');
    }
    if (refreshed === 'rejected') {
      const body = await parseJson(resp);
      clearTokens();
      throw new ApiError(401, pickDetail(body, 'Unauthorized'));
    }
    resp = await doFetch();
  }

  if (!resp.ok) {
    const body = await parseJson(resp);
    throw new ApiError(resp.status, pickDetail(body, resp.statusText || 'Request failed'));
  }

  if (resp.status === 204) {
    return null as T;
  }
  return (await parseJson(resp)) as T;
}
