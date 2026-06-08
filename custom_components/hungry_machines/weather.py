"""Daily weather forecast pusher.

Once per day (typically ~03:30 UTC, just before the API's nightly
optimization at 04:00 UTC), this module:

1. Looks up the user's `weather_entity_id` via `/auth/me`. Skip if unset
   (the API falls back to Open-Meteo).
2. Calls HA's `weather.get_forecasts` service against that entity to
   pull at least 24 hourly forecast points.
3. Transforms into the API's expected shape:
       {
         "forecast": {
           "hourly_temps_f": float[24..48],
           "hourly_humidity": float[]?,
           "hourly_wind_mph": float[]?,
           "forecast_date": "YYYY-MM-DD",  # the local date hourly[0] covers
         }
       }
4. POSTs to `/api/v1/weather`.

**Local-midnight alignment.** Each forecast item carries an absolute
`datetime` from HA. We bin those into 24 buckets keyed to "hours since
the next LOCAL midnight" so the array the server receives always has
`hourly_temps_f[0]` = 00:00 local on `forecast_date`. The previous
version pushed the raw `forecast_list` whose item 0 = push time, which
meant an EDT push at 03:30 EDT shifted the whole array by 3.5 hours
relative to the server's "hour 0 = local midnight" assumption — and
that 3.5-hour shift propagated into the thermal model fitter via the
forecast lookup.

Tolerates: missing weather entity, weather entity that doesn't support
`get_forecasts`, partial fields (humidity / wind missing), and
unit-conversion (HA's metric weather entities expose temp in °C).
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from . import api

_LOGGER = logging.getLogger(__name__)


def _c_to_f(c: float) -> float:
    return c * 9.0 / 5.0 + 32.0


def _kmh_to_mph(kmh: float) -> float:
    return kmh / 1.609344


def _ms_to_mph(ms: float) -> float:
    return ms * 2.236936


def _align_forecast_to_local_day(
    forecast_list: list[dict],
    temp_unit: str,
    wind_unit: str,
) -> tuple[
    str,
    list[float],
    list[float],
    list[float],
    list[float] | None,
    list[float] | None,
    list[float] | None,
] | None:
    """Re-bin raw HA forecast items into 24 hourly buckets keyed to the
    next LOCAL midnight.

    Returns `(forecast_date, temps_f, humidity, wind_mph)` where:
      * `forecast_date` is the ISO local date for hour 0 of the arrays
      * Arrays are length 24, one entry per local hour
      * Missing humidity / wind buckets are filled with the previous
        valid value (or 50.0 / 5.0 fallback so the server-side
        length-match validation passes)

    Returns None when the forecast doesn't cover at least one full
    local day past `now_local`. The caller should skip the push and
    let the server fall back to Open-Meteo.

    Bucketing strategy: walk each forecast item, parse its absolute
    `datetime`, convert to local, place into the bucket
    `floor((dt_local - local_midnight) / 1h)`. Items before the
    target midnight or past the end of the 24-hour window are
    discarded.
    """
    now_local = dt_util.now()
    # Next local midnight. If now_local IS midnight (rare edge case),
    # we treat "today" as the target — the user's day has just started.
    if now_local.hour == 0 and now_local.minute == 0:
        target_midnight = now_local.replace(second=0, microsecond=0)
    else:
        target_midnight = (now_local + timedelta(days=1)).replace(
            hour=0, minute=0, second=0, microsecond=0
        )

    temps_by_hour: dict[int, float] = {}
    humidity_by_hour: dict[int, float] = {}
    wind_by_hour: dict[int, float] = {}
    cloud_by_hour: dict[int, float] = {}
    precip_by_hour: dict[int, float] = {}
    solar_by_hour: dict[int, float] = {}

    for item in forecast_list:
        if not isinstance(item, dict):
            continue
        dt_raw = item.get("datetime")
        if not isinstance(dt_raw, str):
            continue
        try:
            dt_abs = datetime.fromisoformat(dt_raw.replace("Z", "+00:00"))
        except ValueError:
            continue
        dt_local = dt_util.as_local(dt_abs)
        delta_h = (dt_local - target_midnight).total_seconds() / 3600.0
        # Discard items outside the [0, 24) hour window we want to fill.
        if delta_h < 0 or delta_h >= 24:
            continue
        bucket = int(delta_h)

        t = item.get("temperature")
        if t is not None:
            try:
                temps_by_hour[bucket] = _convert_temp(float(t), temp_unit)
            except (TypeError, ValueError):
                pass
        h = item.get("humidity")
        if h is not None:
            try:
                humidity_by_hour[bucket] = float(h)
            except (TypeError, ValueError):
                pass
        w = item.get("wind_speed")
        if w is not None:
            try:
                wind_by_hour[bucket] = _convert_wind(float(w), wind_unit)
            except (TypeError, ValueError):
                pass
        # Phase 3 — extended signals. Each is best-effort; the HA
        # weather entity vocabulary varies by integration:
        #   Met.no / OpenMeteo expose 'cloud_coverage' (0-100)
        #   Some expose 'cloudiness' or 'cloudiness_pct'
        #   OWM exposes 'precipitation' in mm
        #   Some expose 'precipitation_intensity' in mm/h
        #   Solar irradiance shows up as 'solar_irradiance' (W/m²) or
        #   'uv_index' (0-11+ scale, which we convert)
        for cloud_key in ("cloud_coverage", "cloudiness", "cloudiness_pct"):
            cv = item.get(cloud_key)
            if cv is not None:
                try:
                    cloud_by_hour[bucket] = max(0.0, min(100.0, float(cv)))
                    break
                except (TypeError, ValueError):
                    pass
        for precip_key in ("precipitation", "precipitation_intensity"):
            pv = item.get(precip_key)
            if pv is not None:
                try:
                    precip_by_hour[bucket] = max(0.0, float(pv))
                    break
                except (TypeError, ValueError):
                    pass
        sv = item.get("solar_irradiance")
        if sv is not None:
            try:
                solar_by_hour[bucket] = max(0.0, float(sv))
            except (TypeError, ValueError):
                pass
        else:
            # UV index → rough W/m² estimate. Peak UV ~11 corresponds
            # roughly to peak clear-sky irradiance ~1000 W/m². Linear
            # scale is approximate but good enough for the model to
            # discriminate "sunny" from "overcast".
            uv = item.get("uv_index")
            if uv is not None:
                try:
                    solar_by_hour[bucket] = max(0.0, float(uv) * 90.0)
                except (TypeError, ValueError):
                    pass

    if len(temps_by_hour) < 24:
        # Less than full local-day coverage. The forecast started later
        # than midnight or ran out before evening; either way, we'd be
        # filling gaps with stale data and the model would key off them.
        return None

    # Compact into ordered 24-element arrays. Forward-fill humidity /
    # wind from the last known value so the server's length validation
    # passes (it requires humidity/wind arrays to match temps length).
    temps = [float(temps_by_hour[h]) for h in range(24)]
    humidity = _fill_forward(humidity_by_hour, default=50.0)
    wind = _fill_forward(wind_by_hour, default=5.0)
    # Extended signals: only include when the entity actually provided
    # them for some hour. Send None back to the caller when none of
    # the 24 hours had data; the API treats None arrays as "no signal,
    # use defaults". Forward-filling from a default would be worse —
    # the fitter can't tell "no signal" from "constant 50% clouds".
    cloud = _fill_forward(cloud_by_hour, default=0.0) if cloud_by_hour else None
    precipitation = _fill_forward(precip_by_hour, default=0.0) if precip_by_hour else None
    solar = _fill_forward(solar_by_hour, default=0.0) if solar_by_hour else None

    return (
        target_midnight.date().isoformat(),
        temps,
        humidity,
        wind,
        cloud,
        precipitation,
        solar,
    )


def _fill_forward(by_hour: dict[int, float], *, default: float) -> list[float]:
    """Compact a sparse {hour: value} dict into a 24-element array,
    forward-filling gaps from the previous valid value (default for
    the leading gap if no values are present before that hour)."""
    out: list[float] = []
    last = default
    for h in range(24):
        if h in by_hour:
            last = by_hour[h]
        out.append(last)
    return out


async def _user_weather_entity(hass: HomeAssistant, entry: ConfigEntry) -> str | None:
    """Read /auth/me and return the user's selected weather_entity_id, or None."""
    me = await api._authenticated_request(hass, entry, "GET", "/auth/me")
    if not isinstance(me, dict):
        return None
    eid = me.get("weather_entity_id")
    if isinstance(eid, str) and eid.strip():
        return eid
    return None


