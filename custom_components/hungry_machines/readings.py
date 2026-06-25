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
from .scheduler import get_last_commanded


# ---------------------------------------------------------------------------
# Aux-sensor health tracking — surfaces silent configuration failures
# ---------------------------------------------------------------------------
#
# When a user configures `power_sensor_entity_id`, `indoor_temp_entity_id`,
# or `indoor_humidity_entity_id` and the entity DOESN'T EXIST in HA, the
# reading collector silently records NULL — leaving the user to wonder why
# their thermal model never improves. The health tracker observes each
# aux-sensor read attempt and:
#
#   * Logs a WARNING the first time an entity is missing / invalid
#   * Re-warns every 288 reads (~24 h at 5-min cadence) so the message
#     appears in fresh log views
#   * Maintains a snapshot in `hass.data[DOMAIN][_AUX_HEALTH_KEY]` that
#     the backend can read to drive the panel's sensor-health badge
#
# `_AUX_HEALTH_KEY` shape:
#   {
#     'sensor.foo': {
#       'status': 'ok' | 'entity_missing' | 'invalid_state',
#       'last_value': float | str | None,
#       'consecutive_failures': int,
#       'last_logged_cycle': int,
#       'last_checked': iso8601 str,
#     },
#     ...
#   }

_AUX_HEALTH_KEY = "aux_sensor_health"
_AUX_HEALTH_RELOG_EVERY = 288  # ~24 h at 5-min cycles


def _aux_health(hass: HomeAssistant) -> dict[str, dict[str, Any]]:
    return hass.data.setdefault(DOMAIN, {}).setdefault(_AUX_HEALTH_KEY, {})


def _record_aux_status(
    hass: HomeAssistant,
    entity_id: str,
    *,
    status: str,
    purpose: str,
    last_value: Any = None,
) -> None:
    """Update the aux-sensor health snapshot and log on status changes.

    `purpose` is the human-readable role of the sensor in the message
    ("power", "indoor temperature", "indoor humidity"). Status transitions
    from ok → not-ok log a WARNING; re-warns every ~24 h while still
    broken so users see it in recent logs."""
    health = _aux_health(hass)
    prev = health.get(entity_id) or {}
    prev_status = prev.get("status")
    prev_count = int(prev.get("consecutive_failures") or 0)
    prev_logged_cycle = int(prev.get("last_logged_cycle") or 0)
    cycle = int(prev.get("cycle") or 0) + 1

    if status == "ok":
        health[entity_id] = {
            "status": "ok",
            "last_value": last_value,
            "consecutive_failures": 0,
            "last_logged_cycle": prev_logged_cycle,
            "last_checked": datetime.now(timezone.utc).isoformat(),
            "cycle": cycle,
        }
        if prev_status and prev_status != "ok":
            _LOGGER.info(
                "Hungry Machines: aux sensor '%s' (%s) recovered after %d failures",
                entity_id, purpose, prev_count,
            )
        return

    new_count = prev_count + 1
    relog_due = (cycle - prev_logged_cycle) >= _AUX_HEALTH_RELOG_EVERY
    if prev_status != status or relog_due or prev_count == 0:
        if status == "entity_missing":
            _LOGGER.warning(
                "Hungry Machines: %s sensor '%s' is not present in Home Assistant — "
                "double-check the entity ID in the appliance settings. The "
                "corresponding reading column will be NULL until this is fixed.",
                purpose, entity_id,
            )
        else:
            _LOGGER.warning(
                "Hungry Machines: %s sensor '%s' returned state=%r which isn't a "
                "valid value. Verify the sensor is online and reporting a number.",
                purpose, entity_id, last_value,
            )
        prev_logged_cycle = cycle

    health[entity_id] = {
        "status": status,
        "last_value": last_value,
        "consecutive_failures": new_count,
        "last_logged_cycle": prev_logged_cycle,
        "last_checked": datetime.now(timezone.utc).isoformat(),
        "cycle": cycle,
    }


def get_aux_sensor_health(hass: HomeAssistant) -> dict[str, dict[str, Any]]:
    """Public read of the aux-sensor health snapshot. The HACS `/api/v1/readings`
    POST handler embeds this in the request so the backend can render
    'power sensor missing' badges without separately polling HA state."""
    return dict(_aux_health(hass))

