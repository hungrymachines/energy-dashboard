"""Tests for custom_components.hungry_machines.scheduler (v2.0)."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch
from zoneinfo import ZoneInfo

import pytest

from hungry_machines import scheduler
from hungry_machines.const import DOMAIN


def _fresh_ts() -> str:
    """ISO8601 timestamp recent enough that the cache won't be flagged
    as stale by `_cache_age_seconds` / `_CACHE_MAX_AGE_SECONDS`."""
    return datetime.now(timezone.utc).isoformat()


def _hass(climate_state: object | None = None) -> MagicMock:
    hass = MagicMock()
    hass.data = {}
    hass.services = MagicMock()
    hass.services.async_call = AsyncMock()
    hass.states = MagicMock()
    hass.states.get = MagicMock(return_value=climate_state)
    return hass


def _climate_state(
    mode: str,
    supports_range: bool = True,
    min_temp: float | None = None,
    max_temp: float | None = None,
    fan_modes: list[str] | None = None,
    hvac_modes: list[str] | None = None,
) -> MagicMock:
    """Build a hass.states.get(...) return value matching a climate entity.

    `supports_range` toggles the TARGET_TEMPERATURE_RANGE bit on
    `supported_features`. The state value is the HVAC mode string.
    Optional min_temp/max_temp simulate a real AC's hardware limits
    (e.g. window units typically report 64..86 °F).
    Optional fan_modes / hvac_modes lists simulate the entity's
    advertised vocabulary so Phase C/D apply paths can vocab-match.
    """
    state = MagicMock()
    state.state = mode
    attrs: dict = {"supported_features": 2 if supports_range else 1}
    if min_temp is not None:
        attrs["min_temp"] = min_temp
    if max_temp is not None:
        attrs["max_temp"] = max_temp
    if fan_modes is not None:
        attrs["fan_modes"] = fan_modes
    if hvac_modes is not None:
        attrs["hvac_modes"] = hvac_modes
    state.attributes = attrs
    return state


def _entry() -> MagicMock:
    entry = MagicMock()
    entry.entry_id = "abc"
    entry.data = {}
    entry.options = {}
    entry.async_start_reauth = MagicMock()
    return entry


def _schedules_body() -> dict:
    """Build a /api/v1/schedules body with two appliances + entity_ids."""
    return {
        "date": "2026-05-07",
        "appliances": [
            {
                "appliance_id": "hvac-1",
                "appliance_type": "hvac",
                "name": "AC",
                "schedule": {
                    "intervals": list(range(48)),
                    "high_temps": [74.0] * 48,
                    "low_temps": [70.0] * 48,
                    "mode": "cool",
                },
                "savings_pct": 18.5,
                "source": "optimization",
                "entities": {"entity_id": "climate.living_room"},
            },
            {
                "appliance_id": "ev-1",
                "appliance_type": "ev_charger",
                "name": "EV",
                "schedule": {
                    "intervals": [False, False, True, True] + [False] * 44,
                    "value_trajectory": [50.0] * 48,
                    "unit": "percent",
                },
                "savings_pct": 32.1,
                "source": "optimization",
                "entities": {"entity_id": "switch.tesla_charger"},
            },
        ],
    }


@pytest.mark.asyncio
async def test_fetch_caches_per_appliance_with_entity_id() -> None:
    hass = _hass()
    entry = _entry()
    with patch.object(
        scheduler.api, "get_schedules", AsyncMock(return_value=_schedules_body())
    ):
        cache = await scheduler.fetch_today_schedule(hass, entry)

    assert cache is not None
    assert "hvac-1" in cache and "ev-1" in cache
    hvac = cache["hvac-1"]
    assert hvac["appliance_type"] == "hvac"
    assert hvac["entity_id"] == "climate.living_room"
    assert len(hvac["schedule"]["high_temps"]) == 48
    ev = cache["ev-1"]
    assert ev["entity_id"] == "switch.tesla_charger"
    assert ev["schedule"]["intervals"][2] is True


@pytest.mark.asyncio
async def test_fetch_publishes_schedule_states_for_dev_tools() -> None:
    """Each appliance gets a `sensor.hungry_machines_<slug>_schedule`
    state with the full schedule in attributes, so users can see the
    full 48-slot plan in HA Dev Tools → States."""
    hass = _hass()
    entry = _entry()
    with patch.object(
        scheduler.api, "get_schedules", AsyncMock(return_value=_schedules_body())
    ):
        await scheduler.fetch_today_schedule(hass, entry)

    calls = hass.states.async_set.call_args_list
    # One state per appliance.
    entity_ids = [call.args[0] for call in calls]
    assert any(e.startswith("sensor.hungry_machines_") and e.endswith("_schedule") for e in entity_ids)
    # Find the HVAC one and assert its attributes carry the 48-slot arrays.
    hvac_call = next(
        c for c in calls if c.args[2].get("appliance_id") == "hvac-1"
    )
    attrs = hvac_call.args[2]
    assert attrs["appliance_type"] == "hvac"
    assert attrs["target_entity"] == "climate.living_room"
    assert attrs["mode"] == "cool"
    assert len(attrs["high_temps"]) == 48
    assert len(attrs["low_temps"]) == 48
    assert "current_slot" in attrs


def _hvac_cache(
    entity_id: str = "climate.living_room",
    setpoint: float = 71.5,
    include_setpoints: bool = True,
    fan_mode_schedule: list[str] | None = None,
    hvac_mode_schedule: list[str] | None = None,
) -> dict:
    """Build a cached schedule for one HVAC appliance.

    `setpoint` is the value at slot 28 (where each apply test reads).
    When `include_setpoints` is False, only the legacy high/low band
    is present so we can verify the fallback path.
    Optional fan_mode_schedule / hvac_mode_schedule simulate the
    Phase C/D opt-in arrays the backend writes when the user enables
    fan or mode optimization.
    """
    schedule: dict = {
        "high_temps": [74.0] * 48,
        "low_temps": [70.0] * 48,
    }
    if include_setpoints:
        # Constant setpoint across the day for test simplicity.
        schedule["setpoint_temps"] = [setpoint] * 48
    if fan_mode_schedule is not None:
        schedule["fan_mode_schedule"] = fan_mode_schedule
    if hvac_mode_schedule is not None:
        schedule["hvac_mode_schedule"] = hvac_mode_schedule
    return {
        "schedule": {
            "fetched_at": _fresh_ts(),
            "hvac-1": {
                "appliance_type": "hvac",
                "entity_id": entity_id,
                "schedule": schedule,
            },
        }
    }


@pytest.mark.asyncio
async def test_apply_hvac_heat_cool_with_range_uses_degenerate_band_at_setpoint() -> None:
    """heat_cool + range support → low = high = setpoint (no deadband leeway)."""
    hass = _hass(_climate_state("heat_cool", supports_range=True))
    entry = _entry()
    hass.data[DOMAIN] = _hvac_cache(setpoint=71.5)
    with patch.object(scheduler, "_current_slot", return_value=28):
        await scheduler.apply_current_slot(hass, entry)

    hass.services.async_call.assert_awaited_once()
    args, _ = hass.services.async_call.await_args
    assert args[0] == "climate"
    assert args[1] == "set_temperature"
    payload = args[2]
    assert payload == {
        "entity_id": "climate.living_room",
        "target_temp_low": 71.5,
        "target_temp_high": 71.5,
    }


@pytest.mark.asyncio
async def test_apply_hvac_cool_mode_uses_setpoint_directly() -> None:
    """cool mode → temperature = setpoint (NOT the comfort high)."""
    hass = _hass(_climate_state("cool", supports_range=False))
    entry = _entry()
    hass.data[DOMAIN] = _hvac_cache(setpoint=71.5)
    with patch.object(scheduler, "_current_slot", return_value=28):
        await scheduler.apply_current_slot(hass, entry)

    hass.services.async_call.assert_awaited_once()
    payload = hass.services.async_call.await_args.args[2]
    assert payload == {"entity_id": "climate.living_room", "temperature": 71.5}


@pytest.mark.asyncio
async def test_apply_hvac_heat_mode_uses_setpoint_directly() -> None:
    """heat mode → temperature = setpoint (NOT the comfort low)."""
    hass = _hass(_climate_state("heat", supports_range=False))
    entry = _entry()
    hass.data[DOMAIN] = _hvac_cache(setpoint=71.5)
    with patch.object(scheduler, "_current_slot", return_value=28):
        await scheduler.apply_current_slot(hass, entry)

    hass.services.async_call.assert_awaited_once()
    payload = hass.services.async_call.await_args.args[2]
    assert payload == {"entity_id": "climate.living_room", "temperature": 71.5}


@pytest.mark.asyncio
async def test_apply_hvac_clamps_setpoint_below_entity_min() -> None:
    """Regression: backend trajectory could dip below the AC's hardware
    min_temp (e.g. 59 °F sent to a window unit with min_temp=64). HA
    raised ServiceValidationError and the service call aborted. The
    integration now clamps the setpoint to the entity's accepted range
    so the call always lands."""
    hass = _hass(_climate_state(
        "cool", supports_range=False, min_temp=64.0, max_temp=86.0,
    ))
    entry = _entry()
    hass.data[DOMAIN] = _hvac_cache(setpoint=59.0)  # below AC min
    with patch.object(scheduler, "_current_slot", return_value=28):
        await scheduler.apply_current_slot(hass, entry)

    hass.services.async_call.assert_awaited_once()
    payload = hass.services.async_call.await_args.args[2]
    assert payload["temperature"] == 64.0, (
        f"setpoint=59 should clamp to entity min_temp=64, got {payload}"
    )


@pytest.mark.asyncio
async def test_apply_hvac_clamps_setpoint_above_entity_max() -> None:
    """Mirror — setpoint above the entity's max_temp clamps to max."""
    hass = _hass(_climate_state(
        "heat", supports_range=False, min_temp=64.0, max_temp=86.0,
    ))
    entry = _entry()
    hass.data[DOMAIN] = _hvac_cache(setpoint=92.0)  # above AC max
    with patch.object(scheduler, "_current_slot", return_value=28):
        await scheduler.apply_current_slot(hass, entry)

    hass.services.async_call.assert_awaited_once()
    payload = hass.services.async_call.await_args.args[2]
    assert payload["temperature"] == 86.0