def _detect_temp_unit(state: Any) -> str:
    """Best-effort guess at the weather entity's temperature unit.

    HA's modern weather entities expose `temperature_unit` in their
    attributes. If absent we assume Fahrenheit (the integration's
    project default) and let the user re-pick if it's wrong.
    """
    attrs = state.attributes if state is not None else None
    if isinstance(attrs, dict):
        unit = attrs.get("temperature_unit")
        if isinstance(unit, str):
            return unit.upper().lstrip("°")
    return "F"


def _detect_wind_unit(state: Any) -> str:
    attrs = state.attributes if state is not None else None
    if isinstance(attrs, dict):
        unit = attrs.get("wind_speed_unit")
        if isinstance(unit, str):
            return unit.lower()
    return "mph"


def _convert_temp(value: float, unit: str) -> float:
    return value if unit.upper() == "F" else _c_to_f(value)


def _convert_wind(value: float, unit: str) -> float:
    u = unit.lower()
    if u in ("mph",):
        return value
    if u in ("km/h", "kmh", "kph"):
        return _kmh_to_mph(value)
    if u in ("m/s", "ms"):
        return _ms_to_mph(value)
    return value


async def _get_forecast_list(
    hass: HomeAssistant, entity_id: str
) -> list[dict] | None:
    """Call weather.get_forecasts; return the hourly forecast list or None."""
    try:
        result = await hass.services.async_call(
            "weather",
            "get_forecasts",
            {"entity_id": entity_id, "type": "hourly"},
            blocking=True,
            return_response=True,
        )
    except Exception as err:  # noqa: BLE001
        _LOGGER.info(
            "Hungry Machines: weather.get_forecasts failed for %s: %s",
            entity_id,
            err,
        )
        return None
    if not isinstance(result, dict):
        return None
    inner = result.get(entity_id)
    if not isinstance(inner, dict):
        return None
    forecast = inner.get("forecast")
    if not isinstance(forecast, list):
        return None
    return forecast


