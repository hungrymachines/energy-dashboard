"""Health log lines: news only, so 5-minute callers cannot flood the log."""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from hungry_machines import health, readings, scheduler
from hungry_machines.const import DOMAIN


def _hass(states: dict | None = None) -> MagicMock:
    hass = MagicMock()
    hass.data = {}
    hass.states.get = MagicMock(side_effect=lambda eid: (states or {}).get(eid))
    return hass


def _messages(caplog, level: int) -> list[str]:
    return [r.getMessage() for r in caplog.records if r.levelno == level]


def test_report_logs_only_on_change(caplog) -> None:
    hass = _hass()
    with caplog.at_level(logging.INFO):
        health.report(hass, "x", True, "good")
        health.report(hass, "x", True, "good")
        health.report(hass, "x", False, "bad")
        health.report(hass, "x", False, "bad")
        health.report(hass, "x", True, "good")
    assert _messages(caplog, logging.INFO) == [
        "Hungry Machines: good", "Hungry Machines: good",
    ]
    assert _messages(caplog, logging.WARNING) == ["Hungry Machines: bad"]


def test_report_warns_again_after_a_day_of_failure(caplog) -> None:
    hass = _hass()
    with caplog.at_level(logging.WARNING):
        health.report(hass, "x", False, "bad")
        hass.data[DOMAIN]["health"]["x"]["warned_at"] = (
            datetime.now(timezone.utc) - timedelta(hours=25)
        )
        health.report(hass, "x", False, "bad")
    assert len(_messages(caplog, logging.WARNING)) == 2


def test_forget_lets_the_next_good_report_log(caplog) -> None:
    hass = _hass()
    with caplog.at_level(logging.INFO):
        health.report(hass, "x", True, "good")
        health.forget(hass, "x")
        health.report(hass, "x", True, "good")
    assert len(_messages(caplog, logging.INFO)) == 2


@pytest.mark.asyncio
async def test_flush_splits_an_oversized_bucket_into_api_sized_batches(caplog) -> None:
    """Hours of failed uploads leave more than the API takes in one POST."""
    hass = _hass()
    hass.data[DOMAIN] = {"readings_buffer": {"home": [{"n": i} for i in range(250)]}}
    post = AsyncMock(return_value=True)
    with patch.object(readings.api, "post_home_readings", post), \
            caplog.at_level(logging.INFO):
        sent = await readings.flush_readings(hass, MagicMock())
    assert sent == 250
    assert [len(c.args[2]) for c in post.await_args_list] == [100, 100, 50]
    assert hass.data[DOMAIN]["readings_buffer"]["home"] == []
    assert "Hungry Machines: uploaded readings this hour: HVAC readings 250" in (
        _messages(caplog, logging.INFO)
    )


@pytest.mark.asyncio
async def test_flush_keeps_what_failed_and_warns(caplog) -> None:
    hass = _hass()
    hass.data[DOMAIN] = {"readings_buffer": {"home": [{"n": i} for i in range(250)]}}
    post = AsyncMock(side_effect=[True, False])
    with patch.object(readings.api, "post_home_readings", post), \
            caplog.at_level(logging.WARNING):
        sent = await readings.flush_readings(hass, MagicMock())
    assert sent == 100
    assert hass.data[DOMAIN]["readings_buffer"]["home"][0] == {"n": 100}
    assert any("150 readings are waiting" in m for m in _messages(caplog, logging.WARNING))


@pytest.mark.asyncio
async def test_flush_names_the_appliance_from_the_cache(caplog) -> None:
    hass = _hass()
    hass.data[DOMAIN] = {
        "readings_buffer": {"a-1": [{"n": 1}]},
        "appliances_cache": {"appliances": [{"id": "a-1", "name": "Roof array"}]},
    }
    with patch.object(readings.api, "post_appliance_readings", AsyncMock(return_value=True)), \
            caplog.at_level(logging.INFO):
        await readings.flush_readings(hass, MagicMock())
    assert any("Roof array 1" in m for m in _messages(caplog, logging.INFO))


