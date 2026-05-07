"""Tests for custom_components.hungry_machines.readings (v2.0).

The poller now iterates `/api/v1/appliances` and routes per-type:
    hvac → POST /api/v1/readings (home thermal-model data)
    ev_charger / home_battery → POST /api/v1/appliances/{id}/readings
    water_heater → POST /api/v1/appliances/{id}/readings
"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from hungry_machines import readings


def _state(state: str = "cool", attributes: dict | None = None) -> MagicMock:
    s = MagicMock()
    s.state = state
    s.entity_id = "climate.test"
    s.attributes = attributes or {}
    return s


def _hass(states_map: dict | None) -> MagicMock:
    hass = MagicMock()
    hass.states = MagicMock()
    hass.states.get = MagicMock(side_effect=lambda eid: (states_map or {}).get(eid))
    return hass


def _entry() -> MagicMock:
    entry = MagicMock()
    entry.entry_id = "abc"
    entry.data = {}
    entry.options = {}
    entry.async_start_reauth = MagicMock()
    return entry


@pytest.mark.asyncio
async def test_no_appliances_returns_zero() -> None:
    hass = _hass({})
    entry = _entry()
    with patch.object(readings.api, "get_appliances", AsyncMock(return_value=[])):
        n = await readings.push_all_readings(hass, entry)
    assert n == 0


@pytest.mark.asyncio
async def test_hvac_appliance_posts_home_reading() -> None:
    appliance = {
        "id": "a-1",
        "appliance_type": "hvac",
        "config": {"entity_id": "climate.living_room"},
    }
    state = _state(
        "cool",
        {"current_temperature": 72.5, "temperature": 72.0, "current_humidity": 44},
    )
    hass = _hass({"climate.living_room": state})
    entry = _entry()

    home_post = AsyncMock(return_value=True)
    appl_post = AsyncMock(return_value=True)
    with patch.object(
        readings.api, "get_appliances", AsyncMock(return_value=[appliance])
    ), patch.object(readings.api, "post_home_reading", home_post), patch.object(
        readings.api, "post_appliance_reading", appl_post
    ):
        n = await readings.push_all_readings(hass, entry)

    assert n == 1
    home_post.assert_awaited_once()
    appl_post.assert_not_awaited()
    posted = home_post.await_args.args[2]
    assert posted["indoor_temp"] == 72.5
    assert posted["hvac_state"] == "COOL"
    assert posted["target_temp"] == 72.0
    assert posted["indoor_humidity"] == 44


@pytest.mark.asyncio
async def test_ev_charger_posts_per_appliance_reading_with_soc() -> None:
    appliance = {
        "id": "ev-1",
        "appliance_type": "ev_charger",
        "config": {
            "entity_id": "switch.tesla_charger",
            "soc_entity_id": "sensor.tesla_battery_level",
        },
    }
    control = _state("on", {})
    soc = _state("65.5", {})
    hass = _hass({
        "switch.tesla_charger": control,
        "sensor.tesla_battery_level": soc,
    })
    entry = _entry()

    home_post = AsyncMock(return_value=True)
    appl_post = AsyncMock(return_value=True)
    with patch.object(
        readings.api, "get_appliances", AsyncMock(return_value=[appliance])
    ), patch.object(readings.api, "post_home_reading", home_post), patch.object(
        readings.api, "post_appliance_reading", appl_post
    ):
        n = await readings.push_all_readings(hass, entry)

    assert n == 1
    home_post.assert_not_awaited()
    appl_post.assert_awaited_once()
    aid_arg, reading = appl_post.await_args.args[2], appl_post.await_args.args[3]
    assert aid_arg == "ev-1"
    assert reading["state"] == "ON"
    assert reading["value"] == 65.5


@pytest.mark.asyncio
async def test_water_heater_posts_per_appliance_reading_with_temp_sensor() -> None:
    appliance = {
        "id": "wh-1",
        "appliance_type": "water_heater",
        "config": {
            "entity_id": "switch.water_heater",
            "temp_entity_id": "sensor.tank_temp",
        },
    }
    control = _state("off", {})
    temp = _state("128.4", {})
    hass = _hass({
        "switch.water_heater": control,
        "sensor.tank_temp": temp,
    })
    entry = _entry()

    appl_post = AsyncMock(return_value=True)
    with patch.object(
        readings.api, "get_appliances", AsyncMock(return_value=[appliance])
    ), patch.object(readings.api, "post_home_reading", AsyncMock()), patch.object(
        readings.api, "post_appliance_reading", appl_post
    ):
        n = await readings.push_all_readings(hass, entry)

    assert n == 1
    reading = appl_post.await_args.args[3]
    assert reading["state"] == "OFF"
    assert reading["value"] == 128.4


@pytest.mark.asyncio
async def test_appliance_without_entity_id_skipped_silently() -> None:
    appliance = {
        "id": "ev-2",
        "appliance_type": "ev_charger",
        "config": {},  # entity_id missing
    }
    hass = _hass({})
    entry = _entry()

    appl_post = AsyncMock(return_value=True)
    with patch.object(
        readings.api, "get_appliances", AsyncMock(return_value=[appliance])
    ), patch.object(readings.api, "post_appliance_reading", appl_post):
        n = await readings.push_all_readings(hass, entry)

    assert n == 0
    appl_post.assert_not_awaited()


@pytest.mark.asyncio
async def test_hvac_without_current_temperature_skipped() -> None:
    appliance = {
        "id": "a-1",
        "appliance_type": "hvac",
        "config": {"entity_id": "climate.no_temp"},
    }
    state = _state("cool", {})  # no current_temperature
    hass = _hass({"climate.no_temp": state})
    entry = _entry()

    home_post = AsyncMock(return_value=True)
    with patch.object(
        readings.api, "get_appliances", AsyncMock(return_value=[appliance])
    ), patch.object(readings.api, "post_home_reading", home_post):
        n = await readings.push_all_readings(hass, entry)

    assert n == 0
    home_post.assert_not_awaited()


@pytest.mark.asyncio
async def test_compat_shim_returns_true_when_at_least_one_posted() -> None:
    appliance = {
        "id": "a-1",
        "appliance_type": "hvac",
        "config": {"entity_id": "climate.x"},
    }
    state = _state("heat", {"current_temperature": 70.0})
    hass = _hass({"climate.x": state})
    entry = _entry()

    with patch.object(
        readings.api, "get_appliances", AsyncMock(return_value=[appliance])
    ), patch.object(readings.api, "post_home_reading", AsyncMock(return_value=True)):
        result = await readings.push_current_reading(hass, entry)
    assert result is True


@pytest.mark.asyncio
async def test_compat_shim_returns_false_when_nothing_posted() -> None:
    hass = _hass({})
    entry = _entry()
    with patch.object(readings.api, "get_appliances", AsyncMock(return_value=[])):
        result = await readings.push_current_reading(hass, entry)
    assert result is False


@pytest.mark.asyncio
async def test_charge_reading_clamps_soc_above_100() -> None:
    appliance = {
        "id": "ev-1",
        "appliance_type": "ev_charger",
        "config": {
            "entity_id": "switch.charger",
            "soc_entity_id": "sensor.soc",
        },
    }
    control = _state("on", {})
    soc = _state("150.0", {})  # nonsense, must clamp to 100
    hass = _hass({"switch.charger": control, "sensor.soc": soc})
    entry = _entry()

    appl_post = AsyncMock(return_value=True)
    with patch.object(
        readings.api, "get_appliances", AsyncMock(return_value=[appliance])
    ), patch.object(readings.api, "post_appliance_reading", appl_post):
        await readings.push_all_readings(hass, entry)

    reading = appl_post.await_args.args[3]
    assert reading["value"] == 100.0