_LOGGER = logging.getLogger(__name__)

_VALID_HVAC_STATES = ("HEAT", "COOL", "OFF", "FAN")


# Mode → canonical recorded state. The mode tells us WHICH variety of
# cooling/heating the user has selected; ECO and DRY are distinct from
# COOL because their compressor duty and target outcomes differ enough
# to warrant separate samples in the model fitter (combined later in
# analysis if useful). See migration 012.
_MODE_TO_STATE: dict[str, str] = {
    "cool": "COOL",
    "eco": "ECO", "eco_cool": "ECO", "ecocool": "ECO", "energy_saver": "ECO",
    "dry": "DRY", "dehumidify": "DRY",
    "heat": "HEAT",
    "fan": "FAN", "fan_only": "FAN", "fan only": "FAN",
    "off": "OFF",
}

# Action → canonical recorded state, used when no mode-specific
# distinction is available (e.g. older entities, single-mode units).
# `hvac_action` is what the unit is DOING right now: `cooling`,
# `heating`, `drying`, `fan`, `idle`, `off`.
_ACTION_TO_STATE: dict[str, str] = {
    "cooling": "COOL",
    "heating": "HEAT", "preheating": "HEAT",
    "drying": "DRY", "dehumidifying": "DRY",
    "fan": "FAN",
    "off": "OFF", "idle": "OFF", "defrosting": "OFF",
}


def _resolve_hvac_state(state: Any) -> str:
    """Map an HA climate entity to one of HEAT/COOL/ECO/DRY/FAN/OFF.

    Combines two HA attributes:
      * `state.state` is the SET mode (cool, heat, heat_cool, auto,
        eco, dry, fan_only, off, …).
      * `state.attributes["hvac_action"]` is what the unit is DOING
        right now (cooling, heating, drying, idle, fan, off).

    Strategy:
      1. If the action is `idle` or `off`, the unit isn't doing anything
         thermal regardless of mode → OFF.
      2. If the mode is a specific sub-mode (eco, dry, etc.) AND the
         action is active (cooling / drying / etc.), record the
         mode-specific state (ECO, DRY) so the fitter can later
         distinguish them.
      3. Otherwise fall back to mapping the action by itself
         (cooling→COOL, heating→HEAT, drying→DRY, fan→FAN).
      4. If no action is exposed, trust the mode alone — recording
         the user's selected sub-mode is better than collapsing all
         compressor activity to plain COOL.

    Anything unrecognized → OFF (conservative).
    """
    action = str(state.attributes.get("hvac_action") or "").strip().lower()
    mode = str(state.state or "").strip().lower()

    # Unit is explicitly idle or off → OFF regardless of selected mode.
    if action in ("off", "idle"):
        return "OFF"

    # If the mode is a sub-cooling type (eco, dry), prefer that label
    # when the action is active. action="cooling" + mode="eco" → ECO,
    # not COOL.
    if mode in ("eco", "eco_cool", "ecocool", "energy_saver") and action in (
        "cooling", "drying", "", "fan"
    ):
        return "ECO"
    if mode in ("dry", "dehumidify") and action in (
        "cooling", "drying", "dehumidifying", "", "fan"
    ):
        return "DRY"

    # heat_cool / auto with an active action: trust the action.
    if action in _ACTION_TO_STATE:
        return _ACTION_TO_STATE[action]

    # No (useful) hvac_action exposed — trust the mode directly.
    if mode in _MODE_TO_STATE:
        return _MODE_TO_STATE[mode]

    return "OFF"
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