@pytest.mark.asyncio
async def test_apply_hvac_setpoint_within_range_passes_through() -> None:
    """Setpoint inside the entity range is sent unmodified."""
    hass = _hass(_climate_state(
        "cool", supports_range=False, min_temp=64.0, max_temp=86.0,
    ))
    entry = _entry()
    hass.data[DOMAIN] = _hvac_cache(setpoint=72.5)
    with patch.object(scheduler, "_current_slot", return_value=28):
        await scheduler.apply_current_slot(hass, entry)
    payload = hass.services.async_call.await_args.args[2]
    assert payload["temperature"] == 72.5


@pytest.mark.asyncio
async def test_apply_hvac_calls_set_fan_mode_when_schedule_includes_fan() -> None:
    """Phase C: when the schedule carries `fan_mode_schedule`, the
    integration calls `climate.set_fan_mode` alongside the temperature
    setpoint, mapping the canonical 'high'/'low'/'auto' label to the
    entity's actual fan_modes vocabulary."""
    hass = _hass(_climate_state(
        "cool", supports_range=False,
        fan_modes=["Low", "Medium", "High", "Auto"],
    ))
    entry = _entry()
    fan_sched = ["high"] * 48
    hass.data[DOMAIN] = _hvac_cache(
        setpoint=71.5, fan_mode_schedule=fan_sched,
    )
    with patch.object(scheduler, "_current_slot", return_value=28):
        await scheduler.apply_current_slot(hass, entry)

    # Two service calls expected: set_temperature + set_fan_mode.
    assert hass.services.async_call.await_count == 2
    services = [c.args[1] for c in hass.services.async_call.await_args_list]
    assert "set_temperature" in services
    assert "set_fan_mode" in services
    fan_call = next(
        c for c in hass.services.async_call.await_args_list
        if c.args[1] == "set_fan_mode"
    )
    # Canonical 'high' must map to the entity's 'High' label exactly.
    assert fan_call.args[2]["fan_mode"] == "High"


