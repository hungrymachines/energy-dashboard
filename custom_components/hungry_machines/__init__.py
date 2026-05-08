"""Hungry Machines — Home Assistant integration.

v2.0+: drives a closed control loop across every registered appliance.

* **Sensor read** (every 5 min) — `readings.push_all_readings` walks the
  user's appliances, reads each one's HA entity, and POSTs the appropriate
  shape (home reading for HVAC, per-appliance reading for the rest).
* **Schedule fetch** (daily at 05:05 local) — `scheduler.fetch_today_schedule`
  pulls `/api/v1/schedules` and caches each appliance's schedule + entity_id.
* **Schedule apply** (every :00 / :30) — `scheduler.apply_current_slot`
  iterates the cache and calls the right service per appliance type:
  `climate.set_temperature` for HVAC, `switch.turn_on/off` for the rest.
* **Weather push** (daily at 03:30 UTC) — `weather.push_today_forecast`
  reads the user's HA weather entity and POSTs its forecast so the API's
  nightly optimizer prefers it over Open-Meteo.
"""
from __future__ import annotations

import json
import logging
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
from homeassistant.helpers.event import async_track_time_change

from . import readings, weather
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


def _read_manifest_version() -> str:
    """Read the integration version from manifest.json.

    Called once at module import time (synchronous, before HA's event
    loop starts) and cached in MANIFEST_VERSION below. The previous
    inline call from _ensure_frontend_registered triggered HA's
    blocking-IO-on-event-loop warning per
    https://developers.home-assistant.io/docs/asyncio_blocking_operations/
    """
    try:
        with (Path(__file__).parent / "manifest.json").open() as f:
            return str(json.load(f).get("version") or "0")
    except (OSError, ValueError):
        return "0"


# Read once at import. HA imports custom_components synchronously during
# integration loading (before the event loop fully spins up), so doing
# the file IO here is safe — and avoids the blocking-call warning when
# we use the value below to build the cache-busting JS URL.
MANIFEST_VERSION = _read_manifest_version()


async def _ensure_frontend_registered(hass: HomeAssistant) -> bool:
    """Idempotently serve the bundled JS at SCRIPT_URL.

    HA's static-path and extra_js_url APIs are process-lifetime, not
    per-entry. Registering them in async_setup_entry triggers
    'route already registered' errors on entry reload / re-add, so we
    guard with a flag in hass.data and only register once per HA process.

    The static path itself is registered without a version (HA's static
    handler ignores query strings), but the URL we hand to
    add_extra_js_url carries `?v=<manifest version>` so browsers treat
    each release as a distinct resource and fetch fresh after an update.
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
    versioned_url = f"{SCRIPT_URL}?v={MANIFEST_VERSION}"
    add_extra_js_url(hass, versioned_url)
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

    # v2.1+: capture every 5 min into an in-memory buffer; flush to the
    # API once per hour. Same data shape, ~12× fewer API calls.
    async def _capture_readings(_now) -> None:
        await readings.capture_readings(hass, entry)

    async def _flush_readings(_now) -> None:
        await readings.flush_readings(hass, entry)

    unsubs.append(
        async_track_time_change(
            hass,
            _capture_readings,
            minute=[0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55],
            second=0,
        )
    )
    # Flush 2 min after the hour so the :00 capture has landed in the
    # buffer first. The flush still fires hourly — the offset just
    # ensures the buffer for that hour is complete before we post.
    unsubs.append(
        async_track_time_change(
            hass, _flush_readings, minute=2, second=0
        )
    )

    # Daily weather push at 03:30 UTC, just before the API's nightly
    # optimizer fires at 04:00 UTC. Skip silently if the user hasn't
    # picked a weather entity in the panel Settings yet.
    async def _push_weather(_now) -> None:
        await weather.push_today_forecast(hass, entry)

    unsubs.append(
        async_track_time_change(
            hass, _push_weather, hour=3, minute=30, second=0
        )
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
    # v2.1+: capture+flush timers live in entry_data['unsub'] above, so
    # the legacy 'readings_unsub' key is no longer maintained.
    domain_data.pop("readings_unsub", None)

    async_remove_panel(hass, PANEL_URL_PATH)
    return True