def _read_power_watts(
    hass: HomeAssistant, power_sensor_entity_id: str | None
) -> float | None:
    """Read the configured power sensor and coerce to watts.

    Many HA power sensors expose values in W; some (especially smart
    plugs marketed as "kWh meters") expose kW. We sniff the entity's
    `unit_of_measurement` attribute and convert kW → W when needed so
    the server always stores watts. Returns None gracefully when the
    entity is absent, unavailable, or reports a non-numeric state.

    Why this matters: the reconciler treats `power_watts > threshold`
    as authoritative "AC is running" — so unit inconsistency would
    flip the classification for a smart-plug user.
    """
    if not power_sensor_entity_id:
        return None
    s = hass.states.get(power_sensor_entity_id) if hass.states else None
    if s is None:
        _record_aux_status(
            hass, power_sensor_entity_id,
            status="entity_missing", purpose="power",
        )
        return None
    raw = getattr(s, "state", None)
    value = _coerce_float(raw)
    if value is None:
        _record_aux_status(
            hass, power_sensor_entity_id,
            status="invalid_state", purpose="power", last_value=raw,
        )
        return None
    unit = ""
    attrs = getattr(s, "attributes", None) or {}
    if isinstance(attrs, dict):
        unit = str(attrs.get("unit_of_measurement") or "").strip().lower()
    # Common HA units: "W", "kW", "watt", "kilowatt". Convert kW → W;
    # everything else is treated as W (the universal default).
    if unit in ("kw", "kilowatt", "kilowatts"):
        value = value * 1000.0
    _record_aux_status(
        hass, power_sensor_entity_id,
        status="ok", purpose="power", last_value=value,
    )
    return value


def _read_indoor_humidity(
    hass: HomeAssistant,
    climate_state: Any,
    indoor_humidity_entity_id: str | None,
) -> float | None:
    """Resolve indoor humidity from either the climate entity attribute
    or the user-configured fallback sensor.

    Many Tuya / Smart Life / IR-blaster climate entities don't expose
    `current_humidity` at all. Without a fallback path the reading row's
    `indoor_humidity` column ends up 100% NULL, and the model fitter
    has no signal for latent-heat load. When the user wires up any
    `sensor.*` exposing humidity (Third Reality, Aqara, SwitchBot,
    even most Zigbee plant sensors), we read it here.

    Returns None when neither source produces a usable value (the
    reading row's column stays NULL). Updates the aux-health snapshot
    so the panel surfaces a misconfigured entity ID.
    """
    raw = climate_state.attributes.get("current_humidity")
    value = _coerce_float(raw)
    if value is not None:
        return value
    if not indoor_humidity_entity_id:
        return None
    s = hass.states.get(indoor_humidity_entity_id) if hass.states else None
    if s is None:
        _record_aux_status(
            hass, indoor_humidity_entity_id,
            status="entity_missing", purpose="indoor humidity",
        )
        return None
    fallback_raw = getattr(s, "state", None)
    fallback_value = _coerce_float(fallback_raw)
    if fallback_value is None:
        _record_aux_status(
            hass, indoor_humidity_entity_id,
            status="invalid_state", purpose="indoor humidity",
            last_value=fallback_raw,
        )
        return None
    _record_aux_status(
        hass, indoor_humidity_entity_id,
        status="ok", purpose="indoor humidity", last_value=fallback_value,
    )
    return fallback_value