@pytest.mark.asyncio
async def test_apply_hvac_does_not_call_set_fan_mode_for_auto_sentinel() -> None:
    """Regression: when the optimizer marks a slot OFF, it writes
    `"auto"` into fan_mode_schedule as a sentinel meaning "leave fan
    alone". The integration MUST NOT call set_fan_mode with the
    entity's "Auto" option, because on Tuya / mini-split units that
    triggers Eco / Auto-compressor mode which then overrides the
    setpoint. Only the temperature setpoint should land."""
    hass = _hass(_climate_state(
        "cool", supports_range=False,
        fan_modes=["Low", "Medium", "High", "Auto"],
    ))
    entry = _entry()
    hass.data[DOMAIN] = _hvac_cache(
        setpoint=73.0, fan_mode_schedule=["auto"] * 48,
    )
    with patch.object(scheduler, "_current_slot", return_value=26):
        await scheduler.apply_current_slot(hass, entry)

    services = [c.args[1] for c in hass.services.async_call.await_args_list]
    assert services == ["set_temperature"], (
        f"expected only set_temperature, got {services}"
    )


@pytest.mark.asyncio
async def test_apply_hvac_does_not_call_set_fan_mode_for_off_sentinel() -> None:
    """Same as the `auto` sentinel test but for the alternative `off`
    canonical that older schedules may carry."""
    hass = _hass(_climate_state(
        "cool", supports_range=False,
        fan_modes=["Low", "Medium", "High", "Auto"],
    ))
    entry = _entry()
    hass.data[DOMAIN] = _hvac_cache(
        setpoint=73.0, fan_mode_schedule=["off"] * 48,
    )
    with patch.object(scheduler, "_current_slot", return_value=10):
        await scheduler.apply_current_slot(hass, entry)

    services = [c.args[1] for c in hass.services.async_call.await_args_list]
    assert "set_fan_mode" not in services


