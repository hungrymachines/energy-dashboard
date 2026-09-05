"""Tests for custom_components.hungry_machines.__init__ (control cadence).

US-RTG-025: the comfort watchdog no longer fires at :00/:30 — the slot
apply's own set-then-verify pass (`scheduler._schedule_apply_verification`,
armed 60s after every apply) covers those boundaries instead. This only
tests the `async_track_time_change` registrations `async_setup_entry`
makes; the apply/verify and comfort logic themselves are covered by
`test_scheduler.py` and `test_comfort.py`.

US-RTG-027: both cadences now run `scheduler.check_schedule_freshness`
(via the `_check_freshness_before` wrapper) immediately before their own
duty. Those tests capture the registered callback and invoke it directly,
rather than inspecting `async_track_time_change`'s call args.
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


def _registered_callback(mock_track, name: str):
    """Pull the actual callback `async_setup_entry` handed to a given
    `async_track_time_change` registration, by the local function name
    (`_apply_slot` / `_comfort_watchdog`) `test_*_registration_*` above
    already key off of."""
    matches = [c for c in mock_track.call_args_list if c.args[1].__name__ == name]
    assert len(matches) == 1
    return matches[0].args[1]


@pytest.mark.asyncio
async def test_apply_slot_checks_freshness_before_applying() -> None:
    """US-RTG-027: the :00/:30 tick polls freshness first, then applies —
    both against the SAME hass/entry the setup call closed over."""
    hass = _hass()
    entry = _entry()
    order: list[str] = []

    async def _fake_freshness(*_args, **_kwargs) -> None:
        order.append("freshness")

    async def _fake_apply(*_args, **_kwargs) -> None:
        order.append("apply")

    with patch.object(
        hungry_machines, "_ensure_frontend_registered", AsyncMock(return_value=True)
    ), patch.object(
        hungry_machines, "fetch_today_schedule", AsyncMock(return_value=None)
    ), patch.object(
        hungry_machines, "check_schedule_freshness", AsyncMock(side_effect=_fake_freshness)
    ) as mock_freshness, patch.object(
        hungry_machines, "apply_current_slot", AsyncMock(side_effect=_fake_apply)
    ), patch.object(
        hungry_machines, "async_track_time_change"
    ) as mock_track:
        await hungry_machines.async_setup_entry(hass, entry)
        callback = _registered_callback(mock_track, "_apply_slot")
        await callback(None)

    assert order == ["freshness", "apply"]
    mock_freshness.assert_awaited_once_with(hass, entry)


@pytest.mark.asyncio
async def test_comfort_watchdog_checks_freshness_before_running() -> None:
    """US-RTG-027: the same freshness poll rides the comfort-watchdog
    cadence too — one check_schedule_freshness call per tick, before the
    band check."""
    hass = _hass()
    entry = _entry()
    order: list[str] = []

    async def _fake_freshness(*_args, **_kwargs) -> None:
        order.append("freshness")

    async def _fake_watchdog(*_args, **_kwargs) -> None:
        order.append("watchdog")

    with patch.object(
        hungry_machines, "_ensure_frontend_registered", AsyncMock(return_value=True)
    ), patch.object(
        hungry_machines, "fetch_today_schedule", AsyncMock(return_value=None)
    ), patch.object(
        hungry_machines, "check_schedule_freshness", AsyncMock(side_effect=_fake_freshness)
    ) as mock_freshness, patch.object(
        hungry_machines, "comfort_watchdog", AsyncMock(side_effect=_fake_watchdog)
    ), patch.object(
        hungry_machines, "async_track_time_change"
    ) as mock_track:
        await hungry_machines.async_setup_entry(hass, entry)
        callback = _registered_callback(mock_track, "_comfort_watchdog")
        await callback(None)

    assert order == ["freshness", "watchdog"]
    mock_freshness.assert_awaited_once_with(hass, entry)


@pytest.mark.asyncio
async def test_comfort_watchdog_still_runs_when_freshness_check_raises() -> None:
    """US-RTG-027 AC: 'comfort duties always run even when the freshness
    call fails' — an unexpected exception out of check_schedule_freshness
    must not stop the comfort watchdog from running right after it."""
    hass = _hass()
    entry = _entry()

    with patch.object(
        hungry_machines, "_ensure_frontend_registered", AsyncMock(return_value=True)
    ), patch.object(
        hungry_machines, "fetch_today_schedule", AsyncMock(return_value=None)
    ), patch.object(
        hungry_machines,
        "check_schedule_freshness",
        AsyncMock(side_effect=RuntimeError("boom")),
    ), patch.object(
        hungry_machines, "comfort_watchdog", AsyncMock()
    ) as mock_watchdog, patch.object(
        hungry_machines, "async_track_time_change"
    ) as mock_track:
        await hungry_machines.async_setup_entry(hass, entry)
        callback = _registered_callback(mock_track, "_comfort_watchdog")
        await callback(None)  # must not raise

    mock_watchdog.assert_awaited_once_with(hass, entry)


@pytest.mark.asyncio
async def test_apply_slot_still_runs_when_freshness_check_raises() -> None:
    """Same defense-in-depth on the :00/:30 apply cadence."""
    hass = _hass()
    entry = _entry()

    with patch.object(
        hungry_machines, "_ensure_frontend_registered", AsyncMock(return_value=True)
    ), patch.object(
        hungry_machines, "fetch_today_schedule", AsyncMock(return_value=None)
    ), patch.object(
        hungry_machines,
        "check_schedule_freshness",
        AsyncMock(side_effect=RuntimeError("boom")),
    ), patch.object(
        hungry_machines, "apply_current_slot", AsyncMock()
    ) as mock_apply, patch.object(
        hungry_machines, "async_track_time_change"
    ) as mock_track:
        await hungry_machines.async_setup_entry(hass, entry)
        callback = _registered_callback(mock_track, "_apply_slot")
        await callback(None)  # must not raise

    mock_apply.assert_awaited_once_with(hass, entry)
