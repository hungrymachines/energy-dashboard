"""Config flow for the Hungry Machines integration.

The user supplies their hungrymachines.io email + password (the same
credentials they use on the website and in the panel). We exchange those
for access + refresh tokens and store ONLY the tokens (plus the email and
chosen climate entity) in the config entry. Reauth re-prompts for the
password if the refresh token ever stops working.
"""
from __future__ import annotations

from typing import Any

import voluptuous as vol
from homeassistant.config_entries import (
    ConfigEntry,
    ConfigFlow,
    ConfigFlowResult,
    OptionsFlow,
)
from homeassistant.core import callback

from . import auth
from .const import (
    CONF_ACCESS_TOKEN,
    CONF_CLIMATE_ENTITY,
    CONF_EMAIL,
    CONF_EXPIRES_AT,
    CONF_PASSWORD,
    CONF_REFRESH_TOKEN,
    CONF_USER_ID,
    DOMAIN,
    INTEGRATION_NAME,
)

try:
    from homeassistant.helpers.selector import (
        EntitySelector,
        EntitySelectorConfig,
        TextSelector,
        TextSelectorConfig,
        TextSelectorType,
    )

    _SELECTORS_AVAILABLE = True
except ImportError:  # pragma: no cover — older HA fallback
    _SELECTORS_AVAILABLE = False


def _email_field() -> Any:
    if _SELECTORS_AVAILABLE:
        return TextSelector(TextSelectorConfig(type=TextSelectorType.EMAIL))
    return str


def _password_field() -> Any:
    if _SELECTORS_AVAILABLE:
        return TextSelector(
            TextSelectorConfig(type=TextSelectorType.PASSWORD)
        )
    return str


def _climate_field(hass: Any) -> Any:
    if _SELECTORS_AVAILABLE:
        return EntitySelector(EntitySelectorConfig(domain="climate"))
    return vol.In(hass.states.async_entity_ids("climate"))


def _user_schema(hass: Any, defaults: dict[str, Any] | None = None) -> vol.Schema:
    defaults = defaults or {}
    return vol.Schema(
        {
            vol.Required(
                CONF_EMAIL, default=defaults.get(CONF_EMAIL, "")
            ): _email_field(),
            vol.Required(CONF_PASSWORD): _password_field(),
            vol.Required(
                CONF_CLIMATE_ENTITY,
                default=defaults.get(CONF_CLIMATE_ENTITY, ""),
            ): _climate_field(hass),
        }
    )


def _reauth_schema() -> vol.Schema:
    return vol.Schema({vol.Required(CONF_PASSWORD): _password_field()})


def _options_schema(hass: Any, current: str | None) -> vol.Schema:
    return vol.Schema(
        {
            vol.Required(
                CONF_CLIMATE_ENTITY, default=current or ""
            ): _climate_field(hass),
        }
    )


class HungryMachinesConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle the user-initiated config flow."""

    VERSION = 1

    def __init__(self) -> None:
        self._reauth_entry: ConfigEntry | None = None

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Initial setup: collect credentials + climate entity, exchange for tokens."""
        errors: dict[str, str] = {}

        if user_input is not None:
            tokens = await auth.login(
                self.hass,
                user_input[CONF_EMAIL],
                user_input[CONF_PASSWORD],
            )
            if tokens is None:
                errors["base"] = "invalid_auth"
            else:
                user_id = tokens.get(CONF_USER_ID) or DOMAIN
                await self.async_set_unique_id(user_id)
                self._abort_if_unique_id_configured()

                entry_data = {
                    CONF_EMAIL: tokens.get(CONF_EMAIL)
                    or user_input[CONF_EMAIL],
                    CONF_ACCESS_TOKEN: tokens[CONF_ACCESS_TOKEN],
                    CONF_REFRESH_TOKEN: tokens[CONF_REFRESH_TOKEN],
                    CONF_EXPIRES_AT: tokens[CONF_EXPIRES_AT],
                    CONF_CLIMATE_ENTITY: user_input[CONF_CLIMATE_ENTITY],
                }
                return self.async_create_entry(
                    title=INTEGRATION_NAME, data=entry_data
                )

        return self.async_show_form(
            step_id="user",
            data_schema=_user_schema(
                self.hass,
                defaults={CONF_EMAIL: (user_input or {}).get(CONF_EMAIL, "")},
            ),
            errors=errors,
        )

    async def async_step_reauth(
        self, entry_data: dict[str, Any]
    ) -> ConfigFlowResult:
        """Triggered when refresh stops working."""
        self._reauth_entry = self.hass.config_entries.async_get_entry(
            self.context["entry_id"]
        )
        return await self.async_step_reauth_confirm()

    async def async_step_reauth_confirm(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Re-prompt for password and refresh tokens in place."""
        errors: dict[str, str] = {}
        entry = self._reauth_entry

        if entry is None:  # pragma: no cover — defensive
            return self.async_abort(reason="reauth_no_entry")

        existing_email = entry.data.get(CONF_EMAIL, "")

        if user_input is not None:
            tokens = await auth.login(
                self.hass, existing_email, user_input[CONF_PASSWORD]
            )
            if tokens is None:
                errors["base"] = "invalid_auth"
            else:
                self.hass.config_entries.async_update_entry(
                    entry,
                    data={
                        **entry.data,
                        CONF_ACCESS_TOKEN: tokens[CONF_ACCESS_TOKEN],
                        CONF_REFRESH_TOKEN: tokens[CONF_REFRESH_TOKEN],
                        CONF_EXPIRES_AT: tokens[CONF_EXPIRES_AT],
                    },
                )
                return self.async_abort(reason="reauth_successful")

        return self.async_show_form(
            step_id="reauth_confirm",
            data_schema=_reauth_schema(),
            description_placeholders={"email": existing_email},
            errors=errors,
        )

    @staticmethod
    @callback
    def async_get_options_flow(
        config_entry: ConfigEntry,
    ) -> "HungryMachinesOptionsFlow":
        return HungryMachinesOptionsFlow(config_entry)


class HungryMachinesOptionsFlow(OptionsFlow):
    """Allow changing the climate entity after setup."""

    def __init__(self, config_entry: ConfigEntry) -> None:
        self._entry = config_entry

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        if user_input is not None:
            return self.async_create_entry(title="", data=user_input)

        current = self._entry.options.get(
            CONF_CLIMATE_ENTITY
        ) or self._entry.data.get(CONF_CLIMATE_ENTITY)
        return self.async_show_form(
            step_id="init",
            data_schema=_options_schema(self.hass, current),
        )
