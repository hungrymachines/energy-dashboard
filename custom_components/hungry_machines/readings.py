"""Sensor readings poller for the Hungry Machines integration.

v2.0+: appliance-driven loop. Every 5 minutes:

1. Fetch the user's appliances from `/api/v1/appliances`.
2. For each registered appliance, look up `config.entity_id` (and any aux
   sensor entity such as `soc_entity_id` / `temp_entity_id`) and read
   their current state from `hass.states`.
3. Build the appropriate per-type reading payload:
   - `hvac` → POST to `/api/v1/readings` (the home-level endpoint that
     feeds the thermal-model fitter; uses `current_temperature` +
     `hvac_state` from the climate entity).
   - `ev_charger` / `home_battery` → POST to
     `/api/v1/appliances/{id}/readings` with `value` = SoC % and
     `state` = "CHARGING"/"IDLE"/"ON"/"OFF" derived from the switch state.
   - `water_heater` → POST to `/api/v1/appliances/{id}/readings` with
     `value` = tank temperature and `state` derived from the switch.

Skip paths log at INFO with enough context to debug a misconfigured
entity from `home-assistant.log` without enabling debug-level logging.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from . import api

_LOGGER = logging.getLogger(__name__)

_VALID_HVAC_STATES = ("HEAT", "COOL", "OFF", "FAN")


def _coerce_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _read_state(hass: HomeAssistant, entity_id: str) -> Any | None:
    state = hass.states.get(entity_id) if entity_id else None
    if state is None:
        _LOGGER.info(
            "Hungry Machines: configured entity '%s' is not present in hass.states; skipping",
            entity_id,
        )
        return None
    return state


def _build_hvac_home_reading(state: Any) -> dict | None:
    """Build the /api/v1/readings payload from the HVAC climate entity."""
    indoor_temp = state.attributes.get("current_temperature")
    if indoor_temp is None:
        _LOGGER.info(
            "Hungry Machines: HVAC entity '%s' lacks current_temperature attribute "
            "(attrs=%s, state=%s); home reading skipped",
            state.entity_id,
            sorted(state.attributes.keys()) if state.attributes else [],
            state.state,
        )
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


def _on_off_state(state_str: str) -> str:
    """Map an HA switch state to one of the documented appliance states."""
    s = (state_str or "").lower()
    if s in ("on", "charging"):
        return "CHARGING" if s == "charging" else "ON"
    if s in ("off", "idle"):
        return "IDLE" if s == "idle" else "OFF"
    return "OFF"


def _build_charge_reading(
    hass: HomeAssistant, control_state: Any, soc_entity_id: str | None
) -> dict | None:
    """Per-appliance reading for an EV charger / home battery."""
    soc: float | None = None
    if soc_entity_id:
        soc_state = _read_state(hass, soc_entity_id)
        if soc_state is not None:
            soc = _coerce_float(soc_state.state)
    if soc is None:
        # Without a SoC sensor we still send the on/off state but the
        # value field is required by the API. Use 0.0 — the optimizer
        # uses constraints (target_charge_pct etc) for its planning,
        # not raw readings, so this is harmless.
        soc = 0.0
    reading = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "state": _on_off_state(control_state.state),
        "value": max(0.0, min(100.0, soc)),
    }
    return reading


def _build_water_heater_reading(
    hass: HomeAssistant, control_state: Any, temp_entity_id: str | None
) -> dict | None:
    """Per-appliance reading for a water heater."""
    tank_temp: float | None = None
    if temp_entity_id:
        temp_state = _read_state(hass, temp_entity_id)
        if temp_state is not None:
            tank_temp = _coerce_float(temp_state.state)
    if tank_temp is None:
        # Same fallback logic as the charge reading: send a plausible
        # default. The water-heater optimizer cares about constraints +
        # element wattage + insulation_factor more than raw tank temp.
        tank_temp = 120.0
    return {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "state": _on_off_state(control_state.state),
        "value": max(60.0, min(180.0, tank_temp)),
    }


async def push_all_readings(hass: HomeAssistant, entry: ConfigEntry) -> int:
    """Run one polling cycle. Returns the number of readings successfully posted."""
    appliances = await api.get_appliances(hass, entry)
    if appliances is None:
        return 0
    if not appliances:
        _LOGGER.info(
            "Hungry Machines: no appliances registered yet; nothing to read. "
            "Add an appliance via the panel's 'Add appliance' button."
        )
        return 0

    successes = 0
    for appliance in appliances:
        atype = appliance.get("appliance_type")
        aid = appliance.get("id")
        config = appliance.get("config") or {}
        entity_id = config.get("entity_id") if isinstance(config, dict) else None
        if not isinstance(entity_id, str) or not entity_id:
            _LOGGER.info(
                "Hungry Machines: appliance %s (%s) has no entity_id in config; skipping",
                aid,
                atype,
            )
            continue
        control_state = _read_state(hass, entity_id)
        if control_state is None:
            continue

        if atype == "hvac":
            reading = _build_hvac_home_reading(control_state)
            if reading is None:
                continue
            ok = await api.post_home_reading(hass, entry, reading)
        elif atype in ("ev_charger", "home_battery"):
            reading = _build_charge_reading(
                hass, control_state, config.get("soc_entity_id")
            )
            if reading is None:
                continue
            ok = await api.post_appliance_reading(hass, entry, aid, reading)
        elif atype == "water_heater":
            reading = _build_water_heater_reading(
                hass, control_state, config.get("temp_entity_id")
            )
            if reading is None:
                continue
            ok = await api.post_appliance_reading(hass, entry, aid, reading)
        else:
            _LOGGER.info(
                "Hungry Machines: unknown appliance_type=%s for %s; skipping",
                atype,
                aid,
            )
            continue
        if ok:
            successes += 1
    return successes


# Backwards-compatible name retained for tests + __init__.py wiring; the
# function now drives the multi-appliance loop instead of polling a single
# climate entity.
async def push_current_reading(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Compatibility shim: returns True iff at least one reading was posted."""
    n = await push_all_readings(hass, entry)
    return n > 0
