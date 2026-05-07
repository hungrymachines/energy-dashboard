"""Tests for custom_components.hungry_machines.config_flow (v2.0).

The config flow was simplified in v2.0 — it now only collects credentials.
The HVAC climate entity moved into per-appliance config (picked at "Add
appliance" time inside the panel) and the weather entity moved to
`users.weather_entity_id` (picked in panel Settings). The config flow
stores nothing beyond the tokens + email.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from hungry_machines import config_flow
from hungry_machines.const import (
    CONF_ACCESS_TOKEN,
    CONF_EMAIL,
    CONF_EXPIRES_AT,
    CONF_PASSWORD,
    CONF_REFRESH_TOKEN,
)


def _make_tokens(**overrides) -> dict:
    base = {
        CONF_ACCESS_TOKEN: "atok",
        CONF_REFRESH_TOKEN: "rtok",
        CONF_EXPIRES_AT: 9_999_999_999.0,
        "user_id": "user-123",
        CONF_EMAIL: "u@example.com",
    }
    base.update(overrides)
    return base


def _make_flow() -> config_flow.HungryMachinesConfigFlow:
    flow = config_flow.HungryMachinesConfigFlow()
    flow.hass = MagicMock()
    flow.context = {"source": "user"}
    return flow


@pytest.mark.asyncio
async def test_user_step_success_creates_entry_with_only_credentials() -> None:
    flow = _make_flow()
    user_input = {CONF_EMAIL: "u@example.com", CONF_PASSWORD: "secret"}

    with patch.object(
        config_flow.auth, "login", AsyncMock(return_value=_make_tokens())
    ):
        result = await flow.async_step_user(user_input)

    assert result["type"] == "create_entry"
    data = result["data"]
    assert data[CONF_EMAIL] == "u@example.com"
    assert data[CONF_ACCESS_TOKEN] == "atok"
    assert data[CONF_REFRESH_TOKEN] == "rtok"
    assert data[CONF_EXPIRES_AT] == 9_999_999_999.0
    # v2.0: no climate_entity / weather_entity fields stored on the entry.
    assert "climate_entity" not in data
    assert "weather_entity_id" not in data
    assert CONF_PASSWORD not in data
    assert flow.unique_id == "user-123"


@pytest.mark.asyncio
async def test_user_step_invalid_credentials_renders_form_with_error() -> None:
    flow = _make_flow()
    user_input = {CONF_EMAIL: "u@example.com", CONF_PASSWORD: "wrong"}

    with patch.object(
        config_flow.auth, "login", AsyncMock(return_value=None)
    ):
        result = await flow.async_step_user(user_input)

    assert result["type"] == "form"
    assert result["errors"] == {"base": "invalid_auth"}
    assert getattr(flow, "unique_id", None) is None


@pytest.mark.asyncio
async def test_user_step_no_input_shows_form() -> None:
    flow = _make_flow()
    result = await flow.async_step_user(None)
    assert result["type"] == "form"
    assert result["step_id"] == "user"
    assert result["errors"] == {}


@pytest.mark.asyncio
async def test_reauth_confirm_updates_entry_with_new_tokens() -> None:
    flow = _make_flow()
    entry = MagicMock()
    entry.data = {
        CONF_EMAIL: "u@example.com",
        CONF_ACCESS_TOKEN: "old-a",
        CONF_REFRESH_TOKEN: "old-r",
        CONF_EXPIRES_AT: 0.0,
    }
    flow._reauth_entry = entry

    new_tokens = _make_tokens(
        **{
            CONF_ACCESS_TOKEN: "new-a",
            CONF_REFRESH_TOKEN: "new-r",
            CONF_EXPIRES_AT: 1_700_000_000.0,
        }
    )

    with patch.object(
        config_flow.auth, "login", AsyncMock(return_value=new_tokens)
    ):
        result = await flow.async_step_reauth_confirm(
            {CONF_PASSWORD: "freshpw"}
        )

    flow.hass.config_entries.async_update_entry.assert_called_once()
    _, kwargs = flow.hass.config_entries.async_update_entry.call_args
    assert kwargs["data"][CONF_ACCESS_TOKEN] == "new-a"
    assert kwargs["data"][CONF_REFRESH_TOKEN] == "new-r"
    assert kwargs["data"][CONF_EXPIRES_AT] == 1_700_000_000.0
    assert kwargs["data"][CONF_EMAIL] == "u@example.com"
    assert CONF_PASSWORD not in kwargs["data"]
    assert result["type"] == "abort"
    assert result["reason"] == "reauth_successful"


@pytest.mark.asyncio
async def test_reauth_confirm_invalid_password_renders_form_with_error() -> None:
    flow = _make_flow()
    entry = MagicMock()
    entry.data = {CONF_EMAIL: "u@example.com"}
    flow._reauth_entry = entry

    with patch.object(
        config_flow.auth, "login", AsyncMock(return_value=None)
    ):
        result = await flow.async_step_reauth_confirm({CONF_PASSWORD: "bad"})

    assert result["type"] == "form"
    assert result["errors"] == {"base": "invalid_auth"}
    flow.hass.config_entries.async_update_entry.assert_not_called()
