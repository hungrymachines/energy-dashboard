"""Tests for custom_components.hungry_machines.readings."""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from hungry_machines import readings
from hungry_machines.const import CONF_CLIMATE_ENTITY


def _mock_response(status: int, json_body: dict | None = None) -> MagicMock:
    response = MagicMock()
    response.status = status
    response.json = AsyncMock(return_value=json_body or {})
    cm = MagicMock()
    cm.__aenter__ = AsyncMock(return_value=response)
    cm.__aexit__ = AsyncMock(return_value=False)
    return cm


def _session_with_post(cm: MagicMock) -> MagicMock:
    session = MagicMock()
    session.post = MagicMock(return_value=cm)
    return session


def _make_state(
    state: str = "cool",
    *,
    current_temperature: float | None = 72.5,
    temperature: float | None = 72.0,
    current_humidity: float | None = None,
) -> MagicMock:
    s = MagicMock()
    s.state = state
    attrs: dict = {}
    if current_temperature is not None:
        attrs["current_temperature"] = current_temperature
    if temperature is not None:
        attrs["temperature"] = temperature
    if current_humidity is not None:
        attrs["current_humidity"] = current_humidity
    s.attributes = attrs
    return s


def _make_hass(state: MagicMock | None) -> MagicMock:
    hass = MagicMock()
    hass.states = MagicMock()
    hass.states.get = MagicMock(return_value=state)
    return hass


def _make_entry(
    climate_entity: str | None = "climate.living_room",
) -> MagicMock:
    entry = MagicMock()
    entry.entry_id = "abc"
    entry.data = (
        {CONF_CLIMATE_ENTITY: climate_entity} if climate_entity else {}
    )
    entry.options = {}
    entry.async_start_reauth = MagicMock()
    return entry


@pytest.mark.asyncio
async def test_push_current_reading_happy_path() -> None:
    """Climate entity present with valid attrs → POSTs one reading."""
    state = _make_state(
        state="COOL",
        current_temperature=72.5,
        temperature=72.0,
        current_humidity=44,
    )
    hass = _make_hass(state)
    entry = _make_entry()

    cm = _mock_response(201, {"accepted": 1})
    session = _session_with_post(cm)

    with patch.object(
        readings.auth, "current_token", AsyncMock(return_value="tok")
    ), patch.object(
        readings.aiohttp_client,
        "async_get_clientsession",
        return_value=session,
    ):
        result = await readings.push_current_reading(hass, entry)

    assert result is True
    session.post.assert_called_once()
    args, kwargs = session.post.call_args
    assert args[0].endswith("/api/v1/readings")
    assert kwargs["headers"]["Authorization"] == "Bearer tok"
    body = kwargs["json"]
    assert "readings" in body
    assert len(body["readings"]) == 1
    reading = body["readings"][0]
    assert "timestamp" in reading
    assert reading["indoor_temp"] == 72.5
    assert reading["hvac_state"] == "COOL"
    assert reading["target_temp"] == 72.0
    assert reading["indoor_humidity"] == 44
    entry.async_start_reauth.assert_not_called()


@pytest.mark.asyncio
async def test_push_current_reading_no_climate_entity_returns_false() -> None:
    """No climate entity configured → returns False, no post."""
    hass = _make_hass(_make_state())
    entry = _make_entry(climate_entity=None)

    session = _session_with_post(_mock_response(201))
    with patch.object(
        readings.auth, "current_token", AsyncMock(return_value="tok")
    ), patch.object(
        readings.aiohttp_client,
        "async_get_clientsession",
        return_value=session,
    ):
        result = await readings.push_current_reading(hass, entry)

    assert result is False
    session.post.assert_not_called()


@pytest.mark.asyncio
async def test_push_current_reading_entity_missing_returns_false() -> None:
    """States.get returns None → returns False, no post."""
    hass = _make_hass(None)
    entry = _make_entry()

    session = _session_with_post(_mock_response(201))
    with patch.object(
        readings.auth, "current_token", AsyncMock(return_value="tok")
    ), patch.object(
        readings.aiohttp_client,
        "async_get_clientsession",
        return_value=session,
    ):
        result = await readings.push_current_reading(hass, entry)

    assert result is False
    session.post.assert_not_called()


@pytest.mark.asyncio
async def test_push_current_reading_no_indoor_temp_returns_false() -> None:
    """current_temperature missing → returns False, no post."""
    state = _make_state(current_temperature=None)
    hass = _make_hass(state)
    entry = _make_entry()

    session = _session_with_post(_mock_response(201))
    with patch.object(
        readings.auth, "current_token", AsyncMock(return_value="tok")
    ), patch.object(
        readings.aiohttp_client,
        "async_get_clientsession",
        return_value=session,
    ):
        result = await readings.push_current_reading(hass, entry)

    assert result is False
    session.post.assert_not_called()


@pytest.mark.asyncio
async def test_push_current_reading_401_triggers_reauth() -> None:
    """401 from API → returns False and triggers reauth on the entry."""
    hass = _make_hass(_make_state())
    entry = _make_entry()

    cm = _mock_response(401, {"detail": "expired"})
    session = _session_with_post(cm)

    with patch.object(
        readings.auth, "current_token", AsyncMock(return_value="tok")
    ), patch.object(
        readings.aiohttp_client,
        "async_get_clientsession",
        return_value=session,
    ):
        result = await readings.push_current_reading(hass, entry)

    assert result is False
    entry.async_start_reauth.assert_called_once_with(hass)


@pytest.mark.asyncio
async def test_push_current_reading_429_returns_false_no_crash() -> None:
    """429 from API → returns False without crashing or triggering reauth."""
    hass = _make_hass(_make_state())
    entry = _make_entry()

    cm = _mock_response(429, {"detail": "rate limit"})
    session = _session_with_post(cm)

    with patch.object(
        readings.auth, "current_token", AsyncMock(return_value="tok")
    ), patch.object(
        readings.aiohttp_client,
        "async_get_clientsession",
        return_value=session,
    ):
        result = await readings.push_current_reading(hass, entry)

    assert result is False
    entry.async_start_reauth.assert_not_called()


@pytest.mark.asyncio
async def test_push_current_reading_lowercase_state_normalized_to_upper() -> None:
    """``state.state`` of 'cool' (lowercase) → hvac_state 'COOL'."""
    state = _make_state(state="cool")
    hass = _make_hass(state)
    entry = _make_entry()

    cm = _mock_response(201, {"accepted": 1})
    session = _session_with_post(cm)

    with patch.object(
        readings.auth, "current_token", AsyncMock(return_value="tok")
    ), patch.object(
        readings.aiohttp_client,
        "async_get_clientsession",
        return_value=session,
    ):
        result = await readings.push_current_reading(hass, entry)

    assert result is True
    body = session.post.call_args.kwargs["json"]
    assert body["readings"][0]["hvac_state"] == "COOL"


@pytest.mark.asyncio
async def test_push_current_reading_unknown_state_falls_back_to_off() -> None:
    """Unmapped state like 'auto' → hvac_state 'OFF' (the safe fallback)."""
    state = _make_state(state="auto")
    hass = _make_hass(state)
    entry = _make_entry()

    cm = _mock_response(201, {"accepted": 1})
    session = _session_with_post(cm)

    with patch.object(
        readings.auth, "current_token", AsyncMock(return_value="tok")
    ), patch.object(
        readings.aiohttp_client,
        "async_get_clientsession",
        return_value=session,
    ):
        result = await readings.push_current_reading(hass, entry)

    assert result is True
    body = session.post.call_args.kwargs["json"]
    assert body["readings"][0]["hvac_state"] == "OFF"
