"""Tests for custom_components.hungry_machines.weather (v2.0)."""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from hungry_machines import weather


def _hass(states_map: dict | None = None) -> MagicMock:
    hass = MagicMock()
    hass.states = MagicMock()
    hass.states.get = MagicMock(side_effect=lambda eid: (states_map or {}).get(eid))
    hass.services = MagicMock()
    hass.services.async_call = AsyncMock()
    return hass


def _entry() -> MagicMock:
    e = MagicMock()
    e.entry_id = "abc"
    e.data = {}
    e.options = {}
    e.async_start_reauth = MagicMock()
    return e


def _state(attrs: dict | None = None) -> MagicMock:
    s = MagicMock()
    s.state = "sunny"
    s.attributes = attrs or {}
    return s


def _hourly_forecast(n: int, base_temp: float = 70.0, unit: str = "F") -> list[dict]:
    items = []
    for i in range(n):
        t = base_temp + i * 0.5
        items.append({
            "datetime": f"2026-05-07T{i % 24:02d}:00:00+00:00",
            "temperature": t,
            "humidity": 50 + (i % 10),
            "wind_speed": 5.0,
        })
    return items


@pytest.mark.asyncio
async def test_no_weather_entity_in_profile_skips() -> None:
    hass = _hass()
    entry = _entry()
    with patch.object(
        weather.api, "_authenticated_request", AsyncMock(return_value={"weather_entity_id": ""})
    ), patch.object(weather.api, "post_weather", AsyncMock()) as post:
        ok = await weather.push_today_forecast(hass, entry)
    assert ok is False
    post.assert_not_awaited()


@pytest.mark.asyncio
async def test_happy_path_pushes_normalised_payload() -> None:
    hass = _hass({"weather.home": _state({"temperature_unit": "°F", "wind_speed_unit": "mph"})})
    entry = _entry()
    me = {"weather_entity_id": "weather.home"}
    forecast = _hourly_forecast(48)

    async def fake_call(domain, service, payload, **kwargs):
        return {"weather.home": {"forecast": forecast}}

    hass.services.async_call = AsyncMock(side_effect=fake_call)

    posted: list[dict] = []

    async def fake_post(_h, _e, body):
        posted.append(body)
        return True

    with patch.object(
        weather.api, "_authenticated_request", AsyncMock(return_value=me)
    ), patch.object(weather.api, "post_weather", side_effect=fake_post):
        ok = await weather.push_today_forecast(hass, entry)

    assert ok is True
    assert len(posted) == 1
    payload = posted[0]
    assert len(payload["hourly_temps_f"]) == 48
    assert payload["hourly_temps_f"][0] == 70.0  # already in F, no conversion
    assert "hourly_humidity" in payload
    assert "hourly_wind_mph" in payload


@pytest.mark.asyncio
async def test_celsius_temps_converted_to_fahrenheit() -> None:
    hass = _hass({"weather.home": _state({"temperature_unit": "°C"})})
    entry = _entry()
    me = {"weather_entity_id": "weather.home"}
    # 24 hourly forecasts at 0°C → should become 32°F
    forecast = [{"temperature": 0.0} for _ in range(24)]

    hass.services.async_call = AsyncMock(
        return_value={"weather.home": {"forecast": forecast}}
    )

    posted: list[dict] = []

    async def fake_post(_h, _e, body):
        posted.append(body)
        return True

    with patch.object(
        weather.api, "_authenticated_request", AsyncMock(return_value=me)
    ), patch.object(weather.api, "post_weather", side_effect=fake_post):
        ok = await weather.push_today_forecast(hass, entry)

    assert ok is True
    assert posted[0]["hourly_temps_f"][0] == 32.0


@pytest.mark.asyncio
async def test_too_few_forecast_points_skipped() -> None:
    hass = _hass({"weather.home": _state()})
    entry = _entry()
    me = {"weather_entity_id": "weather.home"}
    # Only 12 hourly points — below the 24-hour minimum
    forecast = _hourly_forecast(12)

    hass.services.async_call = AsyncMock(
        return_value={"weather.home": {"forecast": forecast}}
    )

    with patch.object(
        weather.api, "_authenticated_request", AsyncMock(return_value=me)
    ), patch.object(weather.api, "post_weather", AsyncMock()) as post:
        ok = await weather.push_today_forecast(hass, entry)

    assert ok is False
    post.assert_not_awaited()


@pytest.mark.asyncio
async def test_weather_entity_missing_from_states_skipped() -> None:
    hass = _hass({})  # entity not in states
    entry = _entry()
    me = {"weather_entity_id": "weather.removed"}

    with patch.object(
        weather.api, "_authenticated_request", AsyncMock(return_value=me)
    ), patch.object(weather.api, "post_weather", AsyncMock()) as post:
        ok = await weather.push_today_forecast(hass, entry)

    assert ok is False
    post.assert_not_awaited()
