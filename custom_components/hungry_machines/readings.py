"""Sensor readings: 5-min capture, hourly batched flush.

v2.1+: split into two timers to reduce API call volume by ~12×.

* `capture_readings` (every 5 min) iterates the user's appliances, reads
  each one's HA entity, and APPENDS one reading per appliance to an
  in-memory buffer keyed by destination endpoint:
      hass.data[DOMAIN]['readings_buffer'] = {
          'home':       [reading, ...],          # → POST /api/v1/readings
          '<appliance_id>': [reading, ...],      # → POST /api/v1/appliances/{id}/readings
      }
* `flush_readings` (top of every hour, ~minute=2) drains the buffer with
  one POST per non-empty key. On success the corresponding sublist is
  cleared; on failure (4xx, network, etc.) the buffer is retained so the
  next flush retries.

Trade-offs:
* HA restart between flushes loses any unflushed readings (≤55 min). For
  a 14-day thermal-model fit this is invisible. If it ever matters, swap
  the dict-in-hass-data for `homeassistant.helpers.storage.Store`.
* The backend's 100-reading-per-batch validator (readings.py:46) caps a
  batch at 100, so the worst case (12 captures × all 4 appliance types)
  is well below the limit even if a flush is retried with 60+ minutes
  of accumulated data.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from . import api
from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

_VALID_HVAC_STATES = ("HEAT", "COOL", "OFF", "FAN")
_HOME_BUCKET = "home"
_BUFFER_KEY = "readings_buffer"


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
    soc: float | None = None
    if soc_entity_id:
        soc_state = _read_state(hass, soc_entity_id)
        if soc_state is not None:
            soc = _coerce_float(soc_state.state)
    if soc is None:
        soc = 0.0
    return {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "state": _on_off_state(control_state.state),
        "value": max(0.0, min(100.0, soc)),
    }


def _build_water_heater_reading(
    hass: HomeAssistant, control_state: Any, temp_entity_id: str | None
) -> dict | None:
    tank_temp: float | None = None
    if temp_entity_id:
        temp_state = _read_state(hass, temp_entity_id)
        if temp_state is not None:
            tank_temp = _coerce_float(temp_state.state)
    if tank_temp is None:
        tank_temp = 120.0
    return {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "state": _on_off_state(control_state.state),
        "value": max(60.0, min(180.0, tank_temp)),
    }


def _buffer(hass: HomeAssistant) -> dict[str, list[dict]]:
    return hass.data.setdefault(DOMAIN, {}).setdefault(_BUFFER_KEY, {})


def _append(hass: HomeAssistant, key: str, reading: dict) -> None:
    buf = _buffer(hass)
    buf.setdefault(key, []).append(reading)


async def capture_readings(hass: HomeAssistant, entry: ConfigEntry) -> int:
    """Read every appliance's HA entity and append to the in-memory buffer.

    Returns the number of readings captured this tick. Does NOT post —
    `flush_readings` is responsible for the network call.
    """
    appliances = await api.get_appliances(hass, entry)
    if appliances is None:
        return 0
    if not appliances:
        _LOGGER.info(
            "Hungry Machines: no appliances registered yet; nothing to capture. "
            "Add an appliance via the panel's 'Add appliance' button."
        )
        return 0

    captured = 0
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
            _append(hass, _HOME_BUCKET, reading)
            captured += 1
        elif atype in ("ev_charger", "home_battery"):
            reading = _build_charge_reading(
                hass, control_state, config.get("soc_entity_id")
            )
            if reading is None:
                continue
            _append(hass, aid, reading)
            captured += 1
        elif atype == "water_heater":
            reading = _build_water_heater_reading(
                hass, control_state, config.get("temp_entity_id")
            )
            if reading is None:
                continue
            _append(hass, aid, reading)
            captured += 1
        else:
            _LOGGER.info(
                "Hungry Machines: unknown appliance_type=%s for %s; skipping",
                atype,
                aid,
            )
    return captured


async def flush_readings(hass: HomeAssistant, entry: ConfigEntry) -> int:
    """POST every non-empty bucket and clear it on success.

    Returns the number of readings successfully POSTed. Failed buckets are
    retained for the next flush — POSTs are simple inserts on the backend
    and the timestamp ordering means a retry won't double-count anything
    the optimizer cares about.
    """
    buf = _buffer(hass)
    if not buf:
        return 0

    sent = 0
    for key in list(buf.keys()):
        readings = buf.get(key) or []
        if not readings:
            continue
        if key == _HOME_BUCKET:
            ok = await api.post_home_readings(hass, entry, readings)
        else:
            ok = await api.post_appliance_readings(hass, entry, key, readings)
        if ok:
            sent += len(readings)
            buf[key] = []
        else:
            _LOGGER.info(
                "Hungry Machines: flush of %d readings to bucket=%s failed; "
                "retaining for next flush",
                len(readings),
                key,
            )
    return sent


def buffered_count(hass: HomeAssistant) -> int:
    """Total readings currently buffered. Useful for tests + diagnostics."""
    return sum(len(v) for v in _buffer(hass).values())
