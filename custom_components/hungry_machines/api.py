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


async def post_home_reading(
    hass: HomeAssistant, entry: ConfigEntry, reading: dict
) -> bool:
    """Post a single home sensor reading to /api/v1/readings (thermal model)."""
    body = await _authenticated_request(
        hass, entry, "POST", "/api/v1/readings", json={"readings": [reading]}
    )
    return body is not None


async def post_appliance_reading(
    hass: HomeAssistant, entry: ConfigEntry, appliance_id: str, reading: dict
) -> bool:
    """Post a single per-appliance reading to /api/v1/appliances/{id}/readings."""
    body = await _authenticated_request(
        hass,
        entry,
        "POST",
        f"/api/v1/appliances/{appliance_id}/readings",
        json={"readings": [reading]},
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
