"""Schedule fetcher + applier for the Hungry Machines integration.

v2.0+: applies schedules for every registered appliance, not just HVAC.

Cache shape (`hass.data[DOMAIN]['schedule']`):
    {
        "<appliance_id>": {
            "appliance_type": str,
            "entity_id": str,
            "schedule": {...},   # the JSONB blob the API returned
        },
        ...,
        "fetched_at": ISO8601 string,
    }

Apply logic per type (called once on each :00 / :30 boundary):

* `hvac` — read `schedule.high_temps[slot]` and `schedule.low_temps[slot]`,
  then call `climate.set_temperature` in the shape the thermostat
  actually accepts:
    - `heat_cool` / `auto` mode WITH range support → `target_temp_low`
      and `target_temp_high` (the comfort band)
    - `cool` mode → `temperature` set to the HIGH limit (the temp at
      which AC kicks on)
    - `heat` mode → `temperature` set to the LOW limit (the temp at
      which heat kicks on)
    - `off` / unknown → skip
  Until v2.4.2 we passed the range params unconditionally, which
  raised `ServiceValidationError` on every single-setpoint thermostat
  in cool or heat mode.
* `ev_charger` / `home_battery` — read `schedule.intervals[slot]`
  (boolean), call `switch.turn_on` or `switch.turn_off` on the entity.
* `water_heater` — same boolean → switch service mapping.

A misconfigured / missing entity is logged and skipped, never crashes.
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

_SLOTS_PER_DAY = 48


def _domain_data(hass: HomeAssistant) -> dict[str, Any]:
    return hass.data.setdefault(DOMAIN, {})


async def fetch_today_schedule(
    hass: HomeAssistant, entry: ConfigEntry
) -> dict[str, Any] | None:
    """Fetch /api/v1/schedules and cache one entry per appliance."""
    body = await api.get_schedules(hass, entry)
    if body is None:
        return None
    appliances = body.get("appliances") if isinstance(body, dict) else None
    if not isinstance(appliances, list) or not appliances:
        _LOGGER.info(
            "Hungry Machines schedules response had no appliance entries"
        )
        _domain_data(hass).pop("schedule", None)
        return None

    cache: dict[str, Any] = {
        "fetched_at": datetime.now(timezone.utc).isoformat(),
    }
    for entry_data in appliances:
        if not isinstance(entry_data, dict):
            continue
        aid = entry_data.get("appliance_id")
        if not isinstance(aid, str):
            continue
        entities = entry_data.get("entities") or {}
        entity_id = (
            entities.get("entity_id") if isinstance(entities, dict) else None
        )
        cache[aid] = {
            "appliance_type": entry_data.get("appliance_type"),
            "entity_id": entity_id,
            "schedule": entry_data.get("schedule") or {},
        }
    _domain_data(hass)["schedule"] = cache
    return cache


def _current_slot(now: datetime | None = None) -> int:
    now = now or datetime.now()
    return (now.hour * 2) + (1 if now.minute >= 30 else 0)


# homeassistant.components.climate.const.ClimateEntityFeature bitmasks.
# Hard-coded to avoid importing climate (keeps this module light + lets
# tests run against a stubbed homeassistant package without pulling in
# the climate platform).
_FEATURE_TARGET_TEMPERATURE = 1
_FEATURE_TARGET_TEMPERATURE_RANGE = 2

# HA HVACMode string values that accept range setpoints (low + high).
# Single-setpoint modes (`cool`, `heat`) require `temperature` instead.
_RANGE_HVAC_MODES = frozenset({"heat_cool", "auto"})


def _build_hvac_payload(
    entity_id: str,
    state: object | None,
    high: float,
    low: float,
) -> dict | None:
    """Pick the climate.set_temperature payload shape for this thermostat.

    Returns the kwargs dict, or None when the entity is missing / off /
    in an unknown mode (caller skips the service call).
    """
    if state is None:
        _LOGGER.info(
            "Hungry Machines HVAC: entity %s not found, skipping", entity_id
        )
        return None
    raw_state = getattr(state, "state", None) or ""
    hvac_mode = str(raw_state).lower()
    attrs = getattr(state, "attributes", None) or {}
    try:
        features = int(attrs.get("supported_features", 0))
    except (TypeError, ValueError):
        features = 0
    supports_range = bool(features & _FEATURE_TARGET_TEMPERATURE_RANGE)

    base = {"entity_id": entity_id}
    if hvac_mode in _RANGE_HVAC_MODES and supports_range:
        return {**base, "target_temp_low": low, "target_temp_high": high}
    if hvac_mode == "cool":
        # AC kicks on above setpoint — keep home AT OR BELOW the high
        # comfort limit by setting the cooling target to high.
        return {**base, "temperature": high}
    if hvac_mode == "heat":
        # Heat kicks on below setpoint — keep home AT OR ABOVE the low
        # comfort limit by setting the heating target to low.
        return {**base, "temperature": low}
    if hvac_mode in _RANGE_HVAC_MODES:
        # Range mode but entity doesn't expose range support — fall back
        # to a single setpoint at the band midpoint. Not ideal, but it
        # keeps a deadband-style thermostat hovering inside the band.
        return {**base, "temperature": round((high + low) / 2, 2)}
    _LOGGER.info(
        "Hungry Machines HVAC: %s is in mode '%s', skipping setpoint apply",
        entity_id,
        hvac_mode or "(unknown)",
    )
    return None


async def _apply_hvac(
    hass: HomeAssistant, entity_id: str, schedule: dict, slot: int
) -> None:
    highs = schedule.get("high_temps") or []
    lows = schedule.get("low_temps") or []
    if slot >= len(highs) or slot >= len(lows):
        _LOGGER.warning(
            "Hungry Machines HVAC slot %s out of range (high=%d low=%d) for %s",
            slot,
            len(highs),
            len(lows),
            entity_id,
        )
        return

    state = hass.states.get(entity_id) if hass.states else None
    payload = _build_hvac_payload(entity_id, state, highs[slot], lows[slot])
    if payload is None:
        return

    try:
        await hass.services.async_call(
            "climate",
            "set_temperature",
            payload,
            blocking=False,
        )
    except Exception as err:  # noqa: BLE001
        _LOGGER.warning(
            "Hungry Machines HVAC apply failed for %s: %s", entity_id, err
        )


async def _apply_switch(
    hass: HomeAssistant, entity_id: str, schedule: dict, slot: int
) -> None:
    intervals = schedule.get("intervals") or []
    if slot >= len(intervals):
        _LOGGER.warning(
            "Hungry Machines switch slot %s out of range (intervals=%d) for %s",
            slot,
            len(intervals),
            entity_id,
        )
        return
    on = bool(intervals[slot])
    domain, _, _ = entity_id.partition(".")
    service = "turn_on" if on else "turn_off"
    try:
        await hass.services.async_call(
            domain or "switch",
            service,
            {"entity_id": entity_id},
            blocking=False,
        )
    except Exception as err:  # noqa: BLE001
        _LOGGER.warning(
            "Hungry Machines switch apply failed for %s: %s", entity_id, err
        )


async def apply_current_slot(
    hass: HomeAssistant, entry: ConfigEntry
) -> None:
    """Walk the cached schedule and apply each appliance's current-slot value."""
    cache = _domain_data(hass).get("schedule")
    if not cache:
        _LOGGER.info(
            "Hungry Machines: no schedule cached, skipping apply"
        )
        return

    slot = _current_slot()
    for aid, info in cache.items():
        if aid == "fetched_at":
            continue
        if not isinstance(info, dict):
            continue
        atype = info.get("appliance_type")
        entity_id = info.get("entity_id")
        schedule = info.get("schedule") or {}
        if not isinstance(entity_id, str) or not entity_id:
            _LOGGER.info(
                "Hungry Machines apply: appliance %s (%s) missing entity_id; skipping",
                aid,
                atype,
            )
            continue
        if not schedule:
            _LOGGER.info(
                "Hungry Machines apply: appliance %s (%s) has empty schedule "
                "(source=defaults?); skipping",
                aid,
                atype,
            )
            continue
        if atype == "hvac":
            await _apply_hvac(hass, entity_id, schedule, slot)
        elif atype in ("ev_charger", "home_battery", "water_heater"):
            await _apply_switch(hass, entity_id, schedule, slot)
        else:
            _LOGGER.info(
                "Hungry Machines apply: unknown appliance_type=%s for %s; skipping",
                atype,
                aid,
            )