@pytest.mark.asyncio
async def test_apply_hvac_sentinel_is_case_insensitive() -> None:
    """The sentinel check must tolerate any casing the backend or a
    custom optimizer might emit (`AUTO`, `Auto`, `off`, etc.)."""
    hass = _hass(_climate_state(
        "cool", supports_range=False,
        fan_modes=["Low", "Medium", "High", "Auto"],
    ))
    entry = _entry()
    schedule = ["AUTO"] * 24 + ["Off"] * 24
    hass.data[DOMAIN] = _hvac_cache(
        setpoint=73.0, fan_mode_schedule=schedule,
    )
    # Probe one slot from each half.
    for slot in (5, 35):
        hass.services.async_call.reset_mock()
        with patch.object(scheduler, "_current_slot", return_value=slot):
            await scheduler.apply_current_slot(hass, entry)
        services = [c.args[1] for c in hass.services.async_call.await_args_list]
        assert "set_fan_mode" not in services, (
            f"slot={slot} expected no set_fan_mode, got {services}"
        )


@pytest.mark.asyncio
async def test_apply_hvac_maps_canonical_medium_to_entity_label() -> None:
    """Backend now emits `medium` for moderate-tier fan slots (between
    low maintenance and high pre-cool). The matcher must resolve it to
    the entity's "Medium" label without regression."""
    hass = _hass(_climate_state(
        "cool", supports_range=False,
        fan_modes=["Low", "Medium", "High", "Auto"],
    ))
    entry = _entry()
    hass.data[DOMAIN] = _hvac_cache(
        setpoint=72.0, fan_mode_schedule=["medium"] * 48,
    )
    with patch.object(scheduler, "_current_slot", return_value=28):
        await scheduler.apply_current_slot(hass, entry)

    fan_call = next(
        c for c in hass.services.async_call.await_args_list
        if c.args[1] == "set_fan_mode"
    )
    assert fan_call.args[2]["fan_mode"] == "Medium"


@pytest.mark.asyncio
async def test_apply_hvac_medium_skipped_on_two_speed_units() -> None:
    """Window ACs that only expose Low/High/Auto (no Medium) should
    silently skip the fan-mode call for a `medium` canonical instead
    of forcing the user's unit into a label it doesn't advertise. The
    setpoint command still lands so cooling is unaffected."""
    hass = _hass(_climate_state(
        "cool", supports_range=False,
        fan_modes=["Low", "High", "Auto"],
    ))
    entry = _entry()
    hass.data[DOMAIN] = _hvac_cache(
        setpoint=72.0, fan_mode_schedule=["medium"] * 48,
    )
    with patch.object(scheduler, "_current_slot", return_value=28):
        await scheduler.apply_current_slot(hass, entry)

    services = [c.args[1] for c in hass.services.async_call.await_args_list]
    assert services == ["set_temperature"]


@pytest.mark.asyncio
async def test_apply_hvac_skips_fan_when_label_unmatched() -> None:
    """If the entity's fan_modes list doesn't contain anything
    matching the canonical, skip the fan service call rather than
    sending a value the entity will reject."""
    hass = _hass(_climate_state(
        "cool", supports_range=False,
        # No 'high'-equivalent label.
        fan_modes=["Quiet", "Sleep", "Turbo"],
    ))
    entry = _entry()
    hass.data[DOMAIN] = _hvac_cache(
        setpoint=71.5, fan_mode_schedule=["high"] * 48,
    )
    with patch.object(scheduler, "_current_slot", return_value=28):
        await scheduler.apply_current_slot(hass, entry)

    # Only the temperature call landed.
    services = [c.args[1] for c in hass.services.async_call.await_args_list]
    assert services == ["set_temperature"]


