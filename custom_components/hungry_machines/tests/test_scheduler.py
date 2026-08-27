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
    indoor_temp_entity_id: str | None = None,
) -> dict:
    """Build a cached schedule for one HVAC appliance.

    `setpoint` is the value at slot 28 (where each apply test reads).
    When `include_setpoints` is False, only the legacy high/low band
    is present so we can verify the fallback path.
    Optional fan_mode_schedule / hvac_mode_schedule simulate the
    Phase C/D opt-in arrays the backend writes when the user enables
    fan or mode optimization. `indoor_temp_entity_id` simulates the
    US-CBE-003 aux sensor id, when configured.
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
                "indoor_temp_entity_id": indoor_temp_entity_id,
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
    # Widen the comfort band so the new US-CBE-013 band clamp doesn't
    # intercept the value first — this test is specifically about the
    # hardware-range clamp.
    hass.data[DOMAIN]["schedule"]["hvac-1"]["schedule"]["low_temps"] = [50.0] * 48
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
    # Widen the comfort band so the new US-CBE-013 band clamp doesn't
    # intercept the value first — this test is specifically about the
    # hardware-range clamp.
    hass.data[DOMAIN]["schedule"]["hvac-1"]["schedule"]["high_temps"] = [95.0] * 48
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


# ---------------------------------------------------------------------------
# Client-side band clamp (US-CBE-013) — defense-in-depth against a backend
# bug or a comfort band edited locally after the nightly run already
# computed setpoint_temps. Only applies when no comfort-band override is
# active; the backend already clamps at nightly derivation so this should
# be a no-op in the common case.
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_apply_hvac_clamps_setpoint_outside_comfort_band(caplog) -> None:
    """A setpoint above the slot's high_temps edge (stale band, or a
    backend bug) is clamped into the band before it's commanded, and the
    clamp fires a WARNING since it should never happen in practice."""
    import logging
    caplog.set_level(logging.WARNING, logger="custom_components.hungry_machines.scheduler")

    hass = _hass(_climate_state("cool", supports_range=False))
    entry = _entry()
    hass.data[DOMAIN] = _hvac_cache(setpoint=80.0)  # above the 74°F high band
    with patch.object(scheduler, "_current_slot", return_value=28):
        await scheduler.apply_current_slot(hass, entry)

    hass.services.async_call.assert_awaited_once()
    payload = hass.services.async_call.await_args.args[2]
    assert payload["temperature"] == 74.0, (
        f"setpoint=80 outside band [70, 74] should clamp to 74, got {payload}"
    )
    cached = scheduler.get_last_commanded(hass, "climate.living_room")
    assert cached["setpoint"] == 74.0, "the clamped value is the commanded truth"
    assert any(
        rec.levelno >= logging.WARNING and "outside the comfort band" in rec.message
        for rec in caplog.records
    )


@pytest.mark.asyncio
async def test_apply_hvac_calibration_blob_passes_through_unclamped() -> None:
    """A calibration-day blob pins COOL-phase setpoints to the band's LOW
    edge and OFF-phase setpoints to the HIGH edge — both already sit
    exactly on an edge, so the new clamp must be a true no-op here."""
    hass = _hass(_climate_state(
        "cool", supports_range=False, hvac_modes=["off", "cool"],
    ))
    entry = _entry()
    hass.data[DOMAIN] = _hvac_cache(
        setpoint=70.0,  # COOL-phase pin: band's LOW edge (high=74, low=70)
        hvac_mode_schedule=["COOL"] * 48,
    )
    with patch.object(scheduler, "_current_slot", return_value=28):
        await scheduler.apply_current_slot(hass, entry)

    payload = hass.services.async_call.await_args.args[2]
    assert payload["temperature"] == 70.0

    # Mirror the OFF-phase pin: band's HIGH edge.
    hass.services.async_call.reset_mock()
    hass.data[DOMAIN] = _hvac_cache(
        setpoint=74.0,  # OFF-phase pin: band's HIGH edge
        hvac_mode_schedule=["OFF"] * 48,
    )
    with patch.object(scheduler, "_current_slot", return_value=28):
        await scheduler.apply_current_slot(hass, entry)
    # OFF mode skips set_temperature entirely; the recorded truth is the
    # unclamped pin value itself.
    cached = scheduler.get_last_commanded(hass, "climate.living_room")
    assert cached["setpoint"] == 74.0


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
async def test_apply_hvac_records_commanded_values_in_cache() -> None:
    """Every slot apply must seed `hass.data[DOMAIN]['last_commanded'][entity_id]`
    with the schedule's intent so the readings collector can attach
    `commanded_*` to each 5-min payload. The reconciler downstream uses
    these to detect when a Tuya / mini-split thermostat ignores our
    commands."""
    hass = _hass(_climate_state(
        "cool", supports_range=False,
        fan_modes=["low", "medium", "high"],
        hvac_modes=["off", "cool"],
    ))
    entry = _entry()
    hass.data[DOMAIN] = _hvac_cache(
        setpoint=72.0,
        fan_mode_schedule=["low"] * 48,
        hvac_mode_schedule=["COOL"] * 48,
    )
    with patch.object(scheduler, "_current_slot", return_value=18):
        await scheduler.apply_current_slot(hass, entry)

    cached = scheduler.get_last_commanded(hass, "climate.living_room")
    assert cached is not None
    assert cached["hvac_mode"] == "COOL"
    assert cached["fan_mode"] == "low"
    assert cached["setpoint"] == 72.0


@pytest.mark.asyncio
async def test_apply_hvac_records_commanded_for_off_slot() -> None:
    """OFF slots short-circuit `_build_hvac_payload` (returns None
    because the entity isn't in a temperature-driven mode), but the
    schedule's INTENT — "OFF for this slot" — must still land in the
    commanded cache. Without that, the reconciler can't tell the
    difference between 'we commanded OFF and the AC obeyed' vs 'we
    commanded OFF but the AC kept running.'"""
    hass = _hass(_climate_state(
        "off", supports_range=False,
        hvac_modes=["off", "cool"],
    ))
    entry = _entry()
    hass.data[DOMAIN] = _hvac_cache(
        setpoint=72.0,
        fan_mode_schedule=["auto"] * 48,
        hvac_mode_schedule=["OFF"] * 48,
    )
    with patch.object(scheduler, "_current_slot", return_value=22):
        await scheduler.apply_current_slot(hass, entry)

    cached = scheduler.get_last_commanded(hass, "climate.living_room")
    assert cached is not None
    assert cached["hvac_mode"] == "OFF"
    assert cached["fan_mode"] == "auto"
    assert cached["setpoint"] == 72.0


@pytest.mark.asyncio
async def test_get_last_commanded_returns_none_before_first_apply() -> None:
    """Before any slot has been applied — fresh HA start, integration
    just installed, entity never driven — readings.py must not blow up.
    The getter returns None and the readings payload omits the
    commanded_* fields entirely."""
    hass = _hass()
    assert scheduler.get_last_commanded(hass, "climate.never_driven") is None


@pytest.mark.asyncio
async def test_verify_resends_when_commanded_values_did_not_stick() -> None:
    """Set-then-verify: ~2.5 min after an apply, the verifier re-reads
    the entity. If the unit reverted (Tuya dropped the command, or
    resumed stale remembered settings), the failed pieces are re-sent
    exactly once."""
    hass = _hass(_climate_state(
        "cool", supports_range=False,
        fan_modes=["low", "medium", "high"],
        hvac_modes=["off", "cool"],
    ))
    # Entity reports: cool / 80.0 / low — but we commanded 68 + high.
    hass.states.get.return_value.attributes.update(
        {"temperature": 80.0, "fan_mode": "low"}
    )
    await scheduler._verify_hvac_apply(
        hass,
        entity_id="climate.living_room",
        expected_mode="COOL",
        expected_setpoint=68.0,
        expected_fan="high",
        slot=30,
    )
    calls = [
        (c.args[1], c.args[2])
        for c in hass.services.async_call.await_args_list
    ]
    services = [s for s, _ in calls]
    assert "set_temperature" in services
    assert "set_fan_mode" in services
    temp = next(p for s, p in calls if s == "set_temperature")
    assert temp["temperature"] == 68.0
    fan = next(p for s, p in calls if s == "set_fan_mode")
    assert fan["fan_mode"] == "high"
    # Mode matched ('cool' == commanded COOL) — must NOT re-send mode.
    assert "set_hvac_mode" not in services


@pytest.mark.asyncio
async def test_verify_is_silent_when_everything_stuck() -> None:
    """When the entity reports exactly what was commanded, the verifier
    sends nothing — no churn, no fighting the unit."""
    hass = _hass(_climate_state(
        "cool", supports_range=False,
        fan_modes=["low", "medium", "high"],
        hvac_modes=["off", "cool"],
    ))
    hass.states.get.return_value.attributes.update(
        {"temperature": 68.0, "fan_mode": "high"}
    )
    await scheduler._verify_hvac_apply(
        hass,
        entity_id="climate.living_room",
        expected_mode="COOL",
        expected_setpoint=68.0,
        expected_fan="high",
        slot=30,
    )
    hass.services.async_call.assert_not_awaited()


@pytest.mark.asyncio
async def test_verify_skips_setpoint_and_fan_when_commanded_off() -> None:
    """OFF slots: only the mode is verified. Setpoint / fan checks are
    meaningless on a unit that should be off — and re-sending them
    would turn the unit back on."""
    hass = _hass(_climate_state(
        "cool",  # unit ignored the off command
        supports_range=False,
        hvac_modes=["off", "cool"],
    ))
    hass.states.get.return_value.attributes.update(
        {"temperature": 75.0, "fan_mode": "low"}
    )
    await scheduler._verify_hvac_apply(
        hass,
        entity_id="climate.living_room",
        expected_mode="OFF",
        expected_setpoint=80.0,
        expected_fan=None,
        slot=28,
    )
    calls = [
        (c.args[1], c.args[2])
        for c in hass.services.async_call.await_args_list
    ]
    services = [s for s, _ in calls]
    # Mode mismatch (cool vs commanded OFF) → re-send off.
    assert services == ["set_hvac_mode"]
    mode = next(p for s, p in calls if s == "set_hvac_mode")
    assert mode["hvac_mode"] == "off"


@pytest.mark.asyncio
async def test_apply_schedules_a_verification() -> None:
    """Every successful apply must arm the one-shot verifier."""
    hass = _hass(_climate_state(
        "cool", supports_range=False,
        fan_modes=["low", "medium", "high"],
        hvac_modes=["off", "cool"],
    ))
    entry = _entry()
    hass.data[DOMAIN] = _hvac_cache(
        setpoint=68.0,
        fan_mode_schedule=["high"] * 48,
        hvac_mode_schedule=["COOL"] * 48,
    )
    with patch.object(scheduler, "_current_slot", return_value=30), \
         patch.object(scheduler, "async_call_later") as mock_later:
        await scheduler.apply_current_slot(hass, entry)

    mock_later.assert_called_once()
    # Delay arg is the 2.5-minute settle window.
    assert mock_later.call_args.args[1] == scheduler._VERIFY_DELAY_SECONDS


@pytest.mark.asyncio
async def test_off_to_cool_transition_sends_setpoint_despite_stale_state() -> None:
    """June 10 calibration phase-3 regression: at the OFF→COOL boundary
    the scheduler sends set_hvac_mode('cool'), but cloud-bridged units
    (Tuya) take seconds to reflect it — the immediate state re-read
    still says 'off'. The payload builder used to trust that stale
    read and skip BOTH set_temperature and set_fan_mode, so the unit
    resumed cooling at its stale remembered settings (cool/low/80°F
    instead of cool/high/68°F).

    With assumed_mode, the commanded canonical wins: all three service
    calls (mode, temperature, fan) must fire."""
    hass = _hass(_climate_state(
        "off",  # stale report — unit still shows off after mode cmd
        supports_range=False,
        fan_modes=["low", "medium", "high"],
        hvac_modes=["off", "cool"],
    ))
    entry = _entry()
    hass.data[DOMAIN] = _hvac_cache(
        setpoint=71.0,
        fan_mode_schedule=["high"] * 48,
        hvac_mode_schedule=["COOL"] * 48,
    )
    with patch.object(scheduler, "_current_slot", return_value=30):
        await scheduler.apply_current_slot(hass, entry)

    calls = [
        (c.args[1], c.args[2])
        for c in hass.services.async_call.await_args_list
    ]
    services = [s for s, _ in calls]
    assert "set_hvac_mode" in services, "mode command must fire"
    assert "set_temperature" in services, (
        "setpoint must fire even though the entity still reports 'off'"
    )
    assert "set_fan_mode" in services, (
        "fan command must fire even though the entity still reports 'off'"
    )
    temp_payload = next(p for s, p in calls if s == "set_temperature")
    assert temp_payload["temperature"] == 71.0
    fan_payload = next(p for s, p in calls if s == "set_fan_mode")
    assert fan_payload["fan_mode"] == "high"


@pytest.mark.asyncio
async def test_cool_to_off_transition_skips_setpoint_despite_stale_state() -> None:
    """Mirror of the OFF→COOL race: at the COOL→OFF boundary the entity
    still reports 'cool' for a few seconds. The code used to write the
    OFF-slot's parking setpoint (high band, e.g. 80°F) into the unit
    during that window — which the unit then remembered and resumed at
    when it turned back on. With assumed_mode='OFF', the setpoint write
    is skipped; only the mode command goes out."""
    hass = _hass(_climate_state(
        "cool",  # stale report — unit still shows cool after off cmd
        supports_range=False,
        fan_modes=["low", "medium", "high"],
        hvac_modes=["off", "cool"],
    ))
    entry = _entry()
    hass.data[DOMAIN] = _hvac_cache(
        setpoint=80.0,
        fan_mode_schedule=["auto"] * 48,
        hvac_mode_schedule=["OFF"] * 48,
    )
    with patch.object(scheduler, "_current_slot", return_value=28):
        await scheduler.apply_current_slot(hass, entry)

    services = [c.args[1] for c in hass.services.async_call.await_args_list]
    assert "set_hvac_mode" in services, "off command must fire"
    assert "set_temperature" not in services, (
        "parking setpoint must NOT be written while transitioning off — "
        "the unit memorizes it and resumes at it later"
    )


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


# --- _apply_robot (dock-as-charging-proxy) --------------------------------


def _robot_state(state: str, battery_level: float | None = None) -> MagicMock:
    s = MagicMock()
    s.state = state
    attrs: dict = {}
    if battery_level is not None:
        attrs["battery_level"] = battery_level
    s.attributes = attrs
    return s


@pytest.mark.asyncio
async def test_apply_robot_on_slot_undocked_docks() -> None:
    hass = _hass(_robot_state("cleaning"))
    schedule = {"intervals": [True] + [False] * 47, "min_value": 25}
    await scheduler._apply_robot(hass, "vacuum.robot1", schedule, 0)

    hass.services.async_call.assert_awaited_once()
    args = hass.services.async_call.await_args.args
    assert args[0] == "vacuum"
    assert args[1] == "return_to_base"
    assert args[2] == {"entity_id": "vacuum.robot1"}


@pytest.mark.asyncio
async def test_apply_robot_on_slot_already_docked_no_call() -> None:
    hass = _hass(_robot_state("docked"))
    schedule = {"intervals": [True] + [False] * 47, "min_value": 25}
    await scheduler._apply_robot(hass, "vacuum.robot1", schedule, 0)
    hass.services.async_call.assert_not_awaited()


@pytest.mark.asyncio
async def test_apply_robot_off_slot_never_undocks() -> None:
    hass = _hass(_robot_state("cleaning"))
    schedule = {"intervals": [False] * 48}
    await scheduler._apply_robot(hass, "vacuum.robot1", schedule, 10)
    hass.services.async_call.assert_not_awaited()


@pytest.mark.asyncio
async def test_apply_robot_returning_no_call() -> None:
    hass = _hass(_robot_state("returning"))
    schedule = {"intervals": [True] + [False] * 47, "min_value": 25}
    await scheduler._apply_robot(hass, "vacuum.robot1", schedule, 0)
    hass.services.async_call.assert_not_awaited()


@pytest.mark.asyncio
async def test_apply_robot_low_battery_guard_docks_regardless_of_slot() -> None:
    """Off-dock robot below min_value gets docked even on an OFF slot —
    OFF slots never call a service on their own, so this never fights
    auto-docking, it only ever adds a dock the plan didn't schedule."""
    hass = _hass(_robot_state("cleaning", battery_level=10))
    schedule = {"intervals": [False] * 48, "min_value": 25}
    await scheduler._apply_robot(hass, "vacuum.robot1", schedule, 0)

    hass.services.async_call.assert_awaited_once()
    args = hass.services.async_call.await_args.args
    assert args[0] == "vacuum"
    assert args[1] == "return_to_base"


@pytest.mark.asyncio
async def test_apply_robot_battery_above_floor_no_guard() -> None:
    hass = _hass(_robot_state("cleaning", battery_level=80))
    schedule = {"intervals": [False] * 48, "min_value": 25}
    await scheduler._apply_robot(hass, "vacuum.robot1", schedule, 0)
    hass.services.async_call.assert_not_awaited()


@pytest.mark.asyncio
async def test_apply_robot_missing_battery_level_skips_guard() -> None:
    """No battery_level attribute (e.g. many lawn mowers) → guard is
    skipped entirely rather than guessing; OFF slot stays OFF."""
    hass = _hass(_robot_state("cleaning"))
    schedule = {"intervals": [False] * 48, "min_value": 25}
    await scheduler._apply_robot(hass, "vacuum.robot1", schedule, 0)
    hass.services.async_call.assert_not_awaited()


@pytest.mark.asyncio
async def test_apply_robot_lawn_mower_gets_dock_service() -> None:
    hass = _hass(_robot_state("mowing"))
    schedule = {"intervals": [True] + [False] * 47, "min_value": 25}
    await scheduler._apply_robot(hass, "lawn_mower.backyard", schedule, 0)

    args = hass.services.async_call.await_args.args
    assert args[0] == "lawn_mower"
    assert args[1] == "dock"
    assert args[2] == {"entity_id": "lawn_mower.backyard"}


@pytest.mark.asyncio
async def test_apply_robot_unknown_domain_assumes_vacuum() -> None:
    hass = _hass(_robot_state("unknown"))
    schedule = {"intervals": [True] + [False] * 47, "min_value": 25}
    await scheduler._apply_robot(hass, "sensor.robot1", schedule, 0)

    args = hass.services.async_call.await_args.args
    assert args[0] == "vacuum"
    assert args[1] == "return_to_base"


@pytest.mark.asyncio
async def test_apply_robot_slot_out_of_range_no_call() -> None:
    hass = _hass(_robot_state("cleaning"))
    schedule = {"intervals": [True] * 5, "min_value": 25}
    await scheduler._apply_robot(hass, "vacuum.robot1", schedule, 40)
    hass.services.async_call.assert_not_awaited()


@pytest.mark.asyncio
async def test_apply_robot_dock_service_exception_logged_not_raised() -> None:
    hass = _hass(_robot_state("cleaning"))
    hass.services.async_call = AsyncMock(side_effect=RuntimeError("boom"))
    schedule = {"intervals": [True] + [False] * 47, "min_value": 25}
    # Must not raise.
    await scheduler._apply_robot(hass, "vacuum.robot1", schedule, 0)


@pytest.mark.asyncio
async def test_apply_current_slot_dispatches_robot_via_apply_robot() -> None:
    """Integration check: the apply_current_slot loop routes atype='robot'
    through _apply_robot rather than the generic switch path."""
    hass = _hass(_robot_state("cleaning"))
    entry = _entry()
    hass.data[DOMAIN] = {
        "schedule": {
            "fetched_at": _fresh_ts(),
            "robot-1": {
                "appliance_type": "robot",
                "entity_id": "vacuum.robot1",
                "schedule": {"intervals": [True] + [False] * 47, "min_value": 25},
            },
        }
    }
    with patch.object(scheduler, "_current_slot", return_value=0):
        await scheduler.apply_current_slot(hass, entry)

    hass.services.async_call.assert_awaited_once()
    args = hass.services.async_call.await_args.args
    assert args[0] == "vacuum"
    assert args[1] == "return_to_base"


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
                    "setpoint_temps": [71.0] * 48,
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
    # Apply uses the refreshed cache's setpoint (71.0), not the stale cache's (71.5).
    payload = hass.services.async_call.await_args.args[2]
    assert payload == {"entity_id": "climate.living_room", "temperature": 71.0}


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


# ---------------------------------------------------------------------------
# Comfort-band failsafe — a scheduled OFF slot is overridden when the
# live indoor temperature has drifted outside the comfort band (the
# June 11 incident: house at 80°F at 8am, schedule kept commanding OFF).
# ---------------------------------------------------------------------------

def _override_cache(
    sched_mode: str = "cool",
    hvac_mode_schedule: list[str] | None = None,
    calibration: dict | None = None,
    indoor_temp_entity_id: str | None = None,
) -> dict:
    cache = _hvac_cache(
        setpoint=72.0,
        fan_mode_schedule=["auto"] * 48,
        hvac_mode_schedule=hvac_mode_schedule or ["OFF"] * 48,
        indoor_temp_entity_id=indoor_temp_entity_id,
    )
    schedule = cache["schedule"]["hvac-1"]["schedule"]
    schedule["mode"] = sched_mode
    if calibration is not None:
        schedule["calibration"] = calibration
    return cache


@pytest.mark.asyncio
async def test_comfort_override_cools_when_off_slot_and_indoor_above_band() -> None:
    """Scheduled OFF + indoor 80°F against a 74°F high band → the
    failsafe commands COOL at the band edge instead of applying OFF."""
    state = _climate_state("off", supports_range=False,
                           hvac_modes=["off", "cool"])
    state.attributes["current_temperature"] = 80.0
    hass = _hass(state)
    entry = _entry()
    hass.data[DOMAIN] = _override_cache()

    with patch.object(scheduler, "_current_slot", return_value=16):
        await scheduler.apply_current_slot(hass, entry)

    calls = hass.services.async_call.await_args_list
    mode_calls = [c for c in calls if c.args[1] == "set_hvac_mode"]
    temp_calls = [c for c in calls if c.args[1] == "set_temperature"]
    assert mode_calls and mode_calls[0].args[2]["hvac_mode"] == "cool"
    # Setpoint is the band EDGE (74.0), not the optimizer's 72.0 value.
    assert temp_calls and temp_calls[0].args[2]["temperature"] == 74.0

    # The override is the commanded truth for reconciler + verify.
    cached = scheduler.get_last_commanded(hass, "climate.living_room")
    assert cached["hvac_mode"] == "COOL"
    assert cached["setpoint"] == 74.0


@pytest.mark.asyncio
async def test_comfort_override_stays_off_when_indoor_in_band() -> None:
    """Indoor 73.5°F, inside the 74°F high band → no override; the OFF
    slot applies as scheduled (no active service calls)."""
    state = _climate_state("off", supports_range=False,
                           hvac_modes=["off", "cool"])
    state.attributes["current_temperature"] = 73.5
    hass = _hass(state)
    entry = _entry()
    hass.data[DOMAIN] = _override_cache()

    with patch.object(scheduler, "_current_slot", return_value=16):
        await scheduler.apply_current_slot(hass, entry)

    assert not [
        c for c in hass.services.async_call.await_args_list
        if c.args[1] in ("set_hvac_mode", "set_temperature")
    ]
    cached = scheduler.get_last_commanded(hass, "climate.living_room")
    assert cached["hvac_mode"] == "OFF"


@pytest.mark.asyncio
async def test_comfort_override_fires_the_moment_past_the_band_edge() -> None:
    """Comfort-first trigger: indoor 74.5°F just past a 74°F high band —
    no grace margin — commands COOL at the edge. (The release deadband +
    min-on-time, not a trigger margin, are what prevent short-cycling.)"""
    state = _climate_state("off", supports_range=False,
                           hvac_modes=["off", "cool"])
    state.attributes["current_temperature"] = 74.5
    hass = _hass(state)
    entry = _entry()
    hass.data[DOMAIN] = _override_cache()

    with patch.object(scheduler, "_current_slot", return_value=16):
        await scheduler.apply_current_slot(hass, entry)

    mode_calls = [
        c for c in hass.services.async_call.await_args_list
        if c.args[1] == "set_hvac_mode"
    ]
    assert mode_calls and mode_calls[0].args[2]["hvac_mode"] == "cool"
    cached = scheduler.get_last_commanded(hass, "climate.living_room")
    assert cached["hvac_mode"] == "COOL"
    assert cached["setpoint"] == 74.0


@pytest.mark.asyncio
async def test_comfort_override_inside_calibration_allowance_does_not_fire() -> None:
    """An OFF phase DURING calibration gets a wider allowance
    (`CALIBRATION_OVERSHOOT_F`, +2°F) rather than zero protection —
    indoor at high+1°F is still within that allowance, so no override."""
    state = _climate_state("off", supports_range=False,
                           hvac_modes=["off", "cool"])
    state.attributes["current_temperature"] = 75.0  # high(74) + 1
    hass = _hass(state)
    entry = _entry()
    phase_at_slot: list = [None] * 48
    phase_at_slot[22] = 2  # OFF drift phase covers this slot
    hass.data[DOMAIN] = _override_cache(
        calibration={"phase_at_slot": phase_at_slot},
    )

    with patch.object(scheduler, "_current_slot", return_value=22):
        await scheduler.apply_current_slot(hass, entry)

    assert not [
        c for c in hass.services.async_call.await_args_list
        if c.args[1] in ("set_hvac_mode", "set_temperature")
    ]


@pytest.mark.asyncio
async def test_comfort_override_past_calibration_allowance_still_fires() -> None:
    """Past the +2°F calibration allowance, the guard still engages —
    calibration relaxes the trigger, it doesn't disable the failsafe.
    (The backend's own +2°F comfort cap separately aborts the run.)"""
    state = _climate_state("off", supports_range=False,
                           hvac_modes=["off", "cool"])
    state.attributes["current_temperature"] = 77.0  # high(74) + 3
    hass = _hass(state)
    entry = _entry()
    phase_at_slot: list = [None] * 48
    phase_at_slot[22] = 2  # OFF drift phase covers this slot
    hass.data[DOMAIN] = _override_cache(
        calibration={"phase_at_slot": phase_at_slot},
    )

    with patch.object(scheduler, "_current_slot", return_value=22):
        await scheduler.apply_current_slot(hass, entry)

    mode_calls = [
        c for c in hass.services.async_call.await_args_list
        if c.args[1] == "set_hvac_mode"
    ]
    assert mode_calls and mode_calls[0].args[2]["hvac_mode"] == "cool"


@pytest.mark.asyncio
async def test_comfort_override_fires_outside_calibration_window() -> None:
    """Pre/post-window slots on a calibration day have phase=None —
    the failsafe DOES protect them (the passive-evening overheat)."""
    state = _climate_state("off", supports_range=False,
                           hvac_modes=["off", "cool"])
    state.attributes["current_temperature"] = 80.0
    hass = _hass(state)
    entry = _entry()
    phase_at_slot: list = [None] * 48
    phase_at_slot[22] = 2
    hass.data[DOMAIN] = _override_cache(
        calibration={"phase_at_slot": phase_at_slot},
    )

    with patch.object(scheduler, "_current_slot", return_value=40):  # 8pm
        await scheduler.apply_current_slot(hass, entry)

    mode_calls = [
        c for c in hass.services.async_call.await_args_list
        if c.args[1] == "set_hvac_mode"
    ]
    assert mode_calls and mode_calls[0].args[2]["hvac_mode"] == "cool"


@pytest.mark.asyncio
async def test_comfort_override_heats_when_below_band_in_heat_mode() -> None:
    """Heat-mode schedule + indoor below the low band → HEAT at the
    low band edge."""
    state = _climate_state("off", supports_range=False,
                           hvac_modes=["off", "heat"])
    state.attributes["current_temperature"] = 65.0
    hass = _hass(state)
    entry = _entry()
    hass.data[DOMAIN] = _override_cache(sched_mode="heat")

    with patch.object(scheduler, "_current_slot", return_value=16):
        await scheduler.apply_current_slot(hass, entry)

    calls = hass.services.async_call.await_args_list
    mode_calls = [c for c in calls if c.args[1] == "set_hvac_mode"]
    temp_calls = [c for c in calls if c.args[1] == "set_temperature"]
    assert mode_calls and mode_calls[0].args[2]["hvac_mode"] == "heat"
    assert temp_calls and temp_calls[0].args[2]["temperature"] == 70.0


@pytest.mark.asyncio
async def test_comfort_override_ignores_cool_breach_in_heat_mode() -> None:
    """Direction is mode-gated: a high-band breach in a heat-mode
    schedule must NOT trigger COOL (winter sun-warmed afternoon)."""
    state = _climate_state("off", supports_range=False,
                           hvac_modes=["off", "heat", "cool"])
    state.attributes["current_temperature"] = 80.0
    hass = _hass(state)
    entry = _entry()
    hass.data[DOMAIN] = _override_cache(sched_mode="heat")

    with patch.object(scheduler, "_current_slot", return_value=16):
        await scheduler.apply_current_slot(hass, entry)

    assert not [
        c for c in hass.services.async_call.await_args_list
        if c.args[1] in ("set_hvac_mode", "set_temperature")
    ]


@pytest.mark.asyncio
async def test_comfort_override_stops_active_heating_that_overshot_high_edge() -> None:
    """The fourth override kind: actively HEATing past the high edge is
    stopped with OFF (mirror of off_overcool, gated by mode == heat)."""
    state = _climate_state("heat", supports_range=False,
                           hvac_modes=["off", "heat"])
    state.attributes["current_temperature"] = 80.0  # above the 74°F high band
    hass = _hass(state)
    entry = _entry()
    hass.data[DOMAIN] = _override_cache(
        sched_mode="heat", hvac_mode_schedule=["HEAT"] * 48,
    )

    with patch.object(scheduler, "_current_slot", return_value=16):
        await scheduler.apply_current_slot(hass, entry)

    calls = hass.services.async_call.await_args_list
    mode_calls = [c for c in calls if c.args[1] == "set_hvac_mode"]
    temp_calls = [c for c in calls if c.args[1] == "set_temperature"]
    assert mode_calls and mode_calls[0].args[2]["hvac_mode"] == "off"
    assert not temp_calls
    latch = hass.data[DOMAIN]["comfort_latch"]["climate.living_room"]
    assert latch["active"] is True and latch["direction"] == "off_overheat"


@pytest.mark.asyncio
async def test_off_override_arms_a_mode_only_verification() -> None:
    """An OFF override must be verified like any other command.

    `_build_hvac_payload` returns None for an off unit, and the apply
    used to return right there — so the two OFF override kinds
    (`off_overcool` / `off_overheat`) were fire-and-forget against
    exactly the cloud-bridged units that drop commands. The verifier is
    now armed with the OVERRIDE's mode and no setpoint/fan (re-sending
    those would turn the unit back on)."""
    state = _climate_state("heat", supports_range=False,
                           hvac_modes=["off", "heat"])
    state.attributes["current_temperature"] = 80.0  # above the 74°F high band
    hass = _hass(state)
    entry = _entry()
    hass.data[DOMAIN] = _override_cache(
        sched_mode="heat", hvac_mode_schedule=["HEAT"] * 48,
    )

    with patch.object(scheduler, "_current_slot", return_value=16), \
         patch.object(scheduler, "async_call_later") as mock_later:
        await scheduler.apply_current_slot(hass, entry)

    mock_later.assert_called_once()
    assert mock_later.call_args.args[1] == scheduler._VERIFY_DELAY_SECONDS

    # Drive the armed callback and confirm it verifies the OVERRIDE
    # (OFF), not the schedule's HEAT — the unit is still reporting heat.
    hass.services.async_call.reset_mock()
    await mock_later.call_args.args[2](None)
    calls = [
        (c.args[1], c.args[2])
        for c in hass.services.async_call.await_args_list
    ]
    assert [s for s, _ in calls] == ["set_hvac_mode"]
    assert calls[0][1]["hvac_mode"] == "off"


@pytest.mark.asyncio
async def test_comfort_override_engages_on_temperature_only_schedule() -> None:
    """Eligibility is universal now — a schedule with NO hvac_mode_schedule
    at all (temperature-only opt-in) still gets the failsafe; it isn't
    limited to mode-optimized users."""
    state = _climate_state("cool", supports_range=False,
                           hvac_modes=["off", "cool"])
    state.attributes["current_temperature"] = 80.0
    hass = _hass(state)
    entry = _entry()
    hass.data[DOMAIN] = _override_cache()
    del hass.data[DOMAIN]["schedule"]["hvac-1"]["schedule"]["hvac_mode_schedule"]

    with patch.object(scheduler, "_current_slot", return_value=16):
        await scheduler.apply_current_slot(hass, entry)

    calls = hass.services.async_call.await_args_list
    temp_calls = [c for c in calls if c.args[1] == "set_temperature"]
    assert temp_calls and temp_calls[0].args[2]["temperature"] == 74.0


@pytest.mark.asyncio
async def test_comfort_override_wins_over_wake_within_same_apply() -> None:
    """Ordering lock: the temperature-only wake block runs BEFORE the
    comfort override and must not survive it. A unit reporting `off`
    under a temp-only cool schedule would normally be woken into COOL —
    but if indoor has already overcooled past the low edge, the override
    computed right after wake must win and keep it OFF instead (both
    happen to be no-ops against the entity's already-off state, so the
    proof is in the recorded commanded truth, not a service call: wake
    alone would have recorded COOL)."""
    state = _climate_state("off", supports_range=False,
                           hvac_modes=["off", "cool"])
    state.attributes["current_temperature"] = 68.0  # below the 70°F low band
    hass = _hass(state)
    entry = _entry()
    hass.data[DOMAIN] = _override_cache()
    del hass.data[DOMAIN]["schedule"]["hvac-1"]["schedule"]["hvac_mode_schedule"]

    with patch.object(scheduler, "_current_slot", return_value=16):
        await scheduler.apply_current_slot(hass, entry)

    # Both wake's COOL and the override's OFF are no-ops against an
    # already-off entity — no service calls either way. The ordering is
    # only observable via the commanded-truth cache.
    assert not hass.services.async_call.await_args_list
    cached = scheduler.get_last_commanded(hass, "climate.living_room")
    assert cached["hvac_mode"] == "OFF"
    assert cached["setpoint"] == 70.0


# ---------------------------------------------------------------------------
# Comfort watchdog — the 5-min closed-loop check that runs BETWEEN slot
# boundaries so a fast-drifting building doesn't sit out of band for most
# of a half-hour before the next :00/:30 apply looks.
# ---------------------------------------------------------------------------

def _old_since(minutes: int = 20):
    """A latch `since` far enough in the past that MIN_ON_SECONDS is met."""
    return datetime.now(timezone.utc) - timedelta(minutes=minutes)


@pytest.mark.asyncio
async def test_watchdog_cools_off_slot_that_drifted_out_of_band() -> None:
    """The core fix: a scheduled-OFF HVAC sitting above its high band is
    commanded back on at the band edge on a watchdog tick — no need to
    wait for the next slot boundary."""
    state = _climate_state("off", supports_range=False,
                           hvac_modes=["off", "cool"])
    state.attributes["current_temperature"] = 80.0
    hass = _hass(state)
    entry = _entry()
    hass.data[DOMAIN] = _override_cache()

    with patch.object(scheduler, "_current_slot", return_value=16):
        await scheduler.comfort_watchdog(hass, entry)

    calls = hass.services.async_call.await_args_list
    mode_calls = [c for c in calls if c.args[1] == "set_hvac_mode"]
    temp_calls = [c for c in calls if c.args[1] == "set_temperature"]
    assert mode_calls and mode_calls[0].args[2]["hvac_mode"] == "cool"
    assert temp_calls and temp_calls[0].args[2]["temperature"] == 74.0
    # Latch is engaged so subsequent ticks / the slot apply agree.
    latch = hass.data[DOMAIN]["comfort_latch"]["climate.living_room"]
    assert latch["active"] is True and latch["direction"] == "cool"


@pytest.mark.asyncio
async def test_watchdog_noop_when_in_band_and_not_latched() -> None:
    """An in-band OFF slot with no active override must NOT issue any
    service call — the watchdog can't re-command OFF every 5 minutes."""
    state = _climate_state("off", supports_range=False,
                           hvac_modes=["off", "cool"])
    state.attributes["current_temperature"] = 72.0
    hass = _hass(state)
    entry = _entry()
    hass.data[DOMAIN] = _override_cache()

    with patch.object(scheduler, "_current_slot", return_value=16):
        await scheduler.comfort_watchdog(hass, entry)

    assert not hass.services.async_call.await_args_list


@pytest.mark.asyncio
async def test_watchdog_holds_override_before_min_on_even_if_recovered() -> None:
    """Latched for only 5 min: even though the room is back at the edge,
    the watchdog keeps conditioning (short-cycle guard) rather than
    releasing to the scheduled OFF."""
    state = _climate_state("cool", supports_range=False,
                           hvac_modes=["off", "cool"])
    state.attributes["current_temperature"] = 74.0  # back at the edge
    hass = _hass(state)
    entry = _entry()
    hass.data[DOMAIN] = _override_cache()
    hass.data[DOMAIN]["comfort_latch"] = {
        "climate.living_room": {
            "active": True, "direction": "cool", "since": _old_since(5),
        }
    }

    with patch.object(scheduler, "_current_slot", return_value=16):
        await scheduler.comfort_watchdog(hass, entry)

    calls = hass.services.async_call.await_args_list
    # Held: still driving the band-edge setpoint, and NOT released to OFF.
    # (The unit already reports 'cool', so set_hvac_mode is idempotently
    # skipped — the tell is the retained latch + no OFF command.)
    off_calls = [
        c for c in calls
        if c.args[1] == "set_hvac_mode" and c.args[2]["hvac_mode"] == "off"
    ]
    temp_calls = [c for c in calls if c.args[1] == "set_temperature"]
    assert not off_calls
    assert temp_calls and temp_calls[0].args[2]["temperature"] == 74.0
    assert hass.data[DOMAIN]["comfort_latch"].get("climate.living_room")


@pytest.mark.asyncio
async def test_watchdog_releases_to_off_once_recovered_and_min_on_met() -> None:
    """Latched >10 min and the room is back inside by the release margin
    → release: the watchdog hands the unit back to the scheduled OFF and
    clears the latch."""
    state = _climate_state("cool", supports_range=False,
                           hvac_modes=["off", "cool"])
    state.attributes["current_temperature"] = 72.0  # inside by >1°F
    hass = _hass(state)
    entry = _entry()
    hass.data[DOMAIN] = _override_cache()
    hass.data[DOMAIN]["comfort_latch"] = {
        "climate.living_room": {
            "active": True, "direction": "cool", "since": _old_since(20),
        }
    }

    with patch.object(scheduler, "_current_slot", return_value=16):
        await scheduler.comfort_watchdog(hass, entry)

    mode_calls = [
        c for c in hass.services.async_call.await_args_list
        if c.args[1] == "set_hvac_mode"
    ]
    # Released → the scheduled OFF is commanded (unit was reporting cool).
    assert mode_calls and mode_calls[0].args[2]["hvac_mode"] == "off"
    assert "climate.living_room" not in hass.data[DOMAIN].get("comfort_latch", {})


@pytest.mark.asyncio
async def test_watchdog_respects_master_pause() -> None:
    """A globally-paused user gets no watchdog action even while out of
    band — pause means the integration leaves the unit under manual
    control."""
    state = _climate_state("off", supports_range=False,
                           hvac_modes=["off", "cool"])
    state.attributes["current_temperature"] = 85.0
    hass = _hass(state)
    entry = _entry()
    cache = _override_cache()
    cache["schedule"]["optimization_enabled"] = False
    hass.data[DOMAIN] = cache

    with patch.object(scheduler, "_current_slot", return_value=16):
        await scheduler.comfort_watchdog(hass, entry)

    assert not hass.services.async_call.await_args_list


@pytest.mark.asyncio
async def test_watchdog_corrects_active_cooling_slot_that_overshot_high_edge() -> None:
    """An already-active COOL slot is NOT exempt: if indoor is still out
    of band, the watchdog re-drives the setpoint to the band edge instead
    of leaving the schedule's (looser) value in place. This is the office
    incident (2026-08-27) — a COOL slot the unit ignored, with the old
    watchdog hard-ineligible on any non-OFF slot."""
    state = _climate_state("cool", supports_range=False,
                           hvac_modes=["off", "cool"])
    state.attributes["current_temperature"] = 80.0
    hass = _hass(state)
    entry = _entry()
    hass.data[DOMAIN] = _override_cache(hvac_mode_schedule=["COOL"] * 48)

    with patch.object(scheduler, "_current_slot", return_value=16):
        await scheduler.comfort_watchdog(hass, entry)

    temp_calls = [
        c for c in hass.services.async_call.await_args_list
        if c.args[1] == "set_temperature"
    ]
    assert temp_calls and temp_calls[0].args[2]["temperature"] == 74.0
    latch = hass.data[DOMAIN]["comfort_latch"]["climate.living_room"]
    assert latch["active"] is True and latch["direction"] == "cool"


@pytest.mark.asyncio
async def test_watchdog_stops_active_cooling_that_overshot_past_low_edge() -> None:
    """A COOL slot that overcooled PAST the low edge is commanded OFF —
    the new off_overcool kind, exercised at the watchdog cadence."""
    state = _climate_state("cool", supports_range=False,
                           hvac_modes=["off", "cool"])
    state.attributes["current_temperature"] = 68.0  # below the 70°F low band
    hass = _hass(state)
    entry = _entry()
    hass.data[DOMAIN] = _override_cache(hvac_mode_schedule=["COOL"] * 48)

    with patch.object(scheduler, "_current_slot", return_value=16):
        await scheduler.comfort_watchdog(hass, entry)

    calls = hass.services.async_call.await_args_list
    mode_calls = [c for c in calls if c.args[1] == "set_hvac_mode"]
    temp_calls = [c for c in calls if c.args[1] == "set_temperature"]
    assert mode_calls and mode_calls[0].args[2]["hvac_mode"] == "off"
    assert not temp_calls
    latch = hass.data[DOMAIN]["comfort_latch"]["climate.living_room"]
    assert latch["active"] is True and latch["direction"] == "off_overcool"


# ---------------------------------------------------------------------------
# Aux indoor-sensor fallback (US-CBE-012) — units that can't self-report
# current_temperature (Tuya/IR-blaster/Generic Thermostat) get the guard's
# protection via their configured indoor_temp_entity_id instead of none.
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_comfort_override_uses_aux_sensor_when_climate_current_temperature_missing() -> None:
    """Climate entity reports no current_temperature at all (the common
    Tuya/IR-blaster shape) but the appliance has a configured aux indoor
    sensor reading 79.5°F against a 76°F high band — the guard still
    engages using the aux reading instead of releasing blind."""
    climate_state = _climate_state("off", supports_range=False,
                                   hvac_modes=["off", "cool"])
    aux_state = MagicMock()
    aux_state.state = "79.5"
    hass = _multi_hvac_hass({
        "climate.living_room": climate_state,
        "sensor.aux_temp": aux_state,
    })
    entry = _entry()
    cache = _override_cache(indoor_temp_entity_id="sensor.aux_temp")
    cache["schedule"]["hvac-1"]["schedule"]["high_temps"] = [76.0] * 48
    hass.data[DOMAIN] = cache

    with patch.object(scheduler, "_current_slot", return_value=16):
        await scheduler.apply_current_slot(hass, entry)

    calls = hass.services.async_call.await_args_list
    mode_calls = [c for c in calls if c.args[1] == "set_hvac_mode"]
    temp_calls = [c for c in calls if c.args[1] == "set_temperature"]
    assert mode_calls and mode_calls[0].args[2]["hvac_mode"] == "cool"
    assert temp_calls and temp_calls[0].args[2]["temperature"] == 76.0
    cached = scheduler.get_last_commanded(hass, "climate.living_room")
    assert cached["hvac_mode"] == "COOL"
    assert cached["setpoint"] == 76.0


@pytest.mark.asyncio
async def test_comfort_override_releases_when_climate_and_aux_both_unavailable() -> None:
    """Both the climate entity's current_temperature AND the configured
    aux sensor fail to produce a usable value — the guard still releases
    conservatively (no override, no latch) rather than commanding blind."""
    climate_state = _climate_state("off", supports_range=False,
                                   hvac_modes=["off", "cool"])
    aux_state = MagicMock()
    aux_state.state = "unavailable"
    hass = _multi_hvac_hass({
        "climate.living_room": climate_state,
        "sensor.aux_temp": aux_state,
    })
    entry = _entry()
    hass.data[DOMAIN] = _override_cache(indoor_temp_entity_id="sensor.aux_temp")

    with patch.object(scheduler, "_current_slot", return_value=16):
        await scheduler.apply_current_slot(hass, entry)

    assert not [
        c for c in hass.services.async_call.await_args_list
        if c.args[1] in ("set_hvac_mode", "set_temperature")
    ]
    assert "climate.living_room" not in hass.data[DOMAIN].get("comfort_latch", {})


@pytest.mark.asyncio
async def test_comfort_override_aux_engage_logs_which_source_drove_it(caplog) -> None:
    """Field debugging needs to tell which sensor drove an override — a
    WARNING names the aux entity on the tick the override engages."""
    import logging
    caplog.set_level(logging.WARNING, logger="custom_components.hungry_machines.scheduler")

    climate_state = _climate_state("off", supports_range=False,
                                   hvac_modes=["off", "cool"])
    aux_state = MagicMock()
    aux_state.state = "79.5"
    hass = _multi_hvac_hass({
        "climate.living_room": climate_state,
        "sensor.aux_temp": aux_state,
    })
    entry = _entry()
    cache = _override_cache(indoor_temp_entity_id="sensor.aux_temp")
    cache["schedule"]["hvac-1"]["schedule"]["high_temps"] = [76.0] * 48
    hass.data[DOMAIN] = cache

    with patch.object(scheduler, "_current_slot", return_value=16):
        await scheduler.apply_current_slot(hass, entry)

    assert any(
        rec.levelno >= logging.WARNING
        and "aux sensor" in rec.message
        and "sensor.aux_temp" in rec.message
        for rec in caplog.records
    )


@pytest.mark.asyncio
async def test_fetch_caches_indoor_temp_entity_id_when_configured() -> None:
    """US-CBE-003 added indoor_temp_entity_id to the /schedules entities
    projection; the schedule cache must carry it through for the aux
    fallback, and stay None when the appliance has none configured."""
    hass = _hass()
    entry = _entry()
    body = _schedules_body()
    body["appliances"][0]["entities"]["indoor_temp_entity_id"] = "sensor.aux_temp"
    with patch.object(
        scheduler.api, "get_schedules", AsyncMock(return_value=body)
    ):
        cache = await scheduler.fetch_today_schedule(hass, entry)

    assert cache["hvac-1"]["indoor_temp_entity_id"] == "sensor.aux_temp"
    # The second fixture appliance has no aux sensor configured.
    assert cache["ev-1"]["indoor_temp_entity_id"] is None


# ---------------------------------------------------------------------------
# NO SILENT SKIPS (office incident, 2026-08-27) — every early-return in
# _comfort_band_override / comfort_watchdog that could explain a stuck
# out-of-band unit now logs an attributable, rate-limited WARNING.
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_no_silent_skip_warns_once_on_unusable_sensor_then_rate_limits(caplog) -> None:
    """A climate entity with no usable current_temperature used to exit
    _comfort_band_override with zero log trail — exactly the office
    incident's suspected mechanism. Now it logs once, and a second
    consecutive tick with the SAME stuck condition doesn't repeat it."""
    import logging
    caplog.set_level(logging.WARNING, logger="custom_components.hungry_machines.scheduler")

    state = _climate_state("off", supports_range=False,
                           hvac_modes=["off", "cool"])
    # No current_temperature attribute at all.
    hass = _hass(state)
    entry = _entry()
    hass.data[DOMAIN] = _override_cache()

    with patch.object(scheduler, "_current_slot", return_value=16):
        await scheduler.comfort_watchdog(hass, entry)
        await scheduler.comfort_watchdog(hass, entry)

    silent_warnings = [
        rec for rec in caplog.records
        if rec.levelno >= logging.WARNING
        and "no usable indoor temperature" in rec.message
    ]
    assert len(silent_warnings) == 1


@pytest.mark.asyncio
async def test_no_silent_skip_warns_on_sched_mode_gate(caplog) -> None:
    """A schedule mode outside {cool, heat, auto} silently blocks every
    override kind even while indoor is out of band — now attributable."""
    import logging
    caplog.set_level(logging.WARNING, logger="custom_components.hungry_machines.scheduler")

    state = _climate_state("off", supports_range=False,
                           hvac_modes=["off", "cool"])
    state.attributes["current_temperature"] = 80.0
    hass = _hass(state)
    entry = _entry()
    hass.data[DOMAIN] = _override_cache(sched_mode="")

    with patch.object(scheduler, "_current_slot", return_value=16):
        await scheduler.apply_current_slot(hass, entry)

    assert not [
        c for c in hass.services.async_call.await_args_list
        if c.args[1] in ("set_hvac_mode", "set_temperature")
    ]
    assert any(
        rec.levelno >= logging.WARNING and "sched_mode" in rec.message
        for rec in caplog.records
    )


@pytest.mark.asyncio
async def test_no_silent_skip_warns_on_missing_band_arrays(caplog) -> None:
    """A schedule with neither high_temps nor low_temps can't be checked
    at all — a configuration problem worth surfacing, not silence."""
    import logging
    caplog.set_level(logging.WARNING, logger="custom_components.hungry_machines.scheduler")

    state = _climate_state("off", supports_range=False,
                           hvac_modes=["off", "cool"])
    state.attributes["current_temperature"] = 80.0
    hass = _hass(state)
    entry = _entry()
    hass.data[DOMAIN] = _override_cache()
    schedule = hass.data[DOMAIN]["schedule"]["hvac-1"]["schedule"]
    del schedule["high_temps"]
    del schedule["low_temps"]

    with patch.object(scheduler, "_current_slot", return_value=16):
        await scheduler.apply_current_slot(hass, entry)

    assert any(
        rec.levelno >= logging.WARNING and "comfort-band arrays" in rec.message
        for rec in caplog.records
    )


@pytest.mark.asyncio
async def test_no_silent_skip_warns_when_paused_and_out_of_band(caplog) -> None:
    """Pause is a deliberate user choice, not a bug — the watchdog is
    right to do nothing. But it should say why instead of going quiet."""
    import logging
    caplog.set_level(logging.WARNING, logger="custom_components.hungry_machines.scheduler")

    state = _climate_state("off", supports_range=False,
                           hvac_modes=["off", "cool"])
    state.attributes["current_temperature"] = 85.0
    hass = _hass(state)
    entry = _entry()
    cache = _override_cache()
    cache["schedule"]["optimization_enabled"] = False
    hass.data[DOMAIN] = cache

    with patch.object(scheduler, "_current_slot", return_value=16):
        await scheduler.comfort_watchdog(hass, entry)

    assert not hass.services.async_call.await_args_list
    assert any(
        rec.levelno >= logging.WARNING and "paused" in rec.message
        for rec in caplog.records
    )


# ---------------------------------------------------------------------------
# Temperature-only wake + optimization pause toggle
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_temperature_only_schedule_wakes_off_unit() -> None:
    """A unit reporting `off` under a temperature-only schedule (no
    hvac_mode_schedule, schedule mode 'cool') must be woken into COOL
    so the plan's setpoints can act — previously it stayed off forever
    because the payload builder skips off-mode entities."""
    state = _climate_state("off", supports_range=False,
                           hvac_modes=["off", "cool"])
    hass = _hass(state)
    entry = _entry()
    cache = _hvac_cache(setpoint=74.0)          # temperature-only
    cache["schedule"]["hvac-1"]["schedule"]["mode"] = "cool"
    hass.data[DOMAIN] = cache

    with patch.object(scheduler, "_current_slot", return_value=28):
        await scheduler.apply_current_slot(hass, entry)

    calls = hass.services.async_call.await_args_list
    mode_calls = [c for c in calls if c.args[1] == "set_hvac_mode"]
    temp_calls = [c for c in calls if c.args[1] == "set_temperature"]
    assert mode_calls and mode_calls[0].args[2]["hvac_mode"] == "cool"
    assert temp_calls and temp_calls[0].args[2]["temperature"] == 74.0
    cached = scheduler.get_last_commanded(hass, "climate.living_room")
    assert cached["hvac_mode"] == "COOL"


@pytest.mark.asyncio
async def test_temperature_only_no_wake_without_schedule_mode() -> None:
    """No schedule `mode` field → preserve the legacy respect-the-user
    behavior: an off unit stays off."""
    hass = _hass(_climate_state("off", supports_range=False,
                                hvac_modes=["off", "cool"]))
    entry = _entry()
    hass.data[DOMAIN] = _hvac_cache(setpoint=74.0)  # no "mode" key

    with patch.object(scheduler, "_current_slot", return_value=28):
        await scheduler.apply_current_slot(hass, entry)
    hass.services.async_call.assert_not_awaited()


@pytest.mark.asyncio
async def test_pause_toggle_skips_all_applies() -> None:
    """optimization_enabled=false in the cache → nothing is applied:
    no wake, no setpoint, no failsafe."""
    state = _climate_state("off", supports_range=False,
                           hvac_modes=["off", "cool"])
    state.attributes["current_temperature"] = 85.0   # even out-of-band
    hass = _hass(state)
    entry = _entry()
    cache = _hvac_cache(setpoint=74.0, hvac_mode_schedule=["OFF"] * 48)
    cache["schedule"]["hvac-1"]["schedule"]["mode"] = "cool"
    cache["schedule"]["optimization_enabled"] = False
    hass.data[DOMAIN] = cache

    with patch.object(scheduler, "_current_slot", return_value=28):
        await scheduler.apply_current_slot(hass, entry)
    hass.services.async_call.assert_not_awaited()
    assert scheduler.get_last_commanded(hass, "climate.living_room") is None


@pytest.mark.asyncio
async def test_fetch_stores_optimization_enabled_flag() -> None:
    """fetch_today_schedule caches the response's master switch;
    missing key (older API) defaults to enabled."""
    hass = _hass()
    entry = _entry()
    body = _schedules_body()
    body["optimization_enabled"] = False
    with patch.object(scheduler.api, "get_schedules",
                      new=AsyncMock(return_value=body)):
        cache = await scheduler.fetch_today_schedule(hass, entry)
    assert cache["optimization_enabled"] is False

    with patch.object(scheduler.api, "get_schedules",
                      new=AsyncMock(return_value=_schedules_body())):
        cache = await scheduler.fetch_today_schedule(hass, entry)
    assert cache["optimization_enabled"] is True


# ---------------------------------------------------------------------------
# US-MHVAC-016 — per-appliance reading push + per-entity apply loop.
# Two HVAC appliances under one user must drive their own climate entities
# independently and gate on their own optimization_enabled flag.
# ---------------------------------------------------------------------------


def _multi_hvac_hass(states: dict) -> MagicMock:
    """Build a hass fake where `hass.states.get(entity_id)` returns the
    right state per entity (vs the single-entity `_hass` helper above)."""
    hass = MagicMock()
    hass.data = {}
    hass.services = MagicMock()
    hass.services.async_call = AsyncMock()
    hass.states = MagicMock()
    hass.states.get = MagicMock(side_effect=lambda eid: states.get(eid))
    return hass


def _multi_hvac_cache(
    *,
    living_setpoint: float = 70.0,
    bedroom_setpoint: float = 68.0,
    living_enabled: bool = True,
    bedroom_enabled: bool = True,
) -> dict:
    return {
        "schedule": {
            "fetched_at": _fresh_ts(),
            "optimization_enabled": True,
            "hvac-living": {
                "appliance_type": "hvac",
                "entity_id": "climate.living_room",
                "name": "Living Room",
                "schedule": {
                    "setpoint_temps": [living_setpoint] * 48,
                    "high_temps": [74.0] * 48,
                    "low_temps": [70.0] * 48,
                    "mode": "cool",
                },
                "optimization_enabled": living_enabled,
            },
            "hvac-bedroom": {
                "appliance_type": "hvac",
                "entity_id": "climate.bedroom",
                "name": "Bedroom",
                "schedule": {
                    "setpoint_temps": [bedroom_setpoint] * 48,
                    "high_temps": [72.0] * 48,
                    "low_temps": [66.0] * 48,
                    "mode": "cool",
                },
                "optimization_enabled": bedroom_enabled,
            },
        }
    }


@pytest.mark.asyncio
async def test_apply_two_hvacs_each_drives_its_own_climate_entity() -> None:
    """Two HVAC appliances → two `climate.set_temperature` calls, each
    targeting its own entity_id with its own optimizer setpoint."""
    living = _climate_state("cool", supports_range=False)
    bedroom = _climate_state("cool", supports_range=False)
    hass = _multi_hvac_hass({
        "climate.living_room": living,
        "climate.bedroom": bedroom,
    })
    entry = _entry()
    hass.data[DOMAIN] = _multi_hvac_cache(
        living_setpoint=72.0, bedroom_setpoint=68.0,
    )
    with patch.object(scheduler, "_current_slot", return_value=28):
        await scheduler.apply_current_slot(hass, entry)

    temp_calls = [
        c for c in hass.services.async_call.await_args_list
        if c.args[1] == "set_temperature"
    ]
    assert len(temp_calls) == 2
    payloads = {c.args[2]["entity_id"]: c.args[2] for c in temp_calls}
    assert payloads["climate.living_room"]["temperature"] == 72.0
    assert payloads["climate.bedroom"]["temperature"] == 68.0


@pytest.mark.asyncio
async def test_apply_skips_paused_appliance_but_runs_enabled_sibling() -> None:
    """Per-appliance pause: the disabled HVAC sees no service calls; the
    other HVAC still applies. Master flag stays True so the run isn't
    short-circuited at the top."""
    living = _climate_state("cool", supports_range=False)
    bedroom = _climate_state("cool", supports_range=False)
    hass = _multi_hvac_hass({
        "climate.living_room": living,
        "climate.bedroom": bedroom,
    })
    entry = _entry()
    hass.data[DOMAIN] = _multi_hvac_cache(
        living_setpoint=72.0, bedroom_setpoint=68.0,
        living_enabled=True, bedroom_enabled=False,
    )
    with patch.object(scheduler, "_current_slot", return_value=28):
        await scheduler.apply_current_slot(hass, entry)

    temp_calls = [
        c for c in hass.services.async_call.await_args_list
        if c.args[1] == "set_temperature"
    ]
    assert len(temp_calls) == 1
    assert temp_calls[0].args[2]["entity_id"] == "climate.living_room"
    # The paused appliance must not have been driven at all.
    assert scheduler.get_last_commanded(hass, "climate.bedroom") is None


@pytest.mark.asyncio
async def test_fetch_stores_per_appliance_optimization_enabled() -> None:
    """fetch_today_schedule caches the per-appliance optimization_enabled
    flag from each /schedules entry (US-MHVAC-010); missing key defaults
    to True so an older API never bricks a single unit."""
    hass = _hass()
    entry = _entry()
    body = _schedules_body()
    body["appliances"][0]["optimization_enabled"] = False
    # Second entry deliberately omits the flag → defaults to enabled.
    with patch.object(scheduler.api, "get_schedules",
                      new=AsyncMock(return_value=body)):
        cache = await scheduler.fetch_today_schedule(hass, entry)
    assert cache["hvac-1"]["optimization_enabled"] is False
    assert cache["ev-1"]["optimization_enabled"] is True


@pytest.mark.asyncio
async def test_apply_hvac_log_includes_appliance_name() -> None:
    """The apply log line for HVAC must name the appliance alongside the
    entity so multi-unit installations are disambiguable in HA logs."""
    hass = _hass(_climate_state("cool", supports_range=False))
    entry = _entry()
    cache = _hvac_cache(setpoint=72.0)
    cache["schedule"]["hvac-1"]["name"] = "Bedroom"
    hass.data[DOMAIN] = cache
    with patch.object(scheduler, "_current_slot", return_value=30), \
         patch.object(scheduler, "_LOGGER") as mock_log:
        await scheduler.apply_current_slot(hass, entry)
    apply_call = next(
        c for c in mock_log.info.call_args_list
        if "HVAC apply" in c.args[0]
    )
    fmt = apply_call.args[0]
    formatted = fmt % apply_call.args[1:]
    assert "Bedroom" in formatted
    assert "climate.living_room" in formatted


@pytest.mark.asyncio
async def test_apply_hvac_skips_fan_when_entity_has_no_matching_tier() -> None:
    """An auto-only central thermostat (fan_modes=["Auto", "On"]) has
    no label that matches canonical 'low'/'high'. The integration must
    skip set_fan_mode entirely rather than send a value the entity
    would reject — the delivery-point half of the fan-capability gate
    (the backend also suppresses fan schedules for such units, but a
    stale schedule blob must stay safe too)."""
    hass = _hass(_climate_state(
        "cool", supports_range=False,
        fan_modes=["Auto", "On"],
    ))
    entry = _entry()
    hass.data[DOMAIN] = _hvac_cache(
        setpoint=72.0, fan_mode_schedule=["low"] * 48,
    )
    with patch.object(scheduler, "_current_slot", return_value=28):
        await scheduler.apply_current_slot(hass, entry)

    services = [c.args[1] for c in hass.services.async_call.await_args_list]
    assert services == ["set_temperature"], (
        f"expected only set_temperature, got {services}"
    )
