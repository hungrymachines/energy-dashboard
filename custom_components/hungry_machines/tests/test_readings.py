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
async def test_capture_hvac_records_fan_mode() -> None:
    """Regression: fan_mode was accepted by the API but the integration
    never read state.attributes["fan_mode"], so every sensor_readings
    row had fan_mode=NULL. Now the captured reading carries it."""
    appliance = {
        "id": "a-1",
        "appliance_type": "hvac",
        "config": {"entity_id": "climate.living_room"},
    }
    state = _state(
        "cool",
        {
            "current_temperature": 72.5,
            "temperature": 72.0,
            "current_humidity": 44,
            "fan_mode": "low",
        },
    )
    hass = _hass({"climate.living_room": state})
    entry = _entry()

    with patch.object(
        readings.api, "get_appliances", AsyncMock(return_value=[appliance])
    ):
        await readings.capture_readings(hass, entry)

    posted = hass.data[DOMAIN]["readings_buffer"]["home"][0]
    assert posted["fan_mode"] == "low"


@pytest.mark.asyncio
async def test_capture_hvac_uses_hvac_action_over_mode() -> None:
    """A heat_cool-mode thermostat that's currently cooling reports
    state='heat_cool' and hvac_action='cooling'. We must capture COOL,
    not OFF (which would happen if we only looked at the mode string).

    Regression: the previous logic uppercased state.state and checked
    membership in (HEAT, COOL, OFF, FAN); heat_cool fell through to OFF
    even when the unit was actively cooling, poisoning the model fitter
    with fake OFF samples during heat_cool/auto operation."""
    appliance = {
        "id": "a-1",
        "appliance_type": "hvac",
        "config": {"entity_id": "climate.living_room"},
    }
    state = _state(
        "heat_cool",
        {
            "current_temperature": 72.5,
            "temperature": 72.0,
            "hvac_action": "cooling",
        },
    )
    hass = _hass({"climate.living_room": state})
    entry = _entry()

    with patch.object(
        readings.api, "get_appliances", AsyncMock(return_value=[appliance])
    ):
        await readings.capture_readings(hass, entry)

    posted = hass.data[DOMAIN]["readings_buffer"]["home"][0]
    assert posted["hvac_state"] == "COOL"


@pytest.mark.asyncio
async def test_capture_hvac_window_ac_eco_mode_records_eco() -> None:
    """Window ACs commonly have Cool / Fan / Eco modes. ECO is recorded
    distinctly from COOL — reduced-duty compressor means a different
    cooling rate; the fitter can combine them later if useful."""
    appliance = {
        "id": "a-1",
        "appliance_type": "hvac",
        "config": {"entity_id": "climate.window_unit"},
    }
    state = _state(
        "eco",
        {
            "current_temperature": 73.0,
            "temperature": 72.0,
            "fan_mode": "Low",
        },
    )
    hass = _hass({"climate.window_unit": state})
    entry = _entry()

    with patch.object(
        readings.api, "get_appliances", AsyncMock(return_value=[appliance])
    ):
        await readings.capture_readings(hass, entry)

    posted = hass.data[DOMAIN]["readings_buffer"]["home"][0]
    assert posted["hvac_state"] == "ECO"
    assert posted["fan_mode"] == "Low"


@pytest.mark.asyncio
async def test_capture_hvac_dry_mode_records_dry() -> None:
    """Dry/dehumidify mode is recorded as DRY (distinct from COOL).
    The compressor runs intermittently for moisture removal rather
    than temperature targeting — the thermal effect differs enough
    from full COOL to warrant a separate sample bucket."""
    appliance = {
        "id": "a-1",
        "appliance_type": "hvac",
        "config": {"entity_id": "climate.living_room"},
    }
    state = _state(
        "dry",
        {"current_temperature": 75.0, "temperature": 72.0},
    )
    hass = _hass({"climate.living_room": state})
    entry = _entry()

    with patch.object(
        readings.api, "get_appliances", AsyncMock(return_value=[appliance])
    ):
        await readings.capture_readings(hass, entry)

    posted = hass.data[DOMAIN]["readings_buffer"]["home"][0]
    assert posted["hvac_state"] == "DRY"


@pytest.mark.asyncio
async def test_capture_eco_mode_with_idle_action_records_off() -> None:
    """A unit in ECO mode but currently idle (compressor off) should
    record OFF, not ECO. The mode-specific label only applies when
    the unit is actively engaged."""
    appliance = {
        "id": "a-1",
        "appliance_type": "hvac",
        "config": {"entity_id": "climate.living_room"},
    }
    state = _state(
        "eco",
        {
            "current_temperature": 72.0,
            "temperature": 72.0,
            "hvac_action": "idle",
        },
    )
    hass = _hass({"climate.living_room": state})
    entry = _entry()

    with patch.object(
        readings.api, "get_appliances", AsyncMock(return_value=[appliance])
    ):
        await readings.capture_readings(hass, entry)

    posted = hass.data[DOMAIN]["readings_buffer"]["home"][0]
    assert posted["hvac_state"] == "OFF"


@pytest.mark.asyncio
async def test_capture_hvac_action_idle_records_off() -> None:
    """heat_cool mode + hvac_action='idle' means unit is on but not
    actively heating or cooling at this moment → record OFF."""
    appliance = {
        "id": "a-1",
        "appliance_type": "hvac",
        "config": {"entity_id": "climate.living_room"},
    }
    state = _state(
        "heat_cool",
        {
            "current_temperature": 72.0,
            "temperature": 72.0,
            "hvac_action": "idle",
        },
    )
    hass = _hass({"climate.living_room": state})
    entry = _entry()

    with patch.object(
        readings.api, "get_appliances", AsyncMock(return_value=[appliance])
    ):
        await readings.capture_readings(hass, entry)

    posted = hass.data[DOMAIN]["readings_buffer"]["home"][0]
    assert posted["hvac_state"] == "OFF"


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
