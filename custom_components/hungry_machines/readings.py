"""Sensor readings poller for the Hungry Machines integration.

Reads the user's configured climate entity, builds a single sensor reading,
and POSTs it to ``/api/v1/readings`` so the backend's per-user thermal model
fitter has observations to learn from. Tolerates missing entities, missing
attributes, and 4xx responses without crashing.
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
from .const import API_BASE_URL, CONF_CLIMATE_ENTITY

_LOGGER = logging.getLogger(__name__)

_VALID_HVAC_STATES = ("HEAT", "COOL", "OFF", "FAN")


def _build_reading(state: Any) -> dict[str, Any] | None:
    """Build the reading payload from a climate entity state."""
    indoor_temp = state.attributes.get("current_temperature")
    if indoor_temp is None:
        return None

    raw_state = (state.state or "").upper()
    hvac_state = raw_state if raw_state in _VALID_HVAC_STATES else "OFF"

    reading: dict[str, Any] = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "indoor_temp": indoor_temp,
        "hvac_state": hvac_state,
    }

    target_temp = state.attributes.get("temperature")
    if target_temp is not None:
        reading["target_temp"] = target_temp

    indoor_humidity = state.attributes.get("current_humidity")
    if indoor_humidity is not None:
        reading["indoor_humidity"] = indoor_humidity

    return reading


async def push_current_reading(
    hass: HomeAssistant, entry: ConfigEntry
) -> bool:
    """Read the configured climate entity and POST one reading to the API.

    Returns True iff the reading was accepted (HTTP 200/201). Returns False
    when the entity is unconfigured / missing / lacks an indoor temperature,
    or when the API rejects the post. On 401 the entry is flagged for
    reauth. Each skip path logs at INFO so a misconfigured climate entity
    is debuggable without enabling debug-level logging.
    """
    entity_id = entry.options.get(
        CONF_CLIMATE_ENTITY
    ) or entry.data.get(CONF_CLIMATE_ENTITY)
    if not entity_id:
        _LOGGER.info(
            "Hungry Machines readings poll skipped: no climate entity "
            "configured. Set one in Settings → Devices & Services → "
            "Hungry Machines → Configure."
        )
        return False

    state = hass.states.get(entity_id)
    if state is None:
        _LOGGER.info(
            "Hungry Machines readings poll skipped: configured climate "
            "entity '%s' is not present in hass.states (renamed/removed?).",
            entity_id,
        )
        return False

    reading = _build_reading(state)
    if reading is None:
        _LOGGER.info(
            "Hungry Machines readings poll skipped: climate entity '%s' "
            "has no `current_temperature` attribute (got attrs=%s, state=%s). "
            "Not all thermostats expose it; pick a different climate entity "
            "or wire a sensor.* fallback.",
            entity_id,
            sorted(state.attributes.keys()) if state.attributes else [],
            state.state,
        )
        return False

    token = await auth.current_token(hass, entry)
    if token is None:
        _LOGGER.warning(
            "Hungry Machines token unavailable; triggering reauth"
        )
        entry.async_start_reauth(hass)
        return False

    session = aiohttp_client.async_get_clientsession(hass)
    try:
        async with session.post(
            f"{API_BASE_URL}/api/v1/readings",
            headers={"Authorization": f"Bearer {token}"},
            json={"readings": [reading]},
        ) as resp:
            if resp.status == 401:
                _LOGGER.warning(
                    "Hungry Machines readings endpoint rejected token; "
                    "triggering reauth"
                )
                entry.async_start_reauth(hass)
                return False
            if resp.status >= 400:
                _LOGGER.warning(
                    "Hungry Machines readings post failed (status=%s)",
                    resp.status,
                )
                return False
            return True
    except aiohttp.ClientError as err:
        _LOGGER.warning(
            "Hungry Machines readings network error: %s", err
        )
        return False
