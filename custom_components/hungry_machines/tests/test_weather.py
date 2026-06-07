"""Tests for custom_components.hungry_machines.weather (v2.0)."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
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
    """Build a synthetic forecast list of `n` hourly items.

    Items are anchored to the NEXT local midnight (which the alignment
    helper uses as hour 0) so all entries fall inside the [0, 24) window
    the production code keeps. Starting before midnight would put the
    earliest items outside the window and the helper would return None
    for "not enough coverage".
    """
    next_local_midnight = (
        datetime.now(timezone.utc) + timedelta(days=1)
    ).replace(hour=0, minute=0, second=0, microsecond=0)
    items = []
    for i in range(n):
        t = base_temp + i * 0.5
        ts = next_local_midnight + timedelta(hours=i)
        items.append({
            "datetime": ts.isoformat(),
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
    # Alignment helper trims to 24 local-day buckets (not 48 raw items).
    assert len(payload["hourly_temps_f"]) == 24
    assert payload["hourly_temps_f"][0] == 70.0  # already in F, no conversion
    assert "hourly_humidity" in payload
    assert "hourly_wind_mph" in payload
    assert "forecast_date" in payload  # explicit local-day alignment metadata


@pytest.mark.asyncio
async def test_celsius_temps_converted_to_fahrenheit() -> None:
    hass = _hass({"weather.home": _state({"temperature_unit": "°C"})})
    entry = _entry()
    me = {"weather_entity_id": "weather.home"}
    # 24 hourly forecasts at 0°C → should become 32°F. Each item needs
    # a `datetime` field anchored to the local-midnight window the
    # alignment helper expects.
    next_local_midnight = (
        datetime.now(timezone.utc) + timedelta(days=1)
    ).replace(hour=0, minute=0, second=0, microsecond=0)
    forecast = [
        {
            "datetime": (next_local_midnight + timedelta(hours=i)).isoformat(),
            "temperature": 0.0,
        }
        for i in range(24)
    ]

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


def test_align_drops_items_before_target_midnight() -> None:
    """An HA forecast that starts at push time (not midnight) used to
    get sent as-is, and the server interpreted item 0 as "00:00 local"
    even though it was actually 03:30 EDT — the bug that put every
    sensor reading's forecast-fill 3.5 hours off. The alignment helper
    now drops items before the next local midnight and pulls 24
    midnight-aligned hours."""
    base_utc = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    next_local_midnight = (base_utc + timedelta(days=1)).replace(
        hour=0, minute=0, second=0, microsecond=0
    )

    # Build 48 hourly items: 6 PRE-midnight (should drop) + 42 starting
    # at midnight (24 of which get binned).
    items = []
    for offset in range(-6, 42):
        items.append({
            "datetime": (next_local_midnight + timedelta(hours=offset)).isoformat(),
            "temperature": 70.0 + offset,
            "humidity": 50.0,
            "wind_speed": 5.0,
        })

    result = weather._align_forecast_to_local_day(items, "F", "mph")
    assert result is not None
    fdate, temps, humidity, wind = result
    assert fdate == next_local_midnight.date().isoformat()
    assert len(temps) == 24
    # Hour 0 = first item at exactly midnight → temp=70.0 (offset 0).
    assert temps[0] == 70.0
    # Hour 23 → temp=93.0 (offset 23).
    assert temps[23] == 93.0


def test_align_returns_none_when_coverage_partial() -> None:
    """If the forecast doesn't cover all 24 local hours past midnight,
    skip the push rather than send a partial array — the server would
    have to fill gaps with stale or absent data and the model would
    then key off those holes."""
    next_local_midnight = (
        datetime.now(timezone.utc) + timedelta(days=1)
    ).replace(hour=0, minute=0, second=0, microsecond=0)
    # Only 12 hours of coverage — half a day.
    items = [
        {
            "datetime": (next_local_midnight + timedelta(hours=i)).isoformat(),
            "temperature": 70.0 + i,
        }
        for i in range(12)
    ]
    assert weather._align_forecast_to_local_day(items, "F", "mph") is None


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
