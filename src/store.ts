import { ApiError, clearTokens, setTokens } from './api/client.js';
import {
  getMe,
  login as apiLogin,
  signup as apiSignup,
  type SignupBody,
  type UserMe,
} from './api/auth.js';

export type AuthStatus = 'loading' | 'unauthed' | 'authed';

export interface AuthState {
  access: string | null;
  refresh: string | null;
  user: UserMe | null;
  status: AuthStatus;
  error: string | null;
}

export type AuthListener = (state: AuthState) => void;

export interface EntityMap {
  indoor_temp?: string;
  outdoor_temp?: string;
  power?: string;
  weather?: string;
}

export function getEntityMap(): EntityMap {
  const raw = safeGet('hm_entity_map');
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as EntityMap;
    }
  } catch {
    /* fall through to empty */
  }
  return {};
}

export function setEntityMap(map: EntityMap): void {
  safeSet('hm_entity_map', JSON.stringify(map ?? {}));
}

function safeGet(key: string): string | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(key, value);
  } catch {
    /* ignore quota / access errors */
  }
}

function safeRemove(key: string): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.detail || fallback;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

class AuthStore {
  state: AuthState = {
    access: null,
    refresh: null,
    user: null,
    status: 'unauthed',
    error: null,
  };

  private readonly listeners = new Set<AuthListener>();

  subscribe(listener: AuthListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private setState(patch: Partial<AuthState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }

  private persistTokens(access: string, refresh: string): void {
    safeSet('hm_access_token', access);
    safeSet('hm_refresh_token', refresh);
    setTokens({ access, refresh });
  }

  private dropTokens(): void {
    safeRemove('hm_access_token');
    safeRemove('hm_refresh_token');
    clearTokens();
  }

  async hydrate(): Promise<void> {
    const access = safeGet('hm_access_token');
    const refresh = safeGet('hm_refresh_token');

    if (!access || !refresh) {
      this.dropTokens();
      this.setState({
        access: null,
        refresh: null,
        user: null,
        status: 'unauthed',
        error: null,
      });
      return;
    }

    setTokens({ access, refresh });
    this.setState({ access, refresh, status: 'loading', error: null });

    try {
      const user = await getMe();
      this.setState({ user, status: 'authed', error: null });
    } catch (err) {
      this.dropTokens();
      this.setState({
        access: null,
        refresh: null,
        user: null,
        status: 'unauthed',
        error: errorMessage(err, 'Session expired'),
      });
    }
  }

  async login(email: string, password: string): Promise<void> {
    this.setState({ status: 'loading', error: null });
    try {
      const session = await apiLogin({ email, password });
      this.persistTokens(session.access_token, session.refresh_token);
      const user = await getMe();
      this.setState({
        access: session.access_token,
        refresh: session.refresh_token,
        user,
        status: 'authed',
        error: null,
      });
    } catch (err) {
      this.dropTokens();
      this.setState({
        access: null,
        refresh: null,
        user: null,
        status: 'unauthed',
        error: errorMessage(err, 'Login failed'),
      });
    }
  }

  async signup(body: SignupBody): Promise<void> {
    this.setState({ status: 'loading', error: null });
    try {
      const session = await apiSignup(body);
      const access = session.access_token;
      const refresh = session.refresh_token;
      if (typeof access !== 'string' || !access || typeof refresh !== 'string' || !refresh) {
        this.dropTokens();
        this.setState({
          access: null,
          refresh: null,
          user: null,
          status: 'unauthed',
          error: 'Check your email to confirm your account, then sign in.',
        });
        return;
      }
      this.persistTokens(access, refresh);
      const user = await getMe();
      this.setState({
        access,
        refresh,
        user,
        status: 'authed',
        error: null,
      });
    } catch (err) {
      this.dropTokens();
      this.setState({
        access: null,
        refresh: null,
        user: null,
        status: 'unauthed',
        error: errorMessage(err, 'Signup failed'),
      });
    }
  }

  logout(): void {
    this.dropTokens();
    this.setState({
      access: null,
      refresh: null,
      user: null,
      status: 'unauthed',
      error: null,
    });
  }

  patchUser(patch: Partial<UserMe>): void {
    if (!this.state.user) return;
    this.setState({ user: { ...this.state.user, ...patch } });
  }
}

export const authStore = new AuthStore();
