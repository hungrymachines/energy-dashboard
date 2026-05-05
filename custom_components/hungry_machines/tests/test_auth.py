"""Tests for custom_components.hungry_machines.auth."""
from __future__ import annotations

import logging
import time
from unittest.mock import AsyncMock, MagicMock, patch

import aiohttp
import pytest

from hungry_machines import auth
from hungry_machines.const import (
    CONF_ACCESS_TOKEN,
    CONF_EXPIRES_AT,
    CONF_REFRESH_TOKEN,
)


def _mock_response(status: int, json_body: dict) -> MagicMock:
    """Build a MagicMock that behaves like the aiohttp context-manager response."""
    response = MagicMock()
    response.status = status
    response.json = AsyncMock(return_value=json_body)

    cm = MagicMock()
    cm.__aenter__ = AsyncMock(return_value=response)
    cm.__aexit__ = AsyncMock(return_value=False)
    return cm


def _session_with_post(cm: MagicMock) -> MagicMock:
    session = MagicMock()
    session.post = MagicMock(return_value=cm)
    return session


def _session_with_post_raising(exc: Exception) -> MagicMock:
    session = MagicMock()

    def _raise(*_a, **_kw):
        raise exc

    session.post = MagicMock(side_effect=_raise)
    return session


@pytest.fixture
def hass() -> MagicMock:
    return MagicMock()


@pytest.mark.asyncio
async def test_login_success(hass: MagicMock) -> None:
    """200 response yields tokens dict with access/refresh/expiry."""
    cm = _mock_response(
        200,
        {
            "access_token": "atok",
            "refresh_token": "rtok",
            "expires_in": 7200,
            "user": {"id": "user-123", "email": "u@example.com"},
        },
    )
    session = _session_with_post(cm)
    with patch.object(
        auth.aiohttp_client,
        "async_get_clientsession",
        return_value=session,
    ):
        before = time.time()
        result = await auth.login(hass, "u@example.com", "pw")

    assert result is not None
    assert result["access_token"] == "atok"
    assert result["refresh_token"] == "rtok"
    assert result["user_id"] == "user-123"
    assert result["email"] == "u@example.com"
    assert result["expires_at"] >= before + 7200 - 60 - 1
    session.post.assert_called_once()
    args, kwargs = session.post.call_args
    assert args[0].endswith("/auth/login")
    assert kwargs["json"] == {"email": "u@example.com", "password": "pw"}


@pytest.mark.asyncio
async def test_login_401_returns_none_and_warns(
    hass: MagicMock, caplog: pytest.LogCaptureFixture
) -> None:
    cm = _mock_response(401, {"detail": "invalid"})
    session = _session_with_post(cm)
    with caplog.at_level(logging.WARNING, logger=auth._LOGGER.name):
        with patch.object(
            auth.aiohttp_client,
            "async_get_clientsession",
            return_value=session,
        ):
            result = await auth.login(hass, "u@example.com", "wrong")
    assert result is None
    assert any("login failed" in rec.message.lower() for rec in caplog.records)


@pytest.mark.asyncio
async def test_login_network_error(hass: MagicMock) -> None:
    session = _session_with_post_raising(aiohttp.ClientError("boom"))
    with patch.object(
        auth.aiohttp_client,
        "async_get_clientsession",
        return_value=session,
    ):
        result = await auth.login(hass, "u@example.com", "pw")
    assert result is None


@pytest.mark.asyncio
async def test_refresh_success(hass: MagicMock) -> None:
    cm = _mock_response(
        200,
        {
            "access_token": "atok2",
            "refresh_token": "rtok2",
            "expires_in": 1800,
            "user": {"id": "user-123", "email": "u@example.com"},
        },
    )
    session = _session_with_post(cm)
    with patch.object(
        auth.aiohttp_client,
        "async_get_clientsession",
        return_value=session,
    ):
        result = await auth.refresh(hass, "rtok")
    assert result is not None
    assert result["access_token"] == "atok2"
    assert result["refresh_token"] == "rtok2"
    args, kwargs = session.post.call_args
    assert args[0].endswith("/auth/refresh")
    assert kwargs["json"] == {"refresh_token": "rtok"}


@pytest.mark.asyncio
async def test_current_token_uses_cached_token_when_not_expired(
    hass: MagicMock,
) -> None:
    entry = MagicMock()
    entry.data = {
        CONF_ACCESS_TOKEN: "atok",
        CONF_REFRESH_TOKEN: "rtok",
        CONF_EXPIRES_AT: time.time() + 600,
    }
    refresh_mock = AsyncMock()
    with patch.object(auth, "refresh", refresh_mock):
        token = await auth.current_token(hass, entry)
    assert token == "atok"
    refresh_mock.assert_not_called()
    hass.config_entries.async_update_entry.assert_not_called()


@pytest.mark.asyncio
async def test_current_token_refreshes_when_expired_and_persists(
    hass: MagicMock,
) -> None:
    entry = MagicMock()
    entry.data = {
        CONF_ACCESS_TOKEN: "old",
        CONF_REFRESH_TOKEN: "rtok",
        CONF_EXPIRES_AT: time.time() - 10,
    }
    new_tokens = {
        CONF_ACCESS_TOKEN: "new",
        CONF_REFRESH_TOKEN: "newr",
        CONF_EXPIRES_AT: time.time() + 3600,
        "user_id": "u",
        "email": "u@e",
    }
    with patch.object(
        auth, "refresh", AsyncMock(return_value=new_tokens)
    ) as refresh_mock:
        token = await auth.current_token(hass, entry)

    assert token == "new"
    refresh_mock.assert_awaited_once_with(hass, "rtok")
    hass.config_entries.async_update_entry.assert_called_once()
    _, kwargs = hass.config_entries.async_update_entry.call_args
    assert kwargs["data"][CONF_ACCESS_TOKEN] == "new"
    assert kwargs["data"][CONF_REFRESH_TOKEN] == "newr"


@pytest.mark.asyncio
async def test_current_token_returns_none_when_refresh_fails(
    hass: MagicMock,
) -> None:
    entry = MagicMock()
    entry.data = {
        CONF_ACCESS_TOKEN: "old",
        CONF_REFRESH_TOKEN: "rtok",
        CONF_EXPIRES_AT: 0,
    }
    with patch.object(auth, "refresh", AsyncMock(return_value=None)):
        token = await auth.current_token(hass, entry)
    assert token is None
    hass.config_entries.async_update_entry.assert_not_called()
