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
           "hourly_temps_f": float[24..72],
           "hourly_humidity": float[]?,
           "hourly_wind_mph": float[]?,
         }
       }
4. POSTs to `/api/v1/weather`.

Tolerates: missing weather entity, weather entity that doesn't support
`get_forecasts`, partial fields (humidity / wind missing), and
unit-conversion (HA's metric weather entities expose temp in °C).
"""
from __future__ import annotations

import logging
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from . import api

_LOGGER = logging.getLogger(__name__)


def _c_to_f(c: float) -> float:
    return c * 9.0 / 5.0 + 32.0


def _kmh_to_mph(kmh: float) -> float:
    return kmh / 1.609344


def _ms_to_mph(ms: float) -> float:
    return ms * 2.236936


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

    hourly_temps_f: list[float] = []
    hourly_humidity: list[float] = []
    hourly_wind_mph: list[float] = []
    for item in forecast_list[:72]:  # API caps at 72 hours
        if not isinstance(item, dict):
            continue
        t = item.get("temperature")
        if t is None:
            continue
        try:
            tf = _convert_temp(float(t), temp_unit)
        except (TypeError, ValueError):
            continue
        hourly_temps_f.append(tf)

        h = item.get("humidity")
        if h is not None:
            try:
                hourly_humidity.append(float(h))
            except (TypeError, ValueError):
                pass

        w = item.get("wind_speed")
        if w is not None:
            try:
                hourly_wind_mph.append(_convert_wind(float(w), wind_unit))
            except (TypeError, ValueError):
                pass

    if len(hourly_temps_f) < 24:
        _LOGGER.info(
            "Hungry Machines: weather entity '%s' only produced %d hourly "
            "points; need at least 24, skipping push",
            entity_id,
            len(hourly_temps_f),
        )
        return False

    payload: dict[str, Any] = {"hourly_temps_f": hourly_temps_f}
    if len(hourly_humidity) == len(hourly_temps_f):
        payload["hourly_humidity"] = hourly_humidity
    if len(hourly_wind_mph) == len(hourly_temps_f):
        payload["hourly_wind_mph"] = hourly_wind_mph

    return await api.post_weather(hass, entry, payload)
