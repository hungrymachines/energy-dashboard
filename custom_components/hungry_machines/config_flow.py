"""Config flow for the Hungry Machines integration.

Single-step user flow: confirm and create one entry. There is nothing to
configure here — sign-in to the Hungry Machines API happens in the panel
itself, with the JWT stored in the browser. The integration only exists
so HA registers the frontend resource and the sidebar panel automatically.
"""
from __future__ import annotations

from typing import Any

from homeassistant.config_entries import ConfigFlow, ConfigFlowResult

from .const import DOMAIN, INTEGRATION_NAME


class HungryMachinesConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle the user-initiated config flow."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Single confirmation step — only one instance is allowed."""
        await self.async_set_unique_id(DOMAIN)
        self._abort_if_unique_id_configured()

        if user_input is not None:
            return self.async_create_entry(title=INTEGRATION_NAME, data={})

        return self.async_show_form(step_id="user")