@pytest.mark.asyncio
async def test_apply_hvac_calls_set_hvac_mode_when_schedule_changes_mode() -> None:
    """Phase D: when `hvac_mode_schedule[slot]` differs from the
    entity's current mode, call `climate.set_hvac_mode` BEFORE the
    setpoint so the temperature applies in the right mode."""
    hass = _hass(_climate_state(
        "off",  # currently off — schedule wants COOL
        supports_range=False,
        hvac_modes=["off", "cool", "heat", "fan_only"],
    ))
    entry = _entry()
    hass.data[DOMAIN] = _hvac_cache(
        setpoint=71.5, hvac_mode_schedule=["COOL"] * 48,
    )
    with patch.object(scheduler, "_current_slot", return_value=28):
        await scheduler.apply_current_slot(hass, entry)

    services = [c.args[1] for c in hass.services.async_call.await_args_list]
    assert "set_hvac_mode" in services
    mode_call = next(
        c for c in hass.services.async_call.await_args_list
        if c.args[1] == "set_hvac_mode"
    )
    assert mode_call.args[2]["hvac_mode"] == "cool"


@pytest.mark.asyncio
async def test_apply_hvac_skips_set_hvac_mode_when_already_in_target_mode() -> None:
    """Mode change is a no-op when the entity is already in the target
    mode — no point re-issuing the same command every 30 minutes."""
    hass = _hass(_climate_state(
        "cool", supports_range=False,
        hvac_modes=["off", "cool", "heat"],
    ))
    entry = _entry()
    hass.data[DOMAIN] = _hvac_cache(
        setpoint=71.5, hvac_mode_schedule=["COOL"] * 48,
    )
    with patch.object(scheduler, "_current_slot", return_value=28):
        await scheduler.apply_current_slot(hass, entry)

    services = [c.args[1] for c in hass.services.async_call.await_args_list]
    assert "set_hvac_mode" not in services
    assert services == ["set_temperature"]


@pytest.mark.asyncio
async def test_apply_hvac_legacy_eco_in_cache_falls_back_to_cool() -> None:
    """The current backend doesn't recommend ECO any more (preset
    coverage is too vendor-specific to deliver universally), but a
    schedule cached from an older backend version may still contain
    ECO values. The integration must safely degrade ECO → set
    hvac_mode='cool' so a stale cache doesn't block the apply."""
    hass = _hass(_climate_state(
        "off", supports_range=False,
        hvac_modes=["off", "cool", "heat"],
    ))
    entry = _entry()
    hass.data[DOMAIN] = _hvac_cache(
        setpoint=71.5, hvac_mode_schedule=["ECO"] * 48,
    )
    with patch.object(scheduler, "_current_slot", return_value=28):
        await scheduler.apply_current_slot(hass, entry)

    mode_call = next(
        (c for c in hass.services.async_call.await_args_list
         if c.args[1] == "set_hvac_mode"), None,
    )
    assert mode_call is not None
    assert mode_call.args[2]["hvac_mode"] == "cool"


@pytest.mark.asyncio
async def test_apply_hvac_off_mode_skips_service_call() -> None:
    """off mode → no service call (the user has the thermostat off intentionally)."""
    hass = _hass(_climate_state("off", supports_range=False))
    entry = _entry()
    hass.data[DOMAIN] = _hvac_cache()
    with patch.object(scheduler, "_current_slot", return_value=28):
        await scheduler.apply_current_slot(hass, entry)
    hass.services.async_call.assert_not_awaited()


@pytest.mark.asyncio
async def test_apply_hvac_auto_mode_without_range_uses_setpoint_as_single_temp() -> None:
    """auto mode without range support → single temperature = setpoint."""
    hass = _hass(_climate_state("auto", supports_range=False))
    entry = _entry()
    hass.data[DOMAIN] = _hvac_cache(setpoint=71.5)
    with patch.object(scheduler, "_current_slot", return_value=28):
        await scheduler.apply_current_slot(hass, entry)

    hass.services.async_call.assert_awaited_once()
    payload = hass.services.async_call.await_args.args[2]
    assert payload == {"entity_id": "climate.living_room", "temperature": 71.5}


