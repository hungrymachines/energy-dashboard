"""Schedule fetcher + applier for the Hungry Machines integration.

Fetches the latest optimized HVAC schedule from the API once per setup and
again every morning, then writes the appropriate target temperatures to the
configured climate entity on each 30-minute boundary.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

import aiohttp
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers import aiohttp_client

from . import auth
from .const import API_BASE_URL, CONF_CLIMATE_ENTITY, DOMAIN

_LOGGER = logging.getLogger(__name__)

_SLOTS_PER_DAY = 48


def _domain_data(hass: HomeAssistant) -> dict[str, Any]:
    return hass.data.setdefault(DOMAIN, {})


async def fetch_today_schedule(
    hass: HomeAssistant, entry: ConfigEntry
) -> dict[str, Any] | None:
    """Fetch today's HVAC schedule and cache it on hass.data."""
    token = await auth.current_token(hass, entry)
    if token is None:
        _LOGGER.warning(
            "Hungry Machines token unavailable; triggering reauth"
        )
        entry.async_start_reauth(hass)
        return None

    session = aiohttp_client.async_get_clientsession(hass)
    try:
        async with session.get(
            f"{API_BASE_URL}/api/v1/schedules",
            headers={"Authorization": f"Bearer {token}"},
        ) as resp:
            if resp.status == 401:
                _domain_data(hass).pop("schedule", None)
                _LOGGER.warning(
                    "Hungry Machines schedules endpoint rejected token; "
                    "triggering reauth"
                )
                entry.async_start_reauth(hass)
                return None
            if resp.status >= 400:
                _LOGGER.warning(
                    "Hungry Machines schedules fetch failed (status=%s); "
                    "keeping cached schedule",
                    resp.status,
                )
                return None
            body = await resp.json()
    except aiohttp.ClientError as err:
        _LOGGER.warning(
            "Hungry Machines schedules network error: %s; "
            "keeping cached schedule",
            err,
        )
        return None
    except ValueError as err:
        _LOGGER.warning(
            "Hungry Machines schedules response not JSON: %s; "
            "keeping cached schedule",
            err,
        )
        return None

    appliances = (
        body.get("appliances")
        or body.get("schedules")
        or (body if isinstance(body, list) else [])
    )
    hvac = next(
        (a for a in appliances if a.get("appliance_type") == "hvac"),
        None,
    )
    if hvac is None:
        _LOGGER.info(
            "Hungry Machines schedules response had no hvac entry"
        )
        return None

    cached = {
        "high_temps": list(hvac.get("high_temps") or []),
        "low_temps": list(hvac.get("low_temps") or []),
        "fetched_at": datetime.now(timezone.utc).isoformat(),
    }
    _domain_data(hass)["schedule"] = cached
    return cached


async def apply_current_slot(
    hass: HomeAssistant, entry: ConfigEntry
) -> None:
    """Write the current 30-minute slot's targets to the climate entity."""
    cache = _domain_data(hass).get("schedule")
    if not cache:
        _LOGGER.info(
            "Hungry Machines: no schedule cached, skipping apply"
        )
        return

    climate_entity = entry.options.get(
        CONF_CLIMATE_ENTITY
    ) or entry.data.get(CONF_CLIMATE_ENTITY)
    if not climate_entity:
        _LOGGER.info(
            "Hungry Machines: no climate entity configured, skipping apply"
        )
        return

    now = datetime.now()
    slot = (now.hour * 2) + (1 if now.minute >= 30 else 0)
    high_temps = cache.get("high_temps") or []
    low_temps = cache.get("low_temps") or []
    if slot >= len(high_temps) or slot >= len(low_temps):
        _LOGGER.warning(
            "Hungry Machines slot %s out of range (high=%d low=%d)",
            slot,
            len(high_temps),
            len(low_temps),
        )
        return

    try:
        await hass.services.async_call(
            "climate",
            "set_temperature",
            {
                "entity_id": climate_entity,
                "target_temp_low": low_temps[slot],
                "target_temp_high": high_temps[slot],
            },
            blocking=False,
        )
    except Exception as err:  # noqa: BLE001 — bad climate must not crash
        _LOGGER.warning(
            "Hungry Machines apply_current_slot failed: %s", err
        )
