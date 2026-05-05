"""Tests for custom_components.hungry_machines.config_flow."""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from hungry_machines import config_flow
from hungry_machines.const import (
    CONF_ACCESS_TOKEN,
    CONF_CLIMATE_ENTITY,
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
async def test_user_step_success_creates_entry_without_password() -> None:
    flow = _make_flow()
    user_input = {
        CONF_EMAIL: "u@example.com",
        CONF_PASSWORD: "secret",
        CONF_CLIMATE_ENTITY: "climate.living_room",
    }

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
    assert data[CONF_CLIMATE_ENTITY] == "climate.living_room"
    assert CONF_PASSWORD not in data
    assert flow.unique_id == "user-123"


@pytest.mark.asyncio
async def test_user_step_invalid_credentials_renders_form_with_error() -> None:
    flow = _make_flow()
    user_input = {
        CONF_EMAIL: "u@example.com",
        CONF_PASSWORD: "wrong",
        CONF_CLIMATE_ENTITY: "climate.living_room",
    }

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
        CONF_CLIMATE_ENTITY: "climate.living_room",
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
    # Email + climate entity preserved from prior entry
    assert kwargs["data"][CONF_EMAIL] == "u@example.com"
    assert kwargs["data"][CONF_CLIMATE_ENTITY] == "climate.living_room"
    # Password is never persisted
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


@pytest.mark.asyncio
async def test_options_flow_persists_climate_entity() -> None:
    entry = MagicMock()
    entry.data = {CONF_CLIMATE_ENTITY: "climate.old"}
    entry.options = {}

    options = config_flow.HungryMachinesOptionsFlow(entry)
    options.hass = MagicMock()

    result = await options.async_step_init(
        {CONF_CLIMATE_ENTITY: "climate.new"}
    )

    assert result["type"] == "create_entry"
    assert result["data"] == {CONF_CLIMATE_ENTITY: "climate.new"}


@pytest.mark.asyncio
async def test_options_flow_no_input_shows_form_with_current_default() -> None:
    entry = MagicMock()
    entry.data = {CONF_CLIMATE_ENTITY: "climate.old"}
    entry.options = {}

    options = config_flow.HungryMachinesOptionsFlow(entry)
    options.hass = MagicMock()

    result = await options.async_step_init(None)

    assert result["type"] == "form"
    assert result["step_id"] == "init"