def test_buffer_drops_oldest_past_the_cap_and_warns(caplog) -> None:
    hass = _hass()
    bucket = [{"n": i} for i in range(readings._MAX_BUFFERED_READINGS)]
    hass.data[DOMAIN] = {"readings_buffer": {"home": bucket}}
    with caplog.at_level(logging.WARNING):
        readings._append(hass, "home", {"n": "new"})
    assert len(bucket) == readings._MAX_BUFFERED_READINGS
    assert bucket[0] == {"n": 1}
    assert bucket[-1] == {"n": "new"}
    assert any("dropped" in m for m in _messages(caplog, logging.WARNING))


@pytest.mark.parametrize(
    ("thermostat", "plan", "expected"),
    [
        ("heat_cool", "heat", "is set to Auto but today's plan is for Heat"),
        ("auto", "cool", "is set to Auto but today's plan is for Cool"),
        ("cool", "heat", "is set to Cool but today's plan is for Heat"),
        ("heat", "cool", "is set to Heat but today's plan is for Cool"),
        ("off", "cool", "is set to Off but today's plan is for Cool"),
    ],
)
def test_mode_conflict_logs_an_error(caplog, thermostat, plan, expected) -> None:
    state = MagicMock()
    state.state = thermostat
    hass = _hass({"climate.a": state})
    schedule = {"mode": plan}
    overruling = scheduler._overruling_mode(hass, "climate.a", schedule)
    with caplog.at_level(logging.WARNING):
        scheduler._report_thermostat_mode(
            hass, "climate.a", "Attic", overruling, thermostat, plan,
        )
    errors = _messages(caplog, logging.ERROR)
    assert len(errors) == 1 and expected in errors[0]


@pytest.mark.parametrize(
    ("thermostat", "schedule"),
    [
        ("heat", {"mode": "heat"}),
        ("cool", {"mode": "cool"}),
        ("heat", {"mode": "off"}),
        ("heat", {}),
        ("unavailable", {"mode": "cool"}),
        # A plan that switches the mode itself cannot conflict.
        ("heat", {"mode": "cool", "hvac_mode_schedule": ["COOL"] * 48}),
        ("off", {"mode": "cool", "hvac_mode_schedule": ["OFF"] * 48}),
    ],
)
def test_no_conflict(thermostat, schedule) -> None:
    state = MagicMock()
    state.state = thermostat
    hass = _hass({"climate.a": state})
    assert scheduler._overruling_mode(hass, "climate.a", schedule) is None


def _unit(mode: str = "heat", indoor: float = 70.0, modes=None, target=70.0) -> MagicMock:
    state = MagicMock()
    state.state = mode
    state.attributes = {
        "current_temperature": indoor,
        "temperature": target,
        "hvac_modes": ["off", "heat", "cool"] if modes is None else modes,
    }
    hass = _hass({"climate.a": state})
    hass.services.async_call = AsyncMock()
    return hass


_COOL_PLAN = {
    "mode": "cool",
    "setpoint_temps": [78.0] * 48,
    "low_temps": [67.0] * 48,
    "high_temps": [78.0] * 48,
}


def _service_data(hass: MagicMock, service: str) -> list[dict]:
    return [
        c.args[2] for c in hass.services.async_call.await_args_list
        if c.args[:2] == ("climate", service)
    ]


@pytest.mark.parametrize("indoor", [60.0, 72.0, 85.0])
@pytest.mark.asyncio
async def test_conflict_sends_nothing_even_past_the_band(indoor) -> None:
    """The thermostat wins a conflict, so plan and guard both stay out,
    and the record stops readings claiming a command we never made."""
    hass = _unit("heat", indoor)
    scheduler._record_last_commanded(
        hass, "climate.a", hvac_mode="HEAT", fan_mode=None, setpoint=70.0,
    )
    await scheduler._apply_hvac(hass, "climate.a", _COOL_PLAN, 10)
    hass.services.async_call.assert_not_awaited()
    assert scheduler.get_last_commanded(hass, "climate.a")["setpoint"] is None


