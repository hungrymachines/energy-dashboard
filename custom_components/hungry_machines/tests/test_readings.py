"""Tests for custom_components.hungry_machines.readings (v2.1).

The v2.1 split:
* `capture_readings` (every 5 min) appends per-appliance readings to an
  in-memory buffer keyed by destination ('home' or appliance_id).
* `flush_readings` (top of every hour) drains the buffer with one POST
  per non-empty key. Failed buckets are retained for the next flush.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from hungry_machines import readings
from hungry_machines.const import DOMAIN


def _state(state: str = "cool", attributes: dict | None = None) -> MagicMock:
    s = MagicMock()
    s.state = state
    s.entity_id = "climate.test"
    s.attributes = attributes or {}
    return s


def _hass(states_map: dict | None) -> MagicMock:
    hass = MagicMock()
    hass.data = {}
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


# --- capture_readings -----------------------------------------------------


@pytest.mark.asyncio
async def test_capture_no_appliances_returns_zero() -> None:
    hass = _hass({})
    entry = _entry()
    with patch.object(readings.api, "get_appliances", AsyncMock(return_value=[])):
        n = await readings.capture_readings(hass, entry)
    assert n == 0
    assert readings.buffered_count(hass) == 0


@pytest.mark.asyncio
async def test_capture_hvac_appends_to_home_bucket() -> None:
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

    with patch.object(
        readings.api, "get_appliances", AsyncMock(return_value=[appliance])
    ):
        n = await readings.capture_readings(hass, entry)

    assert n == 1
    buf = hass.data[DOMAIN]["readings_buffer"]
    assert "home" in buf and len(buf["home"]) == 1
    posted = buf["home"][0]
    assert posted["indoor_temp"] == 72.5
    assert posted["hvac_state"] == "COOL"


@pytest.mark.asyncio
async def test_capture_ev_appends_to_appliance_bucket() -> None:
    appliance = {
        "id": "ev-1",
        "appliance_type": "ev_charger",
        "config": {
            "entity_id": "switch.tesla_charger",
            "soc_entity_id": "sensor.soc",
        },
    }
    control = _state("on", {})
    soc = _state("65.5", {})
    hass = _hass({"switch.tesla_charger": control, "sensor.soc": soc})
    entry = _entry()

    with patch.object(
        readings.api, "get_appliances", AsyncMock(return_value=[appliance])
    ):
        n = await readings.capture_readings(hass, entry)

    assert n == 1
    buf = hass.data[DOMAIN]["readings_buffer"]
    assert "ev-1" in buf and len(buf["ev-1"]) == 1
    assert buf["ev-1"][0]["state"] == "ON"
    assert buf["ev-1"][0]["value"] == 65.5
    # Home bucket should not have grown.
    assert "home" not in buf or len(buf["home"]) == 0


@pytest.mark.asyncio
async def test_capture_twelve_times_accumulates_twelve_readings() -> None:
    """Running capture 12× without a flush builds a 12-element batch."""
    appliance = {
        "id": "a-1",
        "appliance_type": "hvac",
        "config": {"entity_id": "climate.x"},
    }
    state = _state("cool", {"current_temperature": 70.0})
    hass = _hass({"climate.x": state})
    entry = _entry()

    with patch.object(
        readings.api, "get_appliances", AsyncMock(return_value=[appliance])
    ):
        for _ in range(12):
            await readings.capture_readings(hass, entry)

    buf = hass.data[DOMAIN]["readings_buffer"]
    assert len(buf["home"]) == 12
    assert readings.buffered_count(hass) == 12


# --- flush_readings -------------------------------------------------------


@pytest.mark.asyncio
async def test_flush_empty_buffer_is_noop() -> None:
    hass = _hass({})
    entry = _entry()
    sent = await readings.flush_readings(hass, entry)
    assert sent == 0


@pytest.mark.asyncio
async def test_flush_drains_home_and_appliance_buckets_in_one_call_each() -> None:
    """A buffer containing 12 home readings + 12 ev readings flushes with
    exactly two POSTs (one per endpoint), not 24."""
    hass = _hass({})
    hass.data[DOMAIN] = {
        "readings_buffer": {
            "home": [{"indoor_temp": 70 + i} for i in range(12)],
            "ev-1": [{"state": "ON", "value": 50 + i} for i in range(12)],
        }
    }
    entry = _entry()

    home_post = AsyncMock(return_value=True)
    appl_post = AsyncMock(return_value=True)
    with patch.object(readings.api, "post_home_readings", home_post), patch.object(
        readings.api, "post_appliance_readings", appl_post
    ):
        sent = await readings.flush_readings(hass, entry)

    assert sent == 24
    home_post.assert_awaited_once()
    appl_post.assert_awaited_once()
    # Each call carries the FULL batch, not individual readings.
    home_batch = home_post.await_args.args[2]
    assert len(home_batch) == 12
    appl_batch = appl_post.await_args.args[3]
    assert len(appl_batch) == 12
    # Buckets cleared on success.
    buf = hass.data[DOMAIN]["readings_buffer"]
    assert buf["home"] == []
    assert buf["ev-1"] == []


@pytest.mark.asyncio
async def test_flush_failure_retains_bucket_for_retry() -> None:
    hass = _hass({})
    hass.data[DOMAIN] = {
        "readings_buffer": {
            "home": [{"indoor_temp": 70}],
        }
    }
    entry = _entry()

    home_post = AsyncMock(return_value=False)  # Simulate API failure
    with patch.object(readings.api, "post_home_readings", home_post):
        sent = await readings.flush_readings(hass, entry)

    assert sent == 0
    # Bucket retained — next flush can retry with this reading still in it.
    assert hass.data[DOMAIN]["readings_buffer"]["home"] == [{"indoor_temp": 70}]


@pytest.mark.asyncio
async def test_flush_partial_success_clears_only_succeeding_bucket() -> None:
    hass = _hass({})
    hass.data[DOMAIN] = {
        "readings_buffer": {
            "home": [{"indoor_temp": 70}],
            "ev-1": [{"state": "ON", "value": 50}],
        }
    }
    entry = _entry()

    home_post = AsyncMock(return_value=True)  # home OK
    appl_post = AsyncMock(return_value=False)  # ev fails
    with patch.object(readings.api, "post_home_readings", home_post), patch.object(
        readings.api, "post_appliance_readings", appl_post
    ):
        sent = await readings.flush_readings(hass, entry)

    assert sent == 1
    buf = hass.data[DOMAIN]["readings_buffer"]
    assert buf["home"] == []
    assert buf["ev-1"] == [{"state": "ON", "value": 50}]


# --- regression / hygiene -------------------------------------------------


@pytest.mark.asyncio
async def test_capture_appliance_without_entity_id_skipped() -> None:
    appliance = {
        "id": "ev-2",
        "appliance_type": "ev_charger",
        "config": {},  # no entity_id
    }
    hass = _hass({})
    entry = _entry()
    with patch.object(
        readings.api, "get_appliances", AsyncMock(return_value=[appliance])
    ):
        n = await readings.capture_readings(hass, entry)
    assert n == 0
    assert readings.buffered_count(hass) == 0


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
    with patch.object(
        readings.api, "get_appliances", AsyncMock(return_value=[appliance])
    ):
        n = await readings.capture_readings(hass, entry)
    assert n == 0
    assert readings.buffered_count(hass) == 0
