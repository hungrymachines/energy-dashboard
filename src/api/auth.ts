import { apiFetch } from './client.js';

export interface SignupBody {
  email: string;
  password: string;
  location_zip?: string;
  home_size_sqft?: number;
  pricing_location?: number;
}

export interface LoginBody {
  email: string;
  password: string;
}

export interface SupabaseUser {
  id: string;
  email?: string;
  user_metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface Session {
  access_token: string;
  refresh_token: string;
  token_type?: string;
  expires_in?: number;
  expires_at?: number;
  user?: SupabaseUser;
}

export interface SignupResponse extends Partial<Session> {
  user?: SupabaseUser;
}

export interface UserMe {
  user_id: string;
  email: string;
  location_zip: string;
  home_size_sqft: number;
  pricing_location: number;
  timezone: string;
  subscription_tier: string;
  weather_entity_id: string;
}

export interface PatchMeBody {
  location_zip?: string;
  home_size_sqft?: number;
  pricing_location?: number;
  timezone?: string;
  weather_entity_id?: string;
}

export function signup(body: SignupBody): Promise<SignupResponse> {
  return apiFetch<SignupResponse>('/auth/signup', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function login(body: LoginBody): Promise<Session> {
  return apiFetch<Session>('/auth/login', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function refresh(refreshToken: string): Promise<Session> {
  return apiFetch<Session>('/auth/refresh', {
    method: 'POST',
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
}

export function getMe(): Promise<UserMe> {
  return apiFetch<UserMe>('/auth/me');
}

export function patchMe(body: PatchMeBody): Promise<UserMe> {
  return apiFetch<UserMe>('/auth/me', {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}
