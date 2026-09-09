"""Tiny shared HTTP client for the Hungry Machines API.

Centralises the auth-token + JSON-POST/GET pattern that scheduler.py,
readings.py, and weather.py all need. Each function:

* Looks up a fresh access token via `auth.current_token`. On miss, returns
  None and triggers reauth (the integration's standard recovery path).
* Makes the request via `aiohttp_client.async_get_clientsession`.
* Treats 401 as another reauth trigger; logs other 4xx/5xx as warnings.

Returns either the parsed JSON body (success) or None (any failure).
"""
from __future__ import annotations

import logging
from typing import Any

import aiohttp
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers import aiohttp_client

from . import auth
from .const import API_BASE_URL
from .version import build_client_info

_LOGGER = logging.getLogger(__name__)


async def _authenticated_request(
    hass: HomeAssistant,
    entry: ConfigEntry,
    method: str,
    path: str,
    *,
    json: Any | None = None,
) -> Any | None:
    token = await auth.current_token(hass, entry)
    if token is None:
        _LOGGER.warning(
            "Hungry Machines token unavailable; triggering reauth (path=%s)",
            path,
        )
        entry.async_start_reauth(hass)
        return None

    session = aiohttp_client.async_get_clientsession(hass)
    url = f"{API_BASE_URL}{path}"
    headers = {"Authorization": f"Bearer {token}"}

    try:
        async with session.request(method, url, headers=headers, json=json) as resp:
            if resp.status == 401:
                _LOGGER.warning(
                    "Hungry Machines %s %s rejected token; triggering reauth",
                    method,
                    path,
                )
                entry.async_start_reauth(hass)
                return None
            if resp.status >= 400:
                body = await resp.text()
                _LOGGER.warning(
                    "Hungry Machines %s %s failed (status=%s): %s",
                    method,
                    path,
                    resp.status,
                    body[:200],
                )
                return None
            if resp.status == 204:
                return {}
            try:
                return await resp.json()
            except (aiohttp.ContentTypeError, ValueError):
                # Endpoint returned non-JSON success body. Treat as success
                # without payload — the readings/weather POSTs only care
                # about the status code, not the body shape.
                return {}
    except aiohttp.ClientError as err:
        _LOGGER.warning(
            "Hungry Machines %s %s network error: %s", method, path, err
        )
        return None


async def get_appliances(hass: HomeAssistant, entry: ConfigEntry) -> list[dict] | None:
    """Fetch the user's appliance list. Returns None on error."""
    body = await _authenticated_request(hass, entry, "GET", "/api/v1/appliances")
    if isinstance(body, list):
        return body
    return None


async def get_schedules(hass: HomeAssistant, entry: ConfigEntry) -> dict | None:
    """Fetch /api/v1/schedules, the unified schedule + entities map."""
    return await _authenticated_request(hass, entry, "GET", "/api/v1/schedules")


async def get_schedules_updated_at(
    hass: HomeAssistant, entry: ConfigEntry
) -> str | None:
    """Fetch /api/v1/schedules/updated-at — a cheap freshness poll.

    Returns the ISO-8601 `updated_at` string, or None when: the request
    fails (network error, 401/5xx — `_authenticated_request` already logs
    and returns None for those), the API predates this route (404, same
    handling), or the user has no `appliance_schedules` row for today yet
    (`{"updated_at": null}`).
    """
    body = await _authenticated_request(
        hass, entry, "GET", "/api/v1/schedules/updated-at"
    )
    if not isinstance(body, dict):
        return None
    updated_at = body.get("updated_at")
    return updated_at if isinstance(updated_at, str) else None


async def post_home_readings(
    hass: HomeAssistant, entry: ConfigEntry, readings: list[dict]
) -> bool:
    """POST a batch of home sensor readings to /api/v1/readings.

    Used for HVAC thermal-model data. The API accepts up to 100 readings
    per call (per app/routes/readings.py:46), so an hourly batch of 12 is
    well within bounds.

    The batch carries a `client` object identifying this build (HACS vs
    fleet node, integration version, node bundle, HA version). The
    backend stamps it onto the user row and raises a fleet event when it
    moves; it is display-only and never changes how a reading is stored.
    """
    if not readings:
        return False
    body = await _authenticated_request(
        hass,
        entry,
        "POST",
        "/api/v1/readings",
        json={"readings": readings, "client": build_client_info()},
    )
    return body is not None


async def post_appliance_readings(
    hass: HomeAssistant, entry: ConfigEntry, appliance_id: str, readings: list[dict]
) -> bool:
    """POST a batch of per-appliance readings to /api/v1/appliances/{id}/readings."""
    if not readings:
        return False
    body = await _authenticated_request(
        hass,
        entry,
        "POST",
        f"/api/v1/appliances/{appliance_id}/readings",
        json={"readings": readings},
    )
    return body is not None


async def post_weather(
    hass: HomeAssistant, entry: ConfigEntry, forecast: dict
) -> bool:
    """Push a weather forecast to /api/v1/weather."""
    body = await _authenticated_request(
        hass, entry, "POST", "/api/v1/weather", json={"forecast": forecast}
    )
    return body is not None
