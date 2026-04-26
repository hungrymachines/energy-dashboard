"""Hungry Machines — Home Assistant integration.

Registers the bundled JavaScript frontend so the panel and Lovelace cards
load automatically once the integration is configured. The user never has
to edit configuration.yaml.
"""
from __future__ import annotations

import logging
from pathlib import Path

from homeassistant.components.frontend import (
    add_extra_js_url,
    async_register_built_in_panel,
    async_remove_panel,
)
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .const import (
    DOMAIN,
    PANEL_ICON,
    PANEL_NAME,
    PANEL_TITLE,
    PANEL_URL_PATH,
    SCRIPT_FILENAME,
    SCRIPT_URL,
)

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Hungry Machines from a config entry."""
    frontend_file = Path(__file__).parent / "frontend" / SCRIPT_FILENAME

    if not frontend_file.is_file():
        _LOGGER.error(
            "Hungry Machines frontend bundle missing at %s. "
            "Reinstall via HACS or download the latest release from "
            "https://github.com/hungrymachines/energy-dashboard/releases.",
            frontend_file,
        )
        return False

    await hass.http.async_register_static_paths(
        [StaticPathConfig(SCRIPT_URL, str(frontend_file), False)]
    )

    add_extra_js_url(hass, SCRIPT_URL)

    async_register_built_in_panel(
        hass,
        component_name="custom",
        sidebar_title=PANEL_TITLE,
        sidebar_icon=PANEL_ICON,
        frontend_url_path=PANEL_URL_PATH,
        config={
            "_panel_custom": {
                "name": PANEL_NAME,
                "embed_iframe": False,
                "trust_external": False,
                "module_url": SCRIPT_URL,
            }
        },
        require_admin=False,
    )

    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Remove the panel registration when the integration is removed."""
    async_remove_panel(hass, PANEL_URL_PATH)
    return True
