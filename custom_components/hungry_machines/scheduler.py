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

* `hvac` — read `schedule.setpoint_temps[slot]` (a single per-interval
  setpoint the backend's optimizer derived and clamped to the user's
  comfort band), then call `climate.set_temperature` with that value
  regardless of HVAC mode. The physical thermostat applies its own
  deadband around whatever value we send, so we do NOT wrap the
  setpoint in another band on this side. The mode only changes the
  service-call shape, not the value:
    - `heat_cool` / `auto` + range support → low = high = setpoint
    - `cool` / `heat` → `temperature` = setpoint
    - `heat_cool` / `auto` without range support → `temperature` = setpoint
    - `off` / unknown → skip
  If `setpoint_temps` is missing from a schedule entry, the slot is
  skipped — there is no fallback. The backend is the single source
  of truth for the commanded setpoint.

  Until v2.4.2 we passed range params unconditionally and let the
  thermostat deadband-control within the comfort band. v2.4.3 moves
  the control authority into the backend so the home tracks the
  optimizer's plan tightly.
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
    setpoint: float,
) -> dict | None:
    """Build the climate.set_temperature payload for a single setpoint.

    The backend computes the optimal setpoint per 30-min interval and
    clamps it to the user's comfort band, so the integration's job is
    just to push that exact value to the thermostat — no deadband
    leeway, no per-mode high/low band. Service-call shape still depends
    on what the entity accepts:

      heat_cool / auto + range support → low = high = setpoint
      cool / heat                      → temperature = setpoint
      heat_cool / auto, no range       → temperature = setpoint
      off / unknown                    → skip (no setpoint applied)

    Returns the kwargs dict, or None when the entity is missing / off /
    in an unknown mode.
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
        # Tight degenerate band — same value for both sides forces the
        # thermostat to maintain the exact setpoint.
        return {**base, "target_temp_low": setpoint, "target_temp_high": setpoint}
    if hvac_mode in ("cool", "heat") or hvac_mode in _RANGE_HVAC_MODES:
        return {**base, "temperature": setpoint}
    _LOGGER.info(
        "Hungry Machines HVAC: %s is in mode '%s', skipping setpoint apply",
        entity_id,
        hvac_mode or "(unknown)",
    )
    return None


def _resolve_setpoint(schedule: dict, slot: int) -> float | None:
    """Pull the slot's commanded setpoint from the schedule.

    The backend writes `setpoint_temps[48]` (the optimizer's clamped
    target). This is the only source of truth — the physical thermostat
    already applies its own deadband around whatever value we send, so
    there's no need to invent a fallback or wrap the setpoint in our
    own band on this side.
    """
    setpoints = schedule.get("setpoint_temps")
    if not isinstance(setpoints, list) or slot >= len(setpoints):
        return None
    try:
        return float(setpoints[slot])
    except (TypeError, ValueError):
        return None


async def _apply_hvac(
    hass: HomeAssistant, entity_id: str, schedule: dict, slot: int
) -> None:
    setpoint = _resolve_setpoint(schedule, slot)
    if setpoint is None:
        _LOGGER.warning(
            "Hungry Machines HVAC slot %s: no setpoint available for %s",
            slot,
            entity_id,
        )
        return

    state = hass.states.get(entity_id) if hass.states else None
    payload = _build_hvac_payload(entity_id, state, setpoint)
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