@pytest.mark.asyncio
async def test_matching_mode_still_gets_the_setpoint() -> None:
    hass = _unit("heat")
    plan = {**_COOL_PLAN, "mode": "heat", "setpoint_temps": [70.0] * 48}
    await scheduler._apply_hvac(hass, "climate.a", plan, 10)
    assert _service_data(hass, "set_temperature")


def test_no_setpoint_ever_goes_below_the_floor() -> None:
    state = MagicMock()
    state.state = "heat"
    state.attributes = {"min_temp": 40.0, "max_temp": 90.0}
    payload = scheduler._build_hvac_payload("climate.a", state, 44.0)
    assert payload["temperature"] == 50.0


@pytest.mark.parametrize("mode", ["off", "cool"])
@pytest.mark.asyncio
async def test_freeze_floor_overrules_the_thermostat(caplog, mode) -> None:
    hass = _unit(mode, indoor=49.0)
    with caplog.at_level(logging.ERROR):
        held = await scheduler._hold_freeze_floor(hass, "climate.a", "Attic")
    assert held is True
    assert {"entity_id": "climate.a", "hvac_mode": "heat"} in _service_data(hass, "set_hvac_mode")
    assert _service_data(hass, "set_temperature")[0]["temperature"] == 52.0
    assert any("freeze floor" in m for m in _messages(caplog, logging.ERROR))


@pytest.mark.asyncio
async def test_freeze_floor_holds_until_release_then_restores_the_mode() -> None:
    hass = _unit("off", indoor=49.0)
    await scheduler._hold_freeze_floor(hass, "climate.a", "Attic")
    state = hass.states.get("climate.a")
    state.state = "heat"

    state.attributes["current_temperature"] = 51.0
    assert await scheduler._hold_freeze_floor(hass, "climate.a", "Attic") is True

    state.attributes["current_temperature"] = 52.0
    hass.services.async_call.reset_mock()
    assert await scheduler._hold_freeze_floor(hass, "climate.a", "Attic") is False
    assert {"entity_id": "climate.a", "hvac_mode": "off"} in _service_data(hass, "set_hvac_mode")


@pytest.mark.asyncio
async def test_freeze_floor_never_lowers_a_higher_heat_target() -> None:
    hass = _unit("heat", indoor=49.0, target=68.0)
    assert await scheduler._hold_freeze_floor(hass, "climate.a", "Attic") is True
    hass.services.async_call.assert_not_awaited()


@pytest.mark.asyncio
async def test_freeze_floor_reports_a_unit_that_cannot_heat(caplog) -> None:
    hass = _unit("cool", indoor=49.0, modes=["off", "cool"])
    with caplog.at_level(logging.ERROR):
        held = await scheduler._hold_freeze_floor(hass, "climate.a", "Attic")
    assert held is False
    hass.services.async_call.assert_not_awaited()
    assert any("no heat mode" in m for m in _messages(caplog, logging.ERROR))


@pytest.mark.asyncio
async def test_freeze_floor_stays_quiet_above_the_floor() -> None:
    hass = _unit("off", indoor=50.0)
    assert await scheduler._hold_freeze_floor(hass, "climate.a", "Attic") is False
    hass.services.async_call.assert_not_awaited()


@pytest.mark.parametrize(
    "cache_patch",
    [
        {"optimization_enabled": False},
        {"a1": {"optimization_enabled": False}},
        {"a1": {"optimization_enabled": False, "pause_state": "timed",
                "paused_until": "2099-01-01T00:00:00+00:00"}},
    ],
)
@pytest.mark.asyncio
async def test_freeze_floor_acts_while_paused(cache_patch) -> None:
    hass = _unit("off", indoor=49.0)
    info = {"appliance_type": "hvac", "entity_id": "climate.a", "name": "Attic", "schedule": {}}
    info.update(cache_patch.get("a1", {}))
    cache = {"a1": info}
    if "optimization_enabled" in cache_patch:
        cache["optimization_enabled"] = cache_patch["optimization_enabled"]
    hass.data[DOMAIN] = {"schedule": cache}
    with patch.object(scheduler, "_current_slot", return_value=10):
        await scheduler.comfort_watchdog(hass, MagicMock())
    assert {"entity_id": "climate.a", "hvac_mode": "heat"} in _service_data(hass, "set_hvac_mode")


