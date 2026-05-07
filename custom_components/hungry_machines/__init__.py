"""Hungry Machines — Home Assistant integration.

Registers the bundled JavaScript frontend, then keeps the user's optimized
HVAC schedule fresh and applies it to their climate entity on each
30-minute boundary throughout the day.
"""
from __future__ import annotations

import logging
from datetime import timedelta
from pathlib import Path

from typing import Any

from homeassistant.components.frontend import (
    add_extra_js_url,
    async_register_built_in_panel,
    async_remove_panel,
)
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.event import (
    async_track_time_change,
    async_track_time_interval,
)

from . import readings
from .const import (
    DOMAIN,
    PANEL_ICON,
    PANEL_NAME,
    PANEL_TITLE,
    PANEL_URL_PATH,
    SCRIPT_FILENAME,
    SCRIPT_URL,
)
from .scheduler import apply_current_slot, fetch_today_schedule

_LOGGER = logging.getLogger(__name__)

_FRONTEND_REGISTERED = "_frontend_registered"


async def _ensure_frontend_registered(hass: HomeAssistant) -> bool:
    """Idempotently serve the bundled JS at SCRIPT_URL.

    HA's static-path and extra_js_url APIs are process-lifetime, not
    per-entry. Registering them in async_setup_entry triggers
    'route already registered' errors on entry reload / re-add, so we
    guard with a flag in hass.data and only register once per HA process.
    """
    domain_data = hass.data.setdefault(DOMAIN, {})
    if domain_data.get(_FRONTEND_REGISTERED):
        return True

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
    domain_data[_FRONTEND_REGISTERED] = True
    return True


async def async_setup(hass: HomeAssistant, config: dict[str, Any]) -> bool:
    """Component-level setup — register the JS bundle once per HA process."""
    return await _ensure_frontend_registered(hass)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Hungry Machines from a config entry."""
    if not await _ensure_frontend_registered(hass):
        return False

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

    domain_data = hass.data[DOMAIN]
    entry_data = domain_data.setdefault(entry.entry_id, {})
    unsubs: list = entry_data.setdefault("unsub", [])

    await fetch_today_schedule(hass, entry)

    async def _refresh_schedule(_now) -> None:
        await fetch_today_schedule(hass, entry)

    async def _apply_slot(_now) -> None:
        await apply_current_slot(hass, entry)

    unsubs.append(
        async_track_time_change(
            hass, _refresh_schedule, hour=5, minute=5, second=0
        )
    )
    unsubs.append(
        async_track_time_change(
            hass, _apply_slot, minute=[0, 30], second=0
        )
    )

    def _push_reading(_now) -> None:
        hass.async_create_task(readings.push_current_reading(hass, entry))

    domain_data["readings_unsub"] = async_track_time_interval(
        hass, _push_reading, timedelta(minutes=5)
    )

    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Remove the panel registration when the integration is removed."""
    domain_data = hass.data.get(DOMAIN, {})
    entry_data = domain_data.get(entry.entry_id, {})
    for unsub in entry_data.get("unsub", []):
        try:
            unsub()
        except Exception as err:  # noqa: BLE001
            _LOGGER.warning(
                "Hungry Machines unsubscribe failed: %s", err
            )
    domain_data.pop(entry.entry_id, None)

    readings_unsub = domain_data.pop("readings_unsub", None)
    if readings_unsub is not None:
        try:
            readings_unsub()
        except Exception as err:  # noqa: BLE001
            _LOGGER.warning(
                "Hungry Machines readings unsubscribe failed: %s", err
            )

    async_remove_panel(hass, PANEL_URL_PATH)
    return True
