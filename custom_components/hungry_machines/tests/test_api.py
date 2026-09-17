"""Tests for custom_components.hungry_machines.api (US-REC-031).

`_authenticated_request` is the single funnel every `api.*` wrapper goes
through. Every other test file (readings/scheduler/weather) only ever
patches `_authenticated_request` itself, so its own timeout + exception
handling has no direct coverage until now.
"""
from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import aiohttp
import pytest

from hungry_machines import api, auth


def _entry() -> MagicMock:
    entry = MagicMock()
    entry.entry_id = "abc"
    entry.data = {}
    entry.async_start_reauth = MagicMock()
    return entry


def _mock_response(status: int, json_body: dict) -> MagicMock:
    response = MagicMock()
    response.status = status
    response.json = AsyncMock(return_value=json_body)

    cm = MagicMock()
    cm.__aenter__ = AsyncMock(return_value=response)
    cm.__aexit__ = AsyncMock(return_value=False)
    return cm


def _session_with_request(cm: MagicMock) -> MagicMock:
    session = MagicMock()
    session.request = MagicMock(return_value=cm)
    return session


def _session_with_request_raising(exc: Exception) -> MagicMock:
    session = MagicMock()

    def _raise(*_a, **_kw):
        raise exc

    session.request = MagicMock(side_effect=_raise)
    return session


@pytest.mark.asyncio
async def test_authenticated_request_passes_a_20s_total_timeout() -> None:
    """A slow API must delay the caller, not hang the integration
    forever — session.request always carries a 20s total ClientTimeout."""
    cm = _mock_response(200, {"ok": True})
    session = _session_with_request(cm)
    entry = _entry()

    with patch.object(auth, "current_token", AsyncMock(return_value="tok")), \
         patch.object(api.aiohttp_client, "async_get_clientsession", return_value=session):
        result = await api._authenticated_request(MagicMock(), entry, "GET", "/api/v1/appliances")

    assert result == {"ok": True}
    _, kwargs = session.request.call_args
    timeout = kwargs.get("timeout")
    assert isinstance(timeout, aiohttp.ClientTimeout)
    assert timeout.total == 20


@pytest.mark.asyncio
async def test_authenticated_request_timeout_returns_none_and_warns(caplog) -> None:
    """A timed-out request returns None — the same 'no data this tick'
    signal as any other failure — and logs a warning naming the
    exception type, instead of raising into the caller's timer
    callback."""
    session = _session_with_request_raising(asyncio.TimeoutError())
    entry = _entry()

    with patch.object(auth, "current_token", AsyncMock(return_value="tok")), \
         patch.object(api.aiohttp_client, "async_get_clientsession", return_value=session), \
         caplog.at_level("WARNING", logger=api._LOGGER.name):
        result = await api._authenticated_request(MagicMock(), entry, "GET", "/api/v1/appliances")

    assert result is None
    warned = [r for r in caplog.records if r.levelname == "WARNING"]
    assert any("TimeoutError" in r.getMessage() for r in warned)


@pytest.mark.asyncio
async def test_authenticated_request_client_error_still_returns_none_and_warns(caplog) -> None:
    """Pre-existing aiohttp.ClientError handling is unchanged: still
    returns None, still logs a warning naming the exception type."""
    session = _session_with_request_raising(aiohttp.ClientConnectionError("boom"))
    entry = _entry()

    with patch.object(auth, "current_token", AsyncMock(return_value="tok")), \
         patch.object(api.aiohttp_client, "async_get_clientsession", return_value=session), \
         caplog.at_level("WARNING", logger=api._LOGGER.name):
        result = await api._authenticated_request(MagicMock(), entry, "GET", "/api/v1/appliances")

    assert result is None
    warned = [r for r in caplog.records if r.levelname == "WARNING"]
    assert any("ClientConnectionError" in r.getMessage() for r in warned)