def _build_hvac_home_reading(
    hass: HomeAssistant,
    state: Any,
    indoor_temp_entity_id: str | None = None,
    power_sensor_entity_id: str | None = None,
    indoor_humidity_entity_id: str | None = None,
    appliance_id: str | None = None,
) -> dict | None:
    """Build the /api/v1/readings payload from the HVAC climate entity.

    Indoor temperature resolution:
      1. The climate entity's `current_temperature` attribute (the
         universal HA convention).
      2. Fallback: `indoor_temp_entity_id` from the appliance config.
         Used when the climate entity declares the attribute but
         reports it as None — common with Tuya/Smart Life thermostat
         wrappers, IR-blaster AC controllers, and Generic Thermostat
         helpers, which don't have an embedded thermistor and expect
         the user to wire in a separate sensor.

    Power resolution:
      * If `power_sensor_entity_id` is set on the appliance config,
        the integration reads from there and includes `power_watts`.
        Source can be a built-in meter, a smart plug, or any sensor
        exposing watts (or kW — auto-converted).
      * When no power sensor is configured, `power_watts` is omitted.
        Legacy fallback to any climate-entity power attribute would
        risk reading the wrong number for users who haven't opted in.

    Returns None (no reading appended) when neither indoor source
    produces a usable value, with a single INFO log explaining why.
    """
    indoor_temp = state.attributes.get("current_temperature")
    if indoor_temp is None and indoor_temp_entity_id:
        fallback_state = hass.states.get(indoor_temp_entity_id) if hass.states else None
        if fallback_state is not None:
            raw = getattr(fallback_state, "state", None)
            indoor_temp = _coerce_float(raw)
            if indoor_temp is None:
                _record_aux_status(
                    hass, indoor_temp_entity_id,
                    status="invalid_state",
                    purpose="indoor temperature",
                    last_value=raw,
                )
            else:
                _record_aux_status(
                    hass, indoor_temp_entity_id,
                    status="ok",
                    purpose="indoor temperature",
                    last_value=indoor_temp,
                )
        else:
            _record_aux_status(
                hass, indoor_temp_entity_id,
                status="entity_missing",
                purpose="indoor temperature",
            )
    if indoor_temp is None:
        _LOGGER.info(
            "Hungry Machines: HVAC entity '%s' reports current_temperature=None "
            "and no indoor_temp_entity_id is configured "
            "(climate-entity attrs=%s, state=%s); home reading skipped. "
            "Configure an indoor temperature sensor in the appliance settings "
            "to capture readings from this thermostat.",
            state.entity_id,
            sorted(state.attributes.keys()) if state.attributes else [],
            state.state,
        )
        return None
    reading: dict[str, Any] = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "indoor_temp": indoor_temp,
        "hvac_state": _resolve_hvac_state(state),
    }
    # Tag each reading with its HVAC appliance so the backend's
    # per-appliance sensor stream (migration 025 / US-MHVAC-006) routes
    # to the right thermal model. Older HACS clients (or pre-multi-HVAC
    # appliances missing an id) omit this and the backend stores NULL.
    if appliance_id:
        reading["appliance_id"] = appliance_id
    target_temp = state.attributes.get("temperature")
    if target_temp is not None:
        reading["target_temp"] = target_temp
    indoor_humidity = _read_indoor_humidity(
        hass, state, indoor_humidity_entity_id,
    )
    if indoor_humidity is not None:
        reading["indoor_humidity"] = indoor_humidity
    # Fan speed string ("low", "medium", "high", "auto", etc.). Per-
    # manufacturer string; recorded verbatim so the analyst can group by
    # observed values. NULL if the entity doesn't expose it.
    fan_mode = state.attributes.get("fan_mode")
    if fan_mode is not None:
        reading["fan_mode"] = str(fan_mode)

    # Ground-truth signal — what the scheduler last commanded for this
    # entity. The reconciler uses commanded values to detect when the
    # climate entity reports stale or default state (a common Tuya /
    # mini-split quirk). Skipped silently if the scheduler hasn't
    # applied a slot yet (fresh HA start, never-driven entity).
    commanded = get_last_commanded(hass, state.entity_id)
    if commanded is not None:
        if commanded.get("hvac_mode") is not None:
            reading["commanded_hvac_mode"] = commanded["hvac_mode"]
        if commanded.get("fan_mode") is not None:
            reading["commanded_fan_mode"] = commanded["fan_mode"]
        if commanded.get("setpoint") is not None:
            reading["commanded_setpoint"] = commanded["setpoint"]
    # Physics-grounded signal — what the AC is actually drawing in
    # watts. Only included when the user has wired up a power sensor
    # (built-in meter or smart plug). Treated by the reconciler as
    # authoritative for "is the unit running" regardless of what the
    # climate entity claims about hvac_state / fan_mode.
    power_watts = _read_power_watts(hass, power_sensor_entity_id)
    if power_watts is not None:
        reading["power_watts"] = power_watts
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
            indoor_temp_entity_id = (
                config.get("indoor_temp_entity_id")
                if isinstance(config, dict) else None
            )
            power_sensor_entity_id = (
                config.get("power_sensor_entity_id")
                if isinstance(config, dict) else None
            )
            indoor_humidity_entity_id = (
                config.get("indoor_humidity_entity_id")
                if isinstance(config, dict) else None
            )
            reading = _build_hvac_home_reading(
                hass, control_state,
                indoor_temp_entity_id,
                power_sensor_entity_id,
                indoor_humidity_entity_id,
                appliance_id=aid if isinstance(aid, str) else None,
            )
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