@pytest.mark.asyncio
async def test_apply_hvac_skips_when_entity_state_missing() -> None:
    """If hass.states.get returns None, skip the apply (entity not loaded yet)."""
    hass = _hass(climate_state=None)
    entry = _entry()
    hass.data[DOMAIN] = _hvac_cache()
    with patch.object(scheduler, "_current_slot", return_value=28):
        await scheduler.apply_current_slot(hass, entry)
    hass.services.async_call.assert_not_awaited()


@pytest.mark.asyncio
async def test_apply_hvac_skipped_when_setpoint_temps_missing() -> None:
    """No `setpoint_temps` in the schedule → skip the apply.

    The backend is the single source of truth for the commanded
    setpoint; if it's not in the payload, the integration must not
    invent one (a midpoint or otherwise) — quietly skipping is
    safer than guessing wrong.
    """
    hass = _hass(_climate_state("cool", supports_range=False))
    entry = _entry()
    hass.data[DOMAIN] = _hvac_cache(include_setpoints=False)
    with patch.object(scheduler, "_current_slot", return_value=28):
        await scheduler.apply_current_slot(hass, entry)
    hass.services.async_call.assert_not_awaited()


@pytest.mark.asyncio
async def test_apply_switch_calls_turn_on_when_interval_true() -> None:
    hass = _hass()
    entry = _entry()
    hass.data[DOMAIN] = {
        "schedule": {
            "fetched_at": _fresh_ts(),
            "ev-1": {
                "appliance_type": "ev_charger",
                "entity_id": "switch.tesla",
                "schedule": {"intervals": [False, False, True, True] + [False] * 44},
            },
        }
    }
    with patch.object(scheduler, "_current_slot", return_value=2):
        await scheduler.apply_current_slot(hass, entry)

    hass.services.async_call.assert_awaited_once()
    args = hass.services.async_call.await_args.args
    assert args[0] == "switch"
    assert args[1] == "turn_on"
    assert args[2]["entity_id"] == "switch.tesla"


@pytest.mark.asyncio
async def test_apply_switch_calls_turn_off_when_interval_false() -> None:
    hass = _hass()
    entry = _entry()
    hass.data[DOMAIN] = {
        "schedule": {
            "fetched_at": _fresh_ts(),
            "ev-1": {
                "appliance_type": "ev_charger",
                "entity_id": "switch.tesla",
                "schedule": {"intervals": [False] * 48},
            },
        }
    }
    with patch.object(scheduler, "_current_slot", return_value=10):
        await scheduler.apply_current_slot(hass, entry)

    args = hass.services.async_call.await_args.args
    assert args[1] == "turn_off"


@pytest.mark.asyncio
async def test_apply_skipped_when_entity_id_missing() -> None:
    hass = _hass()
    entry = _entry()
    hass.data[DOMAIN] = {
        "schedule": {
            "fetched_at": _fresh_ts(),
            "broken-1": {
                "appliance_type": "hvac",
                "entity_id": None,
                "schedule": {"high_temps": [70] * 48, "low_temps": [68] * 48},
            },
        }
    }
    with patch.object(scheduler, "_current_slot", return_value=0):
        await scheduler.apply_current_slot(hass, entry)
    hass.services.async_call.assert_not_awaited()


@pytest.mark.asyncio
async def test_apply_skipped_when_schedule_empty() -> None:
    """source=defaults entries have schedule={} — must be skipped, not crash."""
    hass = _hass()
    entry = _entry()
    hass.data[DOMAIN] = {
        "schedule": {
            "fetched_at": _fresh_ts(),
            "hvac-1": {
                "appliance_type": "hvac",
                "entity_id": "climate.test",
                "schedule": {},
            },
        }
    }
    with patch.object(scheduler, "_current_slot", return_value=0):
        await scheduler.apply_current_slot(hass, entry)
    hass.services.async_call.assert_not_awaited()


@pytest.mark.asyncio
async def test_apply_no_cache_triggers_refresh_then_skips_when_api_returns_nothing() -> None:
    """No cache → try refresh; refresh returns None → skip.

    The self-heal logic always attempts a fetch before giving up; it
    only skips after the refresh leaves the cache empty.
    """
    hass = _hass()
    entry = _entry()
    hass.data[DOMAIN] = {}  # no 'schedule' key
    with patch.object(scheduler.api, "get_schedules", AsyncMock(return_value=None)):
        await scheduler.apply_current_slot(hass, entry)
    hass.services.async_call.assert_not_awaited()