@pytest.mark.asyncio
async def test_plan_stays_out_while_the_freeze_floor_holds() -> None:
    hass = _unit("heat", indoor=49.0)
    hass.data.setdefault(DOMAIN, {})["freeze_latch"] = {"climate.a": {"restore_mode": "off"}}
    plan = {**_COOL_PLAN, "mode": "heat"}
    await scheduler._apply_hvac(hass, "climate.a", plan, 10)
    hass.services.async_call.assert_not_awaited()


def _auto_cache(mode: str = "heat") -> dict:
    return {**_COOL_PLAN, "mode": mode, "setpoint_temps": [70.0] * 48, "auto_mode": True}


@pytest.mark.parametrize("thermostat", ["cool", "heat_cool", "auto"])
@pytest.mark.asyncio
async def test_auto_plan_switches_the_thermostat_to_the_days_mode(thermostat) -> None:
    hass = _unit(thermostat)
    await scheduler._apply_hvac(hass, "climate.a", _auto_cache("heat"), 10)
    assert {"entity_id": "climate.a", "hvac_mode": "heat"} in _service_data(hass, "set_hvac_mode")
    assert _service_data(hass, "set_temperature")[0]["temperature"] == 70.0
    assert scheduler.get_last_commanded(hass, "climate.a")["hvac_mode"] == "HEAT"


@pytest.mark.asyncio
async def test_auto_plan_leaves_a_matching_thermostat_alone() -> None:
    hass = _unit("heat")
    await scheduler._apply_hvac(hass, "climate.a", _auto_cache("heat"), 10)
    assert _service_data(hass, "set_hvac_mode") == []
    assert _service_data(hass, "set_temperature")


@pytest.mark.asyncio
async def test_auto_plan_never_turns_on_a_thermostat_someone_turned_off(caplog) -> None:
    hass = _unit("off")
    with caplog.at_level(logging.ERROR):
        await scheduler._apply_hvac(hass, "climate.a", _auto_cache("heat"), 10)
    hass.services.async_call.assert_not_awaited()
    assert any("is set to Off" in m for m in _messages(caplog, logging.ERROR))


@pytest.mark.asyncio
async def test_auto_plan_wakes_a_unit_we_turned_off_ourselves() -> None:
    hass = _unit("off")
    scheduler._record_last_commanded(
        hass, "climate.a", hvac_mode="OFF", fan_mode=None, setpoint=None,
    )
    await scheduler._apply_hvac(hass, "climate.a", _auto_cache("heat"), 10)
    assert {"entity_id": "climate.a", "hvac_mode": "heat"} in _service_data(hass, "set_hvac_mode")


@pytest.mark.asyncio
async def test_auto_plan_holds_when_the_unit_cannot_do_the_days_mode(caplog) -> None:
    hass = _unit("cool", modes=["off", "cool"])
    with caplog.at_level(logging.ERROR):
        await scheduler._apply_hvac(hass, "climate.a", _auto_cache("heat"), 10)
    hass.services.async_call.assert_not_awaited()
    assert _messages(caplog, logging.ERROR)


@pytest.mark.asyncio
async def test_a_heat_or_cool_plan_still_leaves_the_thermostat_in_charge() -> None:
    hass = _unit("cool")
    plan = {k: v for k, v in _auto_cache("heat").items() if k != "auto_mode"}
    await scheduler._apply_hvac(hass, "climate.a", plan, 10)
    hass.services.async_call.assert_not_awaited()


@pytest.mark.asyncio
async def test_auto_guard_cools_a_hot_room_on_a_heating_day() -> None:
    """A mild morning's heat plan, then a warm afternoon past the band top."""
    hass = _unit("heat", indoor=80.0)
    await scheduler._apply_hvac(hass, "climate.a", _auto_cache("heat"), 10)
    assert {"entity_id": "climate.a", "hvac_mode": "cool"} in _service_data(hass, "set_hvac_mode")


