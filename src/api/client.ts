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

async function attemptRefresh(): Promise<boolean> {
  if (!refreshToken) return false;
  const currentRefresh = refreshToken;
  try {
    const resp = await fetch(`${getApiBase()}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: currentRefresh }),
    });
    if (!resp.ok) return false;
    const body = (await parseJson(resp)) as RefreshResponse | null;
    if (!body || typeof body !== 'object') return false;
    const newAccess = body.access_token;
    const newRefresh = body.refresh_token;
    if (typeof newAccess !== 'string' || !newAccess) return false;
    accessToken = newAccess;
    if (typeof newRefresh === 'string' && newRefresh) {
      refreshToken = newRefresh;
    }
    return true;
  } catch {
    return false;
  }
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
    if (!refreshed) {
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