async def push_today_forecast(
    hass: HomeAssistant, entry: ConfigEntry
) -> bool:
    """Run one weather-push cycle. Returns True iff a forecast was accepted."""
    entity_id = await _user_weather_entity(hass, entry)
    if entity_id is None:
        _LOGGER.info(
            "Hungry Machines: no weather_entity_id set in profile; "
            "API will use Open-Meteo fallback. Configure one in panel Settings."
        )
        return False

    state = hass.states.get(entity_id)
    if state is None:
        _LOGGER.info(
            "Hungry Machines: weather entity '%s' not in hass.states", entity_id
        )
        return False

    forecast_list = await _get_forecast_list(hass, entity_id)
    if not forecast_list:
        _LOGGER.info(
            "Hungry Machines: weather entity '%s' returned no hourly forecast",
            entity_id,
        )
        return False

    temp_unit = _detect_temp_unit(state)
    wind_unit = _detect_wind_unit(state)

    aligned = _align_forecast_to_local_day(forecast_list, temp_unit, wind_unit)
    if aligned is None:
        _LOGGER.info(
            "Hungry Machines: weather entity '%s' returned a forecast that "
            "doesn't fully cover the next 24 local hours; skipping push. "
            "The API will fall back to Open-Meteo for this user.",
            entity_id,
        )
        return False

    (
        forecast_date,
        hourly_temps_f,
        hourly_humidity,
        hourly_wind_mph,
        hourly_cloud,
        hourly_precip,
        hourly_solar,
    ) = aligned

    payload: dict[str, Any] = {
        "hourly_temps_f": hourly_temps_f,
        "hourly_humidity": hourly_humidity,
        "hourly_wind_mph": hourly_wind_mph,
        # Tells the server the local date that hour 0 covers. Without
        # this the server defaults to user-local-today, which is
        # equivalent — but sending it explicitly removes the ambiguity
        # for users whose push lands near midnight local.
        "forecast_date": forecast_date,
    }
    # Phase 3 — only include extended arrays when the weather entity
    # actually provided data. Sending None vs omitting is equivalent
    # to the server; omitting keeps the payload lean for entities
    # that don't expose these signals.
    if hourly_cloud is not None:
        payload["hourly_cloud_coverage_pct"] = hourly_cloud
    if hourly_precip is not None:
        payload["hourly_precipitation_mm"] = hourly_precip
    if hourly_solar is not None:
        payload["hourly_solar_irradiance_w"] = hourly_solar

    return await api.post_weather(hass, entry, payload)
