"""Tests for custom_components.hungry_machines.__init__ (control cadence).

US-RTG-025: the comfort watchdog no longer fires at :00/:30 — the slot
apply's own set-then-verify pass (`scheduler._schedule_apply_verification`,
armed 60s after every apply) covers those boundaries instead. This only
tests the `async_track_time_change` registrations `async_setup_entry`
makes; the apply/verify and comfort logic themselves are covered by
`test_scheduler.py` and `test_comfort.py`.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import hungry_machines
from hungry_machines.const import DOMAIN


def _hass() -> MagicMock:
    hass = MagicMock()
    # `_ensure_frontend_registered` normally seeds this via
    # `hass.data.setdefault(DOMAIN, {})`; it's stubbed out below to avoid
    # depending on the built (gitignored) frontend bundle file, so seed
    # it here instead — `async_setup_entry` reads `hass.data[DOMAIN]`
    # unconditionally right after.
    hass.data = {DOMAIN: {}}
    hass.http = MagicMock()
    hass.http.async_register_static_paths = AsyncMock()
    hass.services = MagicMock()
    hass.services.has_service = MagicMock(return_value=False)
    hass.services.async_register = MagicMock()
    # `_initial_weather_push()` is handed to `async_create_task` as a bare
    # coroutine object (real HA schedules it on the event loop). A plain
    # MagicMock would leave it un-awaited and emit a RuntimeWarning, so
    # close it instead — this test isn't exercising the weather push.
    hass.async_create_task = MagicMock(side_effect=lambda coro: coro.close())
    return hass


def _entry() -> MagicMock:
    entry = MagicMock()
    entry.entry_id = "abc"
    entry.data = {}
    entry.options = {}
    return entry


@pytest.mark.asyncio
async def test_comfort_watchdog_registration_excludes_slot_boundaries() -> None:
    """The watchdog rides the other five-minute marks only — :00/:30 are
    the slot-apply's own job now that its verify pass covers them."""
    hass = _hass()
    entry = _entry()

    with patch.object(
        hungry_machines, "_ensure_frontend_registered", AsyncMock(return_value=True)
    ), patch.object(
        hungry_machines, "fetch_today_schedule", AsyncMock(return_value=None)
    ), patch.object(
        hungry_machines, "async_track_time_change"
    ) as mock_track:
        result = await hungry_machines.async_setup_entry(hass, entry)

    assert result is True

    watchdog_calls = [
        c for c in mock_track.call_args_list if c.args[1].__name__ == "_comfort_watchdog"
    ]
    assert len(watchdog_calls) == 1
    assert watchdog_calls[0].kwargs["minute"] == [5, 10, 15, 20, 25, 35, 40, 45, 50, 55]
    assert 0 not in watchdog_calls[0].kwargs["minute"]
    assert 30 not in watchdog_calls[0].kwargs["minute"]
    assert watchdog_calls[0].kwargs["second"] == 45


@pytest.mark.asyncio
async def test_apply_slot_registration_unchanged() -> None:
    """The slot apply itself still fires exactly on the half-hour."""
    hass = _hass()
    entry = _entry()

    with patch.object(
        hungry_machines, "_ensure_frontend_registered", AsyncMock(return_value=True)
    ), patch.object(
        hungry_machines, "fetch_today_schedule", AsyncMock(return_value=None)
    ), patch.object(
        hungry_machines, "async_track_time_change"
    ) as mock_track:
        await hungry_machines.async_setup_entry(hass, entry)

    apply_calls = [
        c for c in mock_track.call_args_list if c.args[1].__name__ == "_apply_slot"
    ]
    assert len(apply_calls) == 1
    assert apply_calls[0].kwargs["minute"] == [0, 30]
    assert apply_calls[0].kwargs["second"] == 0
