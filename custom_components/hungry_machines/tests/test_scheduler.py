"""Tests for custom_components.hungry_machines.scheduler."""
from __future__ import annotations

from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from hungry_machines import scheduler
from hungry_machines.const import CONF_CLIMATE_ENTITY, DOMAIN


def _mock_response(status: int, json_body: dict) -> MagicMock:
    response = MagicMock()
    response.status = status
    response.json = AsyncMock(return_value=json_body)
    cm = MagicMock()
    cm.__aenter__ = AsyncMock(return_value=response)
    cm.__aexit__ = AsyncMock(return_value=False)
    return cm


def _session_with_get(cm: MagicMock) -> MagicMock:
    session = MagicMock()
    session.get = MagicMock(return_value=cm)
    return session


def _make_hass() -> MagicMock:
    hass = MagicMock()
    hass.data = {}
    hass.services = MagicMock()
    hass.services.async_call = AsyncMock()
    return hass


def _make_entry(climate_entity: str | None = None) -> MagicMock:
    entry = MagicMock()
    entry.entry_id = "abc"
    entry.data = {CONF_CLIMATE_ENTITY: climate_entity} if climate_entity else {}
    entry.options = {}
    entry.async_start_reauth = MagicMock()
    return entry


@pytest.mark.asyncio
async def test_fetch_schedule_populates_cache_on_success() -> None:
    hass = _make_hass()
    entry = _make_entry()

    payload = {
        "appliances": [
            {
                "appliance_type": "ev",
                "high_temps": [],
                "low_temps": [],
            },
            {
                "appliance_type": "hvac",
                "high_temps": [76] * 48,
                "low_temps": [68] * 48,
            },
        ]
    }
    cm = _mock_response(200, payload)
    session = _session_with_get(cm)

    with patch.object(
        scheduler.auth, "current_token", AsyncMock(return_value="tok")
    ), patch.object(
        scheduler.aiohttp_client,
        "async_get_clientsession",
        return_value=session,
    ):
        result = await scheduler.fetch_today_schedule(hass, entry)

    assert result is not None
    cache = hass.data[DOMAIN]["schedule"]
    assert cache["high_temps"] == [76] * 48
    assert cache["low_temps"] == [68] * 48
    assert "fetched_at" in cache
    args, kwargs = session.get.call_args
    assert args[0].endswith("/api/v1/schedules")
    assert kwargs["headers"]["Authorization"] == "Bearer tok"
    entry.async_start_reauth.assert_not_called()


@pytest.mark.asyncio
async def test_fetch_schedule_no_token_triggers_reauth() -> None:
    hass = _make_hass()
    entry = _make_entry()

    with patch.object(
        scheduler.auth, "current_token", AsyncMock(return_value=None)
    ):
        result = await scheduler.fetch_today_schedule(hass, entry)

    assert result is None
    entry.async_start_reauth.assert_called_once_with(hass)


@pytest.mark.asyncio
async def test_fetch_schedule_401_clears_cache_and_triggers_reauth() -> None:
    hass = _make_hass()
    hass.data[DOMAIN] = {"schedule": {"stale": True}}
    entry = _make_entry()

    cm = _mock_response(401, {"detail": "expired"})
    session = _session_with_get(cm)

    with patch.object(
        scheduler.auth, "current_token", AsyncMock(return_value="tok")
    ), patch.object(
        scheduler.aiohttp_client,
        "async_get_clientsession",
        return_value=session,
    ):
        result = await scheduler.fetch_today_schedule(hass, entry)

    assert result is None
    assert "schedule" not in hass.data[DOMAIN]
    entry.async_start_reauth.assert_called_once_with(hass)


@pytest.mark.asyncio
async def test_apply_current_slot_calls_climate_set_temperature() -> None:
    hass = _make_hass()
    high = [70.0 + i for i in range(48)]
    low = [60.0 + i for i in range(48)]
    hass.data[DOMAIN] = {
        "schedule": {
            "high_temps": high,
            "low_temps": low,
            "fetched_at": "now",
        }
    }
    entry = _make_entry(climate_entity="climate.living_room")

    fixed = datetime(2026, 5, 5, 14, 35, 0)

    class _DT(datetime):
        @classmethod
        def now(cls, tz=None):
            return fixed

    with patch.object(scheduler, "datetime", _DT):
        await scheduler.apply_current_slot(hass, entry)

    expected_slot = (14 * 2) + 1  # 14:35 -> slot 29
    hass.services.async_call.assert_awaited_once_with(
        "climate",
        "set_temperature",
        {
            "entity_id": "climate.living_room",
            "target_temp_low": low[expected_slot],
            "target_temp_high": high[expected_slot],
        },
        blocking=False,
    )


@pytest.mark.asyncio
async def test_apply_current_slot_no_cache_is_noop() -> None:
    hass = _make_hass()
    entry = _make_entry(climate_entity="climate.living_room")

    await scheduler.apply_current_slot(hass, entry)

    hass.services.async_call.assert_not_called()


@pytest.mark.asyncio
async def test_apply_current_slot_no_climate_entity_is_noop() -> None:
    hass = _make_hass()
    hass.data[DOMAIN] = {
        "schedule": {
            "high_temps": [76.0] * 48,
            "low_temps": [68.0] * 48,
            "fetched_at": "now",
        }
    }
    entry = _make_entry(climate_entity=None)

    await scheduler.apply_current_slot(hass, entry)

    hass.services.async_call.assert_not_called()