@pytest.mark.asyncio
async def test_apply_refreshes_when_cache_lacks_setpoint_temps() -> None:
    """Cache has an HVAC schedule but no setpoint_temps → refresh, then apply.

    Simulates the post-deploy state where the integration was upgraded
    before the API caught up: the cached schedule is the API's old
    shape. After the refresh sees the new shape, apply proceeds.
    """
    hass = _hass(_climate_state("cool", supports_range=False))
    entry = _entry()
    # Pre-populate cache WITHOUT setpoint_temps (the stale state).
    hass.data[DOMAIN] = _hvac_cache(include_setpoints=False)

    # Refreshed body now carries setpoint_temps.
    refreshed_body = {
        "date": "2026-05-09",
        "appliances": [
            {
                "appliance_id": "hvac-1",
                "appliance_type": "hvac",
                "name": "AC",
                "schedule": {
                    "intervals": list(range(48)),
                    "high_temps": [74.0] * 48,
                    "low_temps": [70.0] * 48,
                    "setpoint_temps": [72.0] * 48,
                    "mode": "cool",
                },
                "savings_pct": 18.5,
                "source": "optimization",
                "entities": {"entity_id": "climate.living_room"},
            },
        ],
    }
    with (
        patch.object(scheduler.api, "get_schedules", AsyncMock(return_value=refreshed_body)),
        patch.object(scheduler, "_current_slot", return_value=28),
    ):
        await scheduler.apply_current_slot(hass, entry)

    # After refresh the cache has setpoint_temps and the apply lands.
    hass.services.async_call.assert_awaited_once()
    payload = hass.services.async_call.await_args.args[2]
    assert payload == {"entity_id": "climate.living_room", "temperature": 72.0}


@pytest.mark.asyncio
async def test_apply_refreshes_when_cache_is_old() -> None:
    """Cache `fetched_at` older than _CACHE_MAX_AGE_SECONDS → refresh."""
    hass = _hass(_climate_state("cool", supports_range=False))
    entry = _entry()
    stale_ts = (datetime.now(timezone.utc) - timedelta(hours=4)).isoformat()
    cache = _hvac_cache()
    cache["schedule"]["fetched_at"] = stale_ts
    hass.data[DOMAIN] = cache

    fresh_body = {
        "date": "2026-05-09",
        "appliances": [
            {
                "appliance_id": "hvac-1",
                "appliance_type": "hvac",
                "name": "AC",
                "schedule": {
                    "intervals": list(range(48)),
                    "high_temps": [74.0] * 48,
                    "low_temps": [70.0] * 48,
                    "setpoint_temps": [69.0] * 48,
                    "mode": "cool",
                },
                "savings_pct": 22.0,
                "source": "optimization",
                "entities": {"entity_id": "climate.living_room"},
            },
        ],
    }
    fetch_spy = AsyncMock(return_value=fresh_body)
    with (
        patch.object(scheduler.api, "get_schedules", fetch_spy),
        patch.object(scheduler, "_current_slot", return_value=28),
    ):
        await scheduler.apply_current_slot(hass, entry)

    fetch_spy.assert_awaited_once()
    # Apply uses the refreshed cache's setpoint (69.0), not the stale cache's (71.5).
    payload = hass.services.async_call.await_args.args[2]
    assert payload == {"entity_id": "climate.living_room", "temperature": 69.0}


@pytest.mark.asyncio
async def test_apply_does_not_refresh_when_cache_is_fresh_and_complete() -> None:
    """Fresh cache + setpoint_temps present → no refresh fetch."""
    hass = _hass(_climate_state("cool", supports_range=False))
    entry = _entry()
    hass.data[DOMAIN] = _hvac_cache(setpoint=71.5)

    fetch_spy = AsyncMock()
    with (
        patch.object(scheduler.api, "get_schedules", fetch_spy),
        patch.object(scheduler, "_current_slot", return_value=28),
    ):
        await scheduler.apply_current_slot(hass, entry)

    fetch_spy.assert_not_awaited()
    hass.services.async_call.assert_awaited_once()


