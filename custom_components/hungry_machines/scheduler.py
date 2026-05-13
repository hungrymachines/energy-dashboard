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
            "name": entry_data.get("name"),
            "schedule": entry_data.get("schedule") or {},
        }
    _domain_data(hass)["schedule"] = cache
    _publish_schedule_states(hass, cache)
    return cache


def _slug(value: str) -> str:
    """Tiny entity-id slugger; HA does this more thoroughly via slugify,
    but importing it pulls extra deps the test stub doesn't provide."""
    cleaned = "".join(
        c.lower() if c.isalnum() else "_" for c in (value or "")
    )
    while "__" in cleaned:
        cleaned = cleaned.replace("__", "_")
    return cleaned.strip("_") or "appliance"


def _publish_schedule_states(hass: HomeAssistant, cache: dict[str, Any]) -> None:
    """Mirror the cached schedule into HA states so users can see the
    full 48-slot plan in Dev Tools → States.

    One state per appliance, named `sensor.hungry_machines_<slug>_schedule`.
    `state` is the current-slot setpoint (HVAC) or boolean (switch-driven
    appliances); `attributes` carry the full 48-slot arrays for charts and
    automations to consume. Pure read-only mirror — apply still goes
    through `climate.set_temperature` / `switch.turn_on`.
    """
    if hass.states is None:
        return
    slot = _current_slot()
    for aid, info in cache.items():
        if aid == "fetched_at" or not isinstance(info, dict):
            continue
        atype = info.get("appliance_type")
        schedule = info.get("schedule") or {}
        name = info.get("name") or aid
        entity_id = f"sensor.hungry_machines_{_slug(str(name))}_schedule"

        attributes: dict[str, Any] = {
            "appliance_id": aid,
            "appliance_type": atype,
            "friendly_name": f"Hungry Machines {name} schedule",
            "current_slot": slot,
            "target_entity": info.get("entity_id"),
            "fetched_at": cache.get("fetched_at"),
            "generated_at": schedule.get("generated_at"),
            "mode": schedule.get("mode"),
        }
        for key in (
            "setpoint_temps",
            "high_temps",
            "low_temps",
            "temp_trajectory",
            "intervals",
        ):
            value = schedule.get(key)
            if isinstance(value, list):
                attributes[key] = value

        state_value: Any = "unknown"
        if atype == "hvac":
            sp = _resolve_setpoint(schedule, slot)
            if sp is not None:
                state_value = sp
                attributes["unit_of_measurement"] = "°F"
                attributes["device_class"] = "temperature"
        elif atype in ("ev_charger", "home_battery", "water_heater"):
            intervals = schedule.get("intervals") or []
            if slot < len(intervals):
                state_value = "on" if bool(intervals[slot]) else "off"

        try:
            hass.states.async_set(entity_id, state_value, attributes)
        except Exception as err:  # noqa: BLE001
            _LOGGER.debug(
                "Hungry Machines: failed to publish schedule state for %s: %s",
                entity_id,
                err,
            )


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


def _clamp_to_entity_range(entity_id: str, attrs: dict, setpoint: float) -> float:
    """Constrain the setpoint to the climate entity's hardware range.

    HA climate entities expose `min_temp` and `max_temp` attributes
    that represent what the AC itself will accept — e.g. a window AC
    typically reports min_temp=64°F, max_temp=86°F. The user's
    Hungry Machines comfort band might extend below or above that
    (e.g. configured low=60°F for aggressive pre-cooling), and the
    backend trajectory can dip outside the configured band on cool
    days. Sending a value outside the entity's hardware range
    surfaces as `ServiceValidationError: Provided temperature X is not
    valid. Accepted range is Y to Z` and aborts the service call.

    Defensive: pull min_temp / max_temp from the entity, fall back to
    HA's defaults (45..95 °F) if either is missing or unparseable, and
    clamp the setpoint into that range. Log the clamp at INFO so the
    operator can see when the AC's hardware limit is stricter than the
    user's configured band.
    """
    # HA climate defaults (homeassistant.components.climate.const).
    DEFAULT_MIN, DEFAULT_MAX = 45.0, 95.0
    try:
        entity_min = float(attrs.get("min_temp")) if attrs.get("min_temp") is not None else DEFAULT_MIN
    except (TypeError, ValueError):
        entity_min = DEFAULT_MIN
    try:
        entity_max = float(attrs.get("max_temp")) if attrs.get("max_temp") is not None else DEFAULT_MAX
    except (TypeError, ValueError):
        entity_max = DEFAULT_MAX

    clamped = max(entity_min, min(setpoint, entity_max))
    if clamped != setpoint:
        _LOGGER.info(
            "Hungry Machines HVAC %s: setpoint %.1f outside entity range "
            "[%.1f, %.1f]; clamped to %.1f",
            entity_id,
            setpoint,
            entity_min,
            entity_max,
            clamped,
        )
    return clamped


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

    Setpoint is additionally clamped to the entity's own min_temp /
    max_temp attributes so a backend value outside the AC's hardware
    range doesn't trigger a ServiceValidationError abort.

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

    # Last-mile defense: never send a value outside the entity's own
    # accepted range. Logs the clamp so operators can see when the
    # backend's value collides with the AC's hardware limits.
    safe_setpoint = _clamp_to_entity_range(entity_id, attrs, setpoint)

    base = {"entity_id": entity_id}
    if hvac_mode in _RANGE_HVAC_MODES and supports_range:
        # Tight degenerate band — same value for both sides forces the
        # thermostat to maintain the exact setpoint.
        return {
            **base,
            "target_temp_low": safe_setpoint,
            "target_temp_high": safe_setpoint,
        }
    if hvac_mode in ("cool", "heat") or hvac_mode in _RANGE_HVAC_MODES:
        return {**base, "temperature": safe_setpoint}
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

    raw_state = getattr(state, "state", None) or "unknown" if state else "missing"
    _LOGGER.info(
        "Hungry Machines HVAC apply: entity=%s slot=%d mode=%s setpoint=%.1f payload=%s",
        entity_id,
        slot,
        raw_state,
        setpoint,
        payload,
    )

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


