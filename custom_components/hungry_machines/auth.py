"""Authentication helpers for the Hungry Machines integration.

Uses the user's hungrymachines.io email + password (the same credentials they
use on the website and inside the panel) to obtain access + refresh tokens
from the API. Only the tokens (and a short safety margin on expiry) are
persisted in the config entry; the password is never stored.
"""
from __future__ import annotations

import logging
import time
from typing import Any

import aiohttp
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers import aiohttp_client

from .const import (
    API_BASE_URL,
    CONF_ACCESS_TOKEN,
    CONF_EMAIL,
    CONF_EXPIRES_AT,
    CONF_REFRESH_TOKEN,
    CONF_USER_ID,
)

_LOGGER = logging.getLogger(__name__)

_DEFAULT_EXPIRES_IN = 3600
_EXPIRY_SAFETY_MARGIN = 60
_REFRESH_AHEAD_SECONDS = 30


def _shape(data: dict[str, Any], fallback_email: str = "") -> dict[str, Any]:
    user = data.get("user") or {}
    expires_in = data.get("expires_in") or _DEFAULT_EXPIRES_IN
    return {
        CONF_ACCESS_TOKEN: data["access_token"],
        CONF_REFRESH_TOKEN: data["refresh_token"],
        CONF_EXPIRES_AT: time.time() + expires_in - _EXPIRY_SAFETY_MARGIN,
        CONF_USER_ID: user.get("id", ""),
        CONF_EMAIL: user.get("email") or fallback_email,
    }


async def login(
    hass: HomeAssistant, email: str, password: str
) -> dict[str, Any] | None:
    """Exchange email + password for access + refresh tokens."""
    session = aiohttp_client.async_get_clientsession(hass)
    try:
        async with session.post(
            f"{API_BASE_URL}/auth/login",
            json={"email": email, "password": password},
        ) as resp:
            if resp.status >= 400:
                _LOGGER.warning(
                    "Hungry Machines login failed (status=%s)", resp.status
                )
                return None
            data = await resp.json()
    except aiohttp.ClientError as err:
        _LOGGER.warning("Hungry Machines login network error: %s", err)
        return None

    if not data.get("access_token") or not data.get("refresh_token"):
        _LOGGER.warning("Hungry Machines login response missing tokens")
        return None

    return _shape(data, fallback_email=email)


async def refresh(
    hass: HomeAssistant, refresh_token: str
) -> dict[str, Any] | None:
    """Trade a refresh_token for a fresh access_token."""
    session = aiohttp_client.async_get_clientsession(hass)
    try:
        async with session.post(
            f"{API_BASE_URL}/auth/refresh",
            json={"refresh_token": refresh_token},
        ) as resp:
            if resp.status >= 400:
                _LOGGER.warning(
                    "Hungry Machines token refresh failed (status=%s)",
                    resp.status,
                )
                return None
            data = await resp.json()
    except aiohttp.ClientError as err:
        _LOGGER.warning("Hungry Machines token refresh network error: %s", err)
        return None

    if not data.get("access_token") or not data.get("refresh_token"):
        _LOGGER.warning("Hungry Machines refresh response missing tokens")
        return None

    return _shape(data)


async def current_token(
    hass: HomeAssistant, entry: ConfigEntry
) -> str | None:
    """Return a still-valid access_token, refreshing if necessary."""
    expires_at = entry.data.get(CONF_EXPIRES_AT, 0) or 0
    if expires_at > time.time() + _REFRESH_AHEAD_SECONDS:
        return entry.data.get(CONF_ACCESS_TOKEN)

    refresh_token = entry.data.get(CONF_REFRESH_TOKEN)
    if not refresh_token:
        return None

    new = await refresh(hass, refresh_token)
    if new is None:
        return None

    updated = {
        **entry.data,
        CONF_ACCESS_TOKEN: new[CONF_ACCESS_TOKEN],
        CONF_REFRESH_TOKEN: new[CONF_REFRESH_TOKEN],
        CONF_EXPIRES_AT: new[CONF_EXPIRES_AT],
    }
    hass.config_entries.async_update_entry(entry, data=updated)
    return new[CONF_ACCESS_TOKEN]