@pytest.mark.asyncio
async def test_apply_logs_warning_when_setpoints_still_missing_after_refresh(caplog) -> None:
    """If refresh returns a schedule that STILL lacks setpoint_temps —
    the API hasn't been deployed with the setpoint emission yet —
    log a warning that points at the version mismatch."""
    import logging
    caplog.set_level(logging.WARNING, logger="custom_components.hungry_machines.scheduler")

    hass = _hass(_climate_state("cool", supports_range=False))
    entry = _entry()
    hass.data[DOMAIN] = _hvac_cache(include_setpoints=False)

    # Refresh returns a body that still lacks setpoint_temps.
    stale_body = {
        "date": "2026-05-09",
        "appliances": [
            {
                "appliance_id": "hvac-1",
                "appliance_type": "hvac",
                "name": "AC",
                "schedule": {
                    "intervals": list(range(48)),
                    "high_temps": [74.0] * 48,
                    "low_temps": [70.0] * 48,
                    "mode": "cool",
                },
                "savings_pct": 18.5,
                "source": "optimization",
                "entities": {"entity_id": "climate.living_room"},
            },
        ],
    }
    with (
        patch.object(scheduler.api, "get_schedules", AsyncMock(return_value=stale_body)),
        patch.object(scheduler, "_current_slot", return_value=28),
    ):
        await scheduler.apply_current_slot(hass, entry)

    # Apply skips (no setpoint), AND a clear warning is emitted.
    hass.services.async_call.assert_not_awaited()
    assert any(
        "older version" in rec.message
        for rec in caplog.records
        if rec.levelno >= logging.WARNING
    )


def test_current_slot_at_midnight_is_zero() -> None:
    assert scheduler._current_slot(datetime(2026, 5, 7, 0, 0)) == 0


def test_current_slot_at_half_past_is_odd() -> None:
    # 14:30 → 14*2 + 1 = 29
    assert scheduler._current_slot(datetime(2026, 5, 7, 14, 30)) == 29


def test_current_slot_at_quarter_past_uses_lower_half() -> None:
    # 14:15 → minute < 30 → slot 28
    assert scheduler._current_slot(datetime(2026, 5, 7, 14, 15)) == 28


def test_current_slot_uses_ha_local_time_not_process_utc() -> None:
    """Regression for the timezone bug: with no explicit `now`,
    `_current_slot` must use `dt_util.now()` (HA's configured local
    time) — NOT `datetime.now()` (process local, which is UTC in most
    Docker / k8s HA deployments).

    Setup: HA configured for America/New_York (EDT, UTC-4). The wall
    clock locally is 09:00 (slot 18). If the implementation reads the
    process clock (UTC), it would return 13:00 → slot 26 — the exact
    4-hour shift the pilot user observed.
    """
    edt = ZoneInfo("America/New_York")
    local_9am = datetime(2026, 5, 29, 9, 0, tzinfo=edt)
    with patch.object(scheduler, "dt_util") as mock_dt:
        mock_dt.now.return_value = local_9am
        slot = scheduler._current_slot()
    assert slot == 18, (
        "expected slot 18 (09:00 local EDT), got "
        f"{slot} — likely reading process UTC instead of HA local time"
    )


def test_current_slot_explicit_now_argument_overrides_dt_util() -> None:
    """The optional `now` parameter still wins over `dt_util.now()`
    so existing test fixtures + admin paths can pass a specific time."""
    with patch.object(scheduler, "dt_util") as mock_dt:
        mock_dt.now.return_value = datetime(2026, 5, 29, 23, 59)
        # Explicit argument should be used instead of the patched
        # dt_util fallback.
        assert scheduler._current_slot(datetime(2026, 5, 29, 0, 0)) == 0


@pytest.mark.asyncio
async def test_apply_hvac_log_message_includes_ha_local_clock_time() -> None:
    """The HVAC apply log line must include HA-local wall-clock time so
    users can read the slot in their own timezone, regardless of how
    HA's log formatter timestamps the line (often UTC in Docker)."""
    hass = _hass(_climate_state("cool", supports_range=False))
    entry = _entry()
    hass.data[DOMAIN] = _hvac_cache(setpoint=72.0)
    edt = ZoneInfo("America/New_York")
    local_3pm = datetime(2026, 5, 29, 15, 0, tzinfo=edt)
    with patch.object(scheduler, "dt_util") as mock_dt, \
         patch.object(scheduler, "_current_slot", return_value=30), \
         patch.object(scheduler, "_LOGGER") as mock_log:
        mock_dt.now.return_value = local_3pm
        await scheduler.apply_current_slot(hass, entry)
    # Find the apply log call and check that "15:00" appears in the
    # formatted message body.
    apply_call = next(
        c for c in mock_log.info.call_args_list
        if "HVAC apply" in c.args[0]
    )
    fmt = apply_call.args[0]
    formatted = fmt % apply_call.args[1:]
    assert "15:00" in formatted, f"expected '15:00' in log: {formatted}"
    assert "local" in formatted
