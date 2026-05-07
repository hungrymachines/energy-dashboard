import { apiFetch } from './client.js';

export interface WeatherForecastPayload {
  hourly_temps_f: number[];
  hourly_humidity?: number[] | null;
  hourly_wind_mph?: number[] | null;
}

export interface WeatherPushBody {
  forecast: WeatherForecastPayload;
}

export interface WeatherPushResponse {
  accepted_hours: number;
  pushed_at: string;
}

/** Push the user's HA weather entity forecast to the API.
 *  The integration's daily weather poller calls this; the panel doesn't
 *  invoke it directly today. Exposed here so the contract is in one place
 *  and a future panel "preview my forecast" feature can reuse it. */
export function push(body: WeatherPushBody): Promise<WeatherPushResponse> {
  return apiFetch<WeatherPushResponse>('/api/v1/weather', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}