@pytest.mark.asyncio
async def test_auto_guard_heats_a_cold_room_on_a_cooling_day() -> None:
    hass = _unit("cool", indoor=60.0)
    await scheduler._apply_hvac(hass, "climate.a", _auto_cache("cool"), 10)
    assert {"entity_id": "climate.a", "hvac_mode": "heat"} in _service_data(hass, "set_hvac_mode")


@pytest.mark.asyncio
async def test_freeze_floor_restores_a_thermostat_that_was_in_auto() -> None:
    hass = _unit("heat_cool", indoor=49.0, modes=["off", "heat", "cool", "heat_cool"])
    await scheduler._hold_freeze_floor(hass, "climate.a", "Attic")
    state = hass.states.get("climate.a")
    state.state = "heat"
    state.attributes["current_temperature"] = 52.0
    hass.services.async_call.reset_mock()
    await scheduler._hold_freeze_floor(hass, "climate.a", "Attic")
    assert {"entity_id": "climate.a", "hvac_mode": "heat_cool"} in _service_data(hass, "set_hvac_mode")


def _idle_plan(**overrides) -> dict:
    return {
        **_COOL_PLAN, "mode": "heat", "setpoint_temps": [67.0] * 48,
        "idle_day": True, "auto_mode": True, **overrides,
    }


@pytest.mark.parametrize(("thermostat", "edge"), [("heat", 67.0), ("cool", 78.0)])
@pytest.mark.asyncio
async def test_idle_day_parks_at_the_edge_of_whatever_mode_it_finds(thermostat, edge) -> None:
    hass = _unit(thermostat)
    await scheduler._apply_hvac(hass, "climate.a", _idle_plan(), 10)
    assert _service_data(hass, "set_hvac_mode") == []
    assert _service_data(hass, "set_temperature")[0]["temperature"] == edge


@pytest.mark.asyncio
async def test_idle_day_does_not_switch_a_thermostat_in_its_own_auto() -> None:
    hass = _unit("heat_cool", modes=["off", "heat", "cool", "heat_cool"])
    await scheduler._apply_hvac(hass, "climate.a", _idle_plan(), 10)
    hass.services.async_call.assert_not_awaited()


@pytest.mark.asyncio
async def test_idle_day_leaves_a_thermostat_that_is_off_alone_without_an_error(caplog) -> None:
    hass = _unit("off")
    with caplog.at_level(logging.INFO):
        await scheduler._apply_hvac(hass, "climate.a", _idle_plan(), 10)
    hass.services.async_call.assert_not_awaited()
    assert _messages(caplog, logging.ERROR) == []
    assert any("no heating or cooling" in m for m in _messages(caplog, logging.INFO))


@pytest.mark.asyncio
async def test_idle_day_does_not_wake_a_unit_we_turned_off() -> None:
    hass = _unit("off")
    scheduler._record_last_commanded(
        hass, "climate.a", hvac_mode="OFF", fan_mode=None, setpoint=None,
    )
    await scheduler._apply_hvac(hass, "climate.a", _idle_plan(), 10)
    hass.services.async_call.assert_not_awaited()


@pytest.mark.asyncio
async def test_idle_day_on_auto_still_rescues_a_room_leaving_the_range() -> None:
    """The forecast was wrong: the guard is why an idle day is safe."""
    hass = _unit("heat", indoor=80.0)
    await scheduler._apply_hvac(hass, "climate.a", _idle_plan(), 10)
    assert {"entity_id": "climate.a", "hvac_mode": "cool"} in _service_data(hass, "set_hvac_mode")


@pytest.mark.asyncio
async def test_idle_day_on_heat_only_still_leaves_a_conflict_with_the_thermostat() -> None:
    hass = _unit("cool")
    plan = {k: v for k, v in _idle_plan().items() if k != "auto_mode"}
    await scheduler._apply_hvac(hass, "climate.a", plan, 10)
    hass.services.async_call.assert_not_awaited()


def test_idle_plans_have_no_room_target_for_the_tracker_to_chase() -> None:
    hass = _unit("heat", indoor=75.0)
    assert scheduler._track_room_target(hass, "climate.a", _idle_plan(), 10) is None

