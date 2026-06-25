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

from homeassistant.util import dt as dt_util
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.event import async_call_later

from . import api
from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

_SLOTS_PER_DAY = 48


def _domain_data(hass: HomeAssistant) -> dict[str, Any]:
    return hass.data.setdefault(DOMAIN, {})


_LAST_COMMANDED_KEY = "last_commanded"


def _record_last_commanded(
    hass: HomeAssistant,
    entity_id: str,
    *,
    hvac_mode: str | None,
    fan_mode: str | None,
    setpoint: float | None,
) -> None:
    """Cache what the scheduler just told this climate entity to do.

    The cache is keyed by entity_id and overwritten on every slot
    apply. `readings.py` reads from it to attach `commanded_*` fields
    to each 5-min sensor reading, giving the backend reconciler a
    ground-truth signal for what the AC was supposed to be doing —
    distinct from what the climate entity reports back (which can be
    stale or wrong on Tuya / mini-split units).

    Values are stored verbatim from the schedule, including SENTINELS
    like fan_mode='auto'/'off' which mean "we did not actively command
    a fan tier this slot" — the reconciler treats those distinctly
    from "we commanded low/med/high."
    """
    cache = _domain_data(hass).setdefault(_LAST_COMMANDED_KEY, {})
    cache[entity_id] = {
        "hvac_mode": hvac_mode,
        "fan_mode": fan_mode,
        "setpoint": setpoint,
    }