# Re-fetch the schedule cache when it gets older than this. Apply runs
# every 30 min on the :00/:30 boundary, so a 5-min TTL means *every*
# apply pulls the freshest schedule from the API. That makes
# user-triggered recomputes (PUT /preferences, constraint edits) visible
# at the thermostat on the next half-hour boundary instead of waiting
# 90 min for self-heal.
_CACHE_MAX_AGE_SECONDS = 5 * 60


def _cache_age_seconds(cache: dict) -> float | None:
    """How old is the cached schedule, in seconds. None if unparseable."""
    raw = cache.get("fetched_at")
    if not raw:
        return None
    try:
        if isinstance(raw, datetime):
            fetched_at = raw
        else:
            fetched_at = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
        if fetched_at.tzinfo is None:
            fetched_at = fetched_at.replace(tzinfo=timezone.utc)
    except ValueError:
        return None
    return (datetime.now(timezone.utc) - fetched_at).total_seconds()


def _cache_lacks_setpoints(cache: dict) -> bool:
    """True iff any HVAC appliance in the cache has a non-empty schedule
    that is missing the `setpoint_temps` array.

    This signals stale data — the cache predates the backend deploy
    that started writing setpoint_temps. An empty schedule (source
    `defaults`) does NOT trigger a refresh; it's already handled
    further down by the empty-schedule skip.
    """
    for aid, info in cache.items():
        if aid == "fetched_at" or not isinstance(info, dict):
            continue
        if info.get("appliance_type") != "hvac":
            continue
        schedule = info.get("schedule") or {}
        if not schedule:
            continue
        if not isinstance(schedule.get("setpoint_temps"), list):
            return True
    return False


async def apply_current_slot(
    hass: HomeAssistant, entry: ConfigEntry
) -> None:
    """Walk the cached schedule and apply each appliance's current-slot value."""
    cache = _domain_data(hass).get("schedule")

    # Self-heal: refresh the cache when it's missing, stale, or doesn't
    # carry setpoint_temps for an HVAC appliance. Avoids waiting for
    # the once-a-day refresh after a nightly run finishes or the API
    # gets a new version.
    needs_refresh = False
    if not cache:
        needs_refresh = True
    else:
        age = _cache_age_seconds(cache)
        if age is None or age > _CACHE_MAX_AGE_SECONDS:
            needs_refresh = True
        elif _cache_lacks_setpoints(cache):
            _LOGGER.info(
                "Hungry Machines: cached HVAC schedule lacks setpoint_temps; "
                "refreshing before apply"
            )
            needs_refresh = True

    if needs_refresh:
        await fetch_today_schedule(hass, entry)
        cache = _domain_data(hass).get("schedule")
        if cache and _cache_lacks_setpoints(cache):
            _LOGGER.warning(
                "Hungry Machines: HVAC schedule still has no setpoint_temps "
                "after refresh — the API may be running an older version that "
                "predates per-interval setpoint emission. Trigger a "
                "re-optimization (edit + Save any constraint) once the API is "
                "updated, or wait for tonight's nightly run."
            )

    if not cache:
        _LOGGER.info(
            "Hungry Machines: no schedule cached, skipping apply"
        )
        return

    # Keep the dev-tools sensors in sync with the current slot even if
    # the cache itself didn't change (the slot index advances every
    # 30 min and we want the `state` value to reflect that).
    _publish_schedule_states(hass, cache)

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
