"""Tests for custom_components.hungry_machines.scheduler (v2.0)."""
from __future__ import annotations

from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from hungry_machines import scheduler
from hungry_machines.const import DOMAIN


def _hass(climate_state: object | None = None) -> MagicMock:
    hass = MagicMock()
    hass.data = {}
    hass.services = MagicMock()
    hass.services.async_call = AsyncMock()
    hass.states = MagicMock()
    hass.states.get = MagicMock(return_value=climate_state)
    return hass


def _climate_state(mode: str, supports_range: bool = True) -> MagicMock:
    """Build a hass.states.get(...) return value matching a climate entity.

    `supports_range` toggles the TARGET_TEMPERATURE_RANGE bit on
    `supported_features`. The state value is the HVAC mode string.
    """
    state = MagicMock()
    state.state = mode
    state.attributes = {"supported_features": 2 if supports_range else 1}
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


def _hvac_cache(
    entity_id: str = "climate.living_room",
    setpoint: float = 71.5,
    include_setpoints: bool = True,
) -> dict:
    """Build a cached schedule for one HVAC appliance.

    `setpoint` is the value at slot 28 (where each apply test reads).
    When `include_setpoints` is False, only the legacy high/low band
    is present so we can verify the fallback path.
    """
    schedule: dict = {
        "high_temps": [74.0] * 48,
        "low_temps": [70.0] * 48,
    }
    if include_setpoints:
        # Constant setpoint across the day for test simplicity.
        schedule["setpoint_temps"] = [setpoint] * 48
    return {
        "schedule": {
            "fetched_at": "2026-05-07T05:05:00+00:00",
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
            "fetched_at": "x",
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
            "fetched_at": "x",
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
            "fetched_at": "x",
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
            "fetched_at": "x",
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
async def test_apply_no_cache_skipped() -> None:
    hass = _hass()
    entry = _entry()
    hass.data[DOMAIN] = {}  # no 'schedule' key
    await scheduler.apply_current_slot(hass, entry)
    hass.services.async_call.assert_not_awaited()


def test_current_slot_at_midnight_is_zero() -> None:
    assert scheduler._current_slot(datetime(2026, 5, 7, 0, 0)) == 0


def test_current_slot_at_half_past_is_odd() -> None:
    # 14:30 → 14*2 + 1 = 29
    assert scheduler._current_slot(datetime(2026, 5, 7, 14, 30)) == 29


def test_current_slot_at_quarter_past_uses_lower_half() -> None:
    # 14:15 → minute < 30 → slot 28
    assert scheduler._current_slot(datetime(2026, 5, 7, 14, 15)) == 28