def get_last_commanded(
    hass: HomeAssistant, entity_id: str
) -> dict[str, Any] | None:
    """Read the latest commanded values for `entity_id`, or None.

    Returns None before the first slot apply or for entities that have
    never been driven by the scheduler. `readings.py` calls this once
    per cycle and omits the `commanded_*` fields when None — the
    server-side reconciler treats missing fields as "no signal" and
    falls back to entity-reported state."""
    cache = _domain_data(hass).get(_LAST_COMMANDED_KEY) or {}
    entry = cache.get(entity_id)
    if not isinstance(entry, dict):
        return None
    return dict(entry)


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
        # Master pause switch from the panel toggle. Missing key (older
        # API) defaults to enabled so an API lag never bricks control.
        "optimization_enabled": bool(body.get("optimization_enabled", True)),
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
            # Per-appliance pause flag (US-MHVAC-010). Missing key on
            # older APIs defaults to enabled so a stale backend never
            # bricks control. The slot-apply loop ANDs this with the
            # top-level master flag.
            "optimization_enabled": bool(
                entry_data.get("optimization_enabled", True)
            ),
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
    """Map the current wall-clock time to a 0..47 schedule slot.

    Uses Home Assistant's CONFIGURED LOCAL TIME (`dt_util.now()`), not
    the host process's local time. This matters because:
      * Most HA deployments run their Python process in UTC (Docker
        default, k8s default), so `datetime.now()` returns UTC.
      * The backend's pricing arrays are LOCAL-TIME-keyed — slot 0 =
        midnight LOCAL, slot 32 = 4pm LOCAL, etc.
      * `async_track_time_change` fires the apply callback at HA's
        local-time `minute=[0, 30]` boundaries.
    Combining those, slot computation must also be done in HA's
    configured local time. Otherwise the integration applies the
    schedule on a UTC-offset grid, sending the slot meant for 1 PM
    at 9 AM (for an EDT user, 4-hour shift).

    Callers may pass `now` explicitly for testing; production paths
    always default to `dt_util.now()`.
    """
    now = now or dt_util.now()
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
    assumed_mode: str | None = None,
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

    `assumed_mode` overrides the entity's REPORTED mode for the
    payload-shape decision. Pass the canonical mode the scheduler just
    commanded via `climate.set_hvac_mode`: cloud-bridged units (Tuya /
    Smart Life) take seconds to reflect a mode change in `hass.states`,
    so reading back "off" right after commanding "cool" made the
    OFF→COOL transition skip BOTH set_temperature and set_fan_mode —
    the unit resumed cooling at whatever stale setpoint/fan it
    remembered (the June 10 calibration phase-3 incident: AC came back
    at cool/low/80°F instead of cool/high/68°F).
    """
    if state is None:
        _LOGGER.info(
            "Hungry Machines HVAC: entity %s not found, skipping", entity_id
        )
        return None
    raw_state = getattr(state, "state", None) or ""
    hvac_mode = (
        assumed_mode.strip().lower() if assumed_mode else str(raw_state).lower()
    )
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


def _resolve_canonical(schedule: dict, key: str, slot: int) -> str | None:
    """Pull a canonical-string per-slot value (`fan_mode_schedule` or
    `hvac_mode_schedule`) from the schedule.

    The presence of the key in the JSONB is itself the user opt-in
    signal: the backend only writes these arrays when the user has
    enabled the corresponding optimizer toggle in their preferences.
    Returns None when the key is missing entirely (= temperature-only
    mode), when the slot index is out of range, or when the entry
    isn't a non-empty string.
    """
    arr = schedule.get(key)
    if not isinstance(arr, list) or slot >= len(arr):
        return None
    val = arr[slot]
    if not isinstance(val, str) or not val.strip():
        return None
    return val.strip()


def _match_entity_option(
    canonical: str,
    available: list[str] | None,
) -> str | None:
    """Map a canonical optimizer string (e.g. 'high', 'COOL') to the
    actual label the user's climate entity exposes.

    HA climate entities advertise their accepted vocabulary via the
    `fan_modes` and `hvac_modes` attributes. The labels vary by brand:
    a window AC might offer `["Low", "Medium", "High", "Auto"]`; a
    central thermostat might offer `["Auto Low", "Circulation",
    "Turbo"]`. We do a case-insensitive substring match — first
    canonical-in-option (e.g. 'high' matches 'High Speed'), then
    option-in-canonical as a fallback (e.g. 'Auto Low' matches 'low').

    Returns the matched entity-side label verbatim, or None when no
    plausible match exists. The caller skips the service call rather
    than send a value the entity will reject.
    """
    if not available or not canonical:
        return None
    needle = canonical.strip().lower()
    if not needle:
        return None
    options = [o for o in available if isinstance(o, str)]
    # Exact match wins.
    for opt in options:
        if opt.strip().lower() == needle:
            return opt
    # Canonical inside option (e.g. 'high' matches 'High Speed').
    for opt in options:
        if needle in opt.strip().lower():
            return opt
    # Option inside canonical (e.g. entity offers 'Auto Low' for our
    # 'auto low' or 'low' canonical).
    for opt in options:
        if opt.strip().lower() in needle:
            return opt
    return None


# Comfort-band failsafe margin. The override only fires once the live
# indoor temperature is this far past the band edge — small enough to
# matter for comfort, large enough that sensor noise and thermostat
# deadband wobble don't flap the unit on and off across slot applies.
_COMFORT_OVERRIDE_MARGIN_F = 1.0


def _comfort_band_override(
    hass: HomeAssistant,
    entity_id: str,
    schedule: dict,
    slot: int,
    mode_canonical: str | None,
) -> tuple[str, float] | None:
    """Decide whether a scheduled-OFF slot must be overridden because
    the house has drifted outside the comfort band.

    Returns `(override_mode, override_setpoint)` — e.g. `("COOL", 75.0)`
    — or None when the schedule should apply as-is.

    The backend schedule is OPEN-LOOP: computed during the night from a
    predicted temperature trajectory. When reality diverges from the
    prediction (immature model, passive calibration evening, hotter
    weather than forecast), the integration is the only component that
    sees the live indoor temperature, so the failsafe lives here. The
    June 11 incident is the motivating case: the house was 80°F at 8am
    while the schedule — whose trajectory predicted in-band — kept
    commanding OFF.

    Deliberately narrow:
      * Only fires when the slot EXPLICITLY commands OFF. Temperature-
        only users (no `hvac_mode_schedule`) keep their thermostat's
        own closed-loop behavior — nothing to fail safe over.
      * Never fires inside an active calibration phase — the OFF phases
        there ARE the measurement; the backend aborts the run via its
        own comfort cap (+2°F) when drift goes too far. Pre/post-window
        slots on a calibration day have `phase_at_slot=None` and DO get
        the failsafe, which fixes the passive-evening overheat.
      * Direction is gated by the schedule's mode: `cool` → COOL on a
        high-band breach, `heat` → HEAT on a low-band breach, `auto`
        → either. No mode → no override.
      * The override setpoint is the BAND EDGE, not the optimizer's
        slot value — pull the house back into band, then resume the
        plan at the next slot boundary.
    """
    if mode_canonical is None or mode_canonical.strip().lower() != "off":
        return None

    cal = schedule.get("calibration")
    if isinstance(cal, dict):
        phase_at_slot = cal.get("phase_at_slot")
        if (
            isinstance(phase_at_slot, list)
            and slot < len(phase_at_slot)
            and phase_at_slot[slot] is not None
        ):
            return None

    state = hass.states.get(entity_id) if hass.states else None
    attrs = getattr(state, "attributes", None) or {} if state else {}
    try:
        indoor = float(attrs.get("current_temperature"))
    except (TypeError, ValueError):
        return None

    sched_mode = str(schedule.get("mode") or "").strip().lower()

    def _band_edge(key: str) -> float | None:
        arr = schedule.get(key)
        if not isinstance(arr, list) or slot >= len(arr):
            return None
        try:
            return float(arr[slot])
        except (TypeError, ValueError):
            return None

    high = _band_edge("high_temps")
    if (
        high is not None
        and sched_mode in ("cool", "auto")
        and indoor > high + _COMFORT_OVERRIDE_MARGIN_F
    ):
        _LOGGER.warning(
            "Hungry Machines comfort override slot=%d: %s indoor %.1f°F is "
            "above high band %.1f°F (+%.1f°F margin) while scheduled OFF — "
            "commanding COOL at %.1f°F",
            slot, entity_id, indoor, high, _COMFORT_OVERRIDE_MARGIN_F, high,
        )
        return ("COOL", high)

    low = _band_edge("low_temps")
    if (
        low is not None
        and sched_mode in ("heat", "auto")
        and indoor < low - _COMFORT_OVERRIDE_MARGIN_F
    ):
        _LOGGER.warning(
            "Hungry Machines comfort override slot=%d: %s indoor %.1f°F is "
            "below low band %.1f°F (-%.1f°F margin) while scheduled OFF — "
            "commanding HEAT at %.1f°F",
            slot, entity_id, indoor, low, _COMFORT_OVERRIDE_MARGIN_F, low,
        )
        return ("HEAT", low)

    return None


async def _apply_hvac(
    hass: HomeAssistant,
    entity_id: str,
    schedule: dict,
    slot: int,
    appliance_name: str | None = None,
) -> None:
    setpoint = _resolve_setpoint(schedule, slot)
    mode_canonical = _resolve_canonical(schedule, "hvac_mode_schedule", slot)
    fan_canonical = _resolve_canonical(schedule, "fan_mode_schedule", slot)

    # Wake a unit that reports `off` under a TEMPERATURE-ONLY schedule.
    # Those schedules carry no hvac_mode_schedule — they assume the
    # unit sits in its base mode and the integration just moves the
    # setpoint. But `_build_hvac_payload` skips off-mode entities, so a
    # unit left OFF (post-calibration passive evening, power blip, a
    # manual flip) stayed off FOREVER while the plan assumed cooling.
    # Now that the panel's optimization toggle exists, "leave my AC
    # alone" has a legitimate path — so while optimization is enabled
    # the integration is authoritative and wakes the unit into the
    # schedule's base mode. Mode-optimized schedules are untouched:
    # their per-slot mode commands already handle OFF→COOL.
    if mode_canonical is None:
        state_now = hass.states.get(entity_id) if hass.states else None
        raw_now = str(getattr(state_now, "state", "") or "").strip().lower() if state_now else ""
        sched_mode = str(schedule.get("mode") or "").strip().lower()
        if raw_now == "off" and sched_mode in ("cool", "heat"):
            mode_canonical = sched_mode.upper()
            _LOGGER.warning(
                "Hungry Machines HVAC wake slot=%d: %s reports 'off' under a "
                "temperature-only schedule — commanding %s so the optimized "
                "plan can run (pause optimization in the panel to keep the "
                "unit off)",
                slot, entity_id, mode_canonical,
            )

    # Closed-loop comfort failsafe: replace a scheduled OFF with an
    # active mode + band-edge setpoint when the live indoor temperature
    # has drifted out of band. Runs BEFORE _record_last_commanded so
    # the readings collector and the set-then-verify pass both treat
    # the override as the commanded truth for this slot.
    override = _comfort_band_override(
        hass, entity_id, schedule, slot, mode_canonical,
    )
    if override is not None:
        mode_canonical, setpoint = override

    # Record the schedule's intent for this slot BEFORE any service
    # calls so the readings collector has a consistent ground-truth
    # snapshot of what the AC is supposed to be doing — including for
    # OFF slots (where _build_hvac_payload returns None and we
    # short-circuit) and for failed apply attempts. The reconciler
    # uses this to detect Tuya-style "AC ignoring commands" without
    # depending on the entity's self-report.
    _record_last_commanded(
        hass, entity_id,
        hvac_mode=mode_canonical,
        fan_mode=fan_canonical,
        setpoint=float(setpoint) if setpoint is not None else None,
    )

    if setpoint is None:
        _LOGGER.warning(
            "Hungry Machines HVAC slot %s: no setpoint available for %s",
            slot,
            entity_id,
        )
        return

    state = hass.states.get(entity_id) if hass.states else None
    attrs = getattr(state, "attributes", None) or {} if state else {}

    # Phase D — HVAC mode change. Sequence matters: switch the mode
    # FIRST so the temperature command applies to the new mode. Skip
    # silently when the schedule didn't include a mode (= user opted
    # out) or when the requested mode isn't in the entity's
    # `hvac_modes` list (= incompatible unit).
    if mode_canonical is not None:
        await _maybe_set_hvac_mode(hass, entity_id, attrs, mode_canonical, slot)
        # Re-read state after a mode change so the payload builder sees
        # fresh attributes (fan vocabulary etc.). NOTE: the MODE in this
        # re-read can be stale — cloud-bridged units (Tuya) take seconds
        # to reflect set_hvac_mode in hass.states. That's why the
        # payload builder below receives `assumed_mode=mode_canonical`
        # instead of trusting the reported state: reading back "off"
        # right after commanding "cool" used to skip the setpoint AND
        # fan calls, so the unit resumed at its stale remembered
        # settings (June 10 calibration phase-3: cool/low/80 instead
        # of cool/high/68).
        state = hass.states.get(entity_id) if hass.states else state
        attrs = getattr(state, "attributes", None) or {} if state else {}

    payload = _build_hvac_payload(
        entity_id, state, setpoint, assumed_mode=mode_canonical,
    )
    if payload is None:
        return

    raw_state = getattr(state, "state", None) or "unknown" if state else "missing"

    # Phase C — fan-mode change. Issued in parallel with the
    # temperature setpoint; fan and temperature are independent service
    # calls on the climate domain. Same opt-in / vocabulary-match
    # discipline as the mode change above.
    #
    # `"auto"` and `"off"` in `fan_mode_schedule` are SENTINELS — the
    # backend writes them for OFF slots and for cases where the
    # optimizer has no opinion on fan speed. They explicitly mean
    # "leave the unit's fan_mode alone", NOT "actively switch to Auto".
    # Some climate entities (notably Tuya/Smart-Life and several mini-
    # splits) treat fan_mode=Auto as a request to enter Eco / Auto-
    # compressor mode, which then overrides the temperature setpoint.
    # The integration must NOT issue set_fan_mode for these sentinels.
    fan_label: str | None = None
    if fan_canonical is not None:
        canonical_lower = fan_canonical.strip().lower()
        if canonical_lower in ("auto", "off"):
            # Sentinel: skip fan call so the unit's idle behavior
            # is whatever the user / unit decided previously.
            fan_label = None
        else:
            fan_label = _match_entity_option(
                fan_canonical, attrs.get("fan_modes"),
            )

    # Include HA-local wall-clock time in the log message body so the
    # user can correlate a slot number with their clock — HA's log
    # formatter timestamps using the host process's TZ (often UTC),
    # which won't match the local-time grid the slot represents.
    local_now = dt_util.now()
    local_label = local_now.strftime("%H:%M %Z")
    _LOGGER.info(
        "Hungry Machines HVAC apply: appliance=%s entity=%s slot=%d (%s local) "
        "mode=%s setpoint=%.1f%s%s payload=%s",
        appliance_name or "(unnamed)",
        entity_id,
        slot,
        local_label,
        raw_state,
        setpoint,
        f" fan={fan_label}" if fan_label else "",
        f" hvac_mode_canonical={mode_canonical}" if mode_canonical else "",
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

    if fan_label is not None:
        try:
            await hass.services.async_call(
                "climate",
                "set_fan_mode",
                {"entity_id": entity_id, "fan_mode": fan_label},
                blocking=False,
            )
        except Exception as err:  # noqa: BLE001
            _LOGGER.warning(
                "Hungry Machines HVAC fan apply failed for %s: %s", entity_id, err
            )

    # Set-then-verify: schedule a one-shot check a few minutes out.
    # Cloud-bridged units (Tuya / Smart Life) drop or delay commands
    # often enough that fire-and-forget isn't reliable — the June 10
    # calibration phase-3 incident resumed at stale settings because
    # nothing ever checked whether the commanded values stuck. The
    # verifier re-reads the entity and re-sends anything that didn't
    # take. ONE retry per slot apply — a user's manual override gets
    # reverted at most once per half-hour and is then respected until
    # the next slot boundary.
    _schedule_apply_verification(
        hass,
        entity_id=entity_id,
        expected_mode=mode_canonical,
        expected_setpoint=payload.get("temperature") or payload.get("target_temp_high"),
        expected_fan=fan_label,
        slot=slot,
    )


_VERIFY_DELAY_SECONDS = 60  # 1 min — Tuya cloud roundtrips settle within this
_SETPOINT_TOLERANCE_F = 1.0  # integer-rounding units + °C roundtrips drift ~0.5 °F


def _schedule_apply_verification(
    hass: HomeAssistant,
    *,
    entity_id: str,
    expected_mode: str | None,
    expected_setpoint: float | None,
    expected_fan: str | None,
    slot: int,
) -> None:
    """Arm a one-shot verification for a just-applied slot.

    Wrapped in try/except because `async_call_later` isn't available
    in every test harness — verification is an enhancement, not a
    dependency of the apply itself."""

    async def _verify(_now) -> None:
        await _verify_hvac_apply(
            hass,
            entity_id=entity_id,
            expected_mode=expected_mode,
            expected_setpoint=expected_setpoint,
            expected_fan=expected_fan,
            slot=slot,
        )

    try:
        async_call_later(hass, _VERIFY_DELAY_SECONDS, _verify)
    except Exception as err:  # noqa: BLE001
        _LOGGER.debug("verification scheduling unavailable: %s", err)


async def _verify_hvac_apply(
    hass: HomeAssistant,
    *,
    entity_id: str,
    expected_mode: str | None,
    expected_setpoint: float | None,
    expected_fan: str | None,
    slot: int,
) -> None:
    """Re-read the entity ~2.5 min after an apply and re-send anything
    that didn't stick. One retry, no re-verification — persistent
    disobedience surfaces through the divergence report instead of an
    infinite command loop fighting the unit (or the user)."""
    state = hass.states.get(entity_id) if hass.states else None
    if state is None:
        return
    attrs = getattr(state, "attributes", None) or {}
    reported_mode = str(getattr(state, "state", "") or "").strip().lower()

    fixes: list[str] = []

    if expected_mode is not None:
        want_mode = expected_mode.strip().lower()
        # ECO/DRY map to cool on the apply side; accept either.
        if want_mode in ("eco", "dry"):
            want_mode = "cool"
        if want_mode != reported_mode:
            fixes.append(f"mode {reported_mode!r}→{want_mode!r}")
            try:
                await hass.services.async_call(
                    "climate", "set_hvac_mode",
                    {"entity_id": entity_id, "hvac_mode": want_mode},
                    blocking=False,
                )
            except Exception as err:  # noqa: BLE001
                _LOGGER.warning("verify re-send mode failed for %s: %s", entity_id, err)

    # Setpoint / fan only meaningful when the unit should be actively
    # heating or cooling — skip both when we commanded OFF.
    actively_on = expected_mode is None or expected_mode.strip().lower() not in ("off",)
    if actively_on and expected_setpoint is not None:
        reported_setpoint = attrs.get("temperature")
        try:
            reported_f = float(reported_setpoint) if reported_setpoint is not None else None
        except (TypeError, ValueError):
            reported_f = None
        if reported_f is None or abs(reported_f - float(expected_setpoint)) > _SETPOINT_TOLERANCE_F:
            fixes.append(f"setpoint {reported_f!r}→{expected_setpoint}")
            try:
                await hass.services.async_call(
                    "climate", "set_temperature",
                    {"entity_id": entity_id, "temperature": float(expected_setpoint)},
                    blocking=False,
                )
            except Exception as err:  # noqa: BLE001
                _LOGGER.warning("verify re-send setpoint failed for %s: %s", entity_id, err)

    if actively_on and expected_fan is not None:
        reported_fan = str(attrs.get("fan_mode") or "").strip().lower()
        if reported_fan != expected_fan.strip().lower():
            fixes.append(f"fan {reported_fan!r}→{expected_fan!r}")
            try:
                await hass.services.async_call(
                    "climate", "set_fan_mode",
                    {"entity_id": entity_id, "fan_mode": expected_fan},
                    blocking=False,
                )
            except Exception as err:  # noqa: BLE001
                _LOGGER.warning("verify re-send fan failed for %s: %s", entity_id, err)

    if fixes:
        _LOGGER.warning(
            "Hungry Machines HVAC verify slot=%d: %s did not hold commanded "
            "values — re-sent: %s",
            slot, entity_id, "; ".join(fixes),
        )


async def _maybe_set_hvac_mode(
    hass: HomeAssistant,
    entity_id: str,
    attrs: dict,
    canonical: str,
    slot: int,
) -> None:
    """Issue `climate.set_hvac_mode` if the entity supports the
    canonical mode AND it differs from the entity's current mode.

    Canonical values from the optimizer are the HA-universal HVAC
    modes — `COOL`, `HEAT`, `OFF` — which every climate entity
    supports. ECO/DRY were considered but dropped: HA exposes those
    as `preset_mode` not `hvac_mode`, and preset support varies too
    much across vendors to recommend universally. Defensive ECO/DRY
    fallback below catches old cached schedules from a prior version
    of the backend that may still contain those values; they're
    mapped to the closest hvac_mode equivalent so a stale cache
    doesn't crash an apply.
    """
    available = attrs.get("hvac_modes") or []
    if not isinstance(available, list):
        return
    needle = canonical.strip().lower()

    # Defensive: ECO/DRY only show up here if a stale schedule from
    # an older backend version is still cached. Map both to plain
    # cool so the apply still lands; once the user's backend writes
    # a fresh schedule those values won't appear at all.
    if needle in ("eco", "dry"):
        target = "cool"
    elif needle in ("cool", "heat", "off", "fan_only"):
        target = needle
    else:
        return

    matched = _match_entity_option(target, [str(m) for m in available])
    if matched is None:
        _LOGGER.info(
            "Hungry Machines HVAC mode skip slot=%d: entity %s does not "
            "advertise mode '%s' (available=%s)",
            slot,
            entity_id,
            target,
            available,
        )
        return

    # No-op if already in that mode.
    state = hass.states.get(entity_id) if hass.states else None
    if state is not None:
        current = str(getattr(state, "state", "")).strip().lower()
        if current == matched.strip().lower():
            return

    try:
        await hass.services.async_call(
            "climate",
            "set_hvac_mode",
            {"entity_id": entity_id, "hvac_mode": matched},
            blocking=False,
        )
    except Exception as err:  # noqa: BLE001
        _LOGGER.warning(
            "Hungry Machines HVAC mode apply failed for %s: %s",
            entity_id,
            err,
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

    # Master pause: the user toggled optimization off in the panel.
    # Skip ALL schedule application — no setpoints, no mode/fan
    # commands, no comfort failsafe — until a later poll says enabled.
    # The 5-min cache TTL means flipping the toggle takes effect at
    # the next half-hour boundary.
    if cache.get("optimization_enabled") is False:
        _LOGGER.info(
            "Hungry Machines: optimization is paused (panel toggle); "
            "skipping schedule apply"
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
        name = info.get("name")
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
        # Per-appliance pause: when this appliance's optimization is
        # disabled (US-MHVAC-010), skip its apply entirely so the user
        # can pause one HVAC while another keeps running. The master
        # `optimization_enabled` flag above already short-circuited the
        # whole apply when globally paused.
        if info.get("optimization_enabled") is False:
            _LOGGER.info(
                "Hungry Machines apply: appliance %s (%s) is paused; "
                "skipping apply",
                name or aid,
                atype,
            )
            continue
        if atype == "hvac":
            await _apply_hvac(
                hass, entity_id, schedule, slot, appliance_name=name,
            )
        elif atype in ("ev_charger", "home_battery", "water_heater"):
            await _apply_switch(hass, entity_id, schedule, slot)
        else:
            _LOGGER.info(
                "Hungry Machines apply: unknown appliance_type=%s for %s; skipping",
                atype,
                aid,
            )
