"""Top-level conftest for the Python integration tests.

The integration code imports ``homeassistant.*``, ``aiohttp``, and
``voluptuous`` at module load time. RALPH stories must run offline with no
real Home Assistant install (see CLAUDE.md "Env Var Policy"), so this
conftest installs lightweight stubs into ``sys.modules`` before any test
module is collected. Tests then patch behavior on these stubs as needed.
"""
from __future__ import annotations

import sys
import types
from typing import Any
from unittest.mock import AsyncMock, MagicMock


def _ensure_module(name: str) -> types.ModuleType:
    if name not in sys.modules:
        sys.modules[name] = types.ModuleType(name)
    return sys.modules[name]


def _install_stubs() -> None:
    # --- aiohttp -------------------------------------------------------------
    aiohttp_mod = _ensure_module("aiohttp")
    if not hasattr(aiohttp_mod, "ClientError"):

        class ClientError(Exception):
            """Stub of aiohttp.ClientError."""

        aiohttp_mod.ClientError = ClientError

    # --- voluptuous ----------------------------------------------------------
    vol_mod = _ensure_module("voluptuous")
    if not hasattr(vol_mod, "Schema"):

        class _Marker:
            def __init__(self, key: Any, default: Any = None, **kw: Any) -> None:
                self.key = key
                self.default = default
                self.kw = kw

            def __hash__(self) -> int:
                return hash(self.key)

            def __eq__(self, other: Any) -> bool:
                if isinstance(other, _Marker):
                    return self.key == other.key
                return self.key == other

            def __repr__(self) -> str:
                return f"<{type(self).__name__} {self.key!r}>"

        class Required(_Marker):
            pass

        class Optional(_Marker):
            pass

        class Schema:
            def __init__(self, schema: Any = None) -> None:
                self.schema = schema

            def __call__(self, value: Any) -> Any:
                return value

        def _In(values: Any) -> Any:
            return MagicMock(name="vol.In", values=values)

        vol_mod.Schema = Schema
        vol_mod.Required = Required
        vol_mod.Optional = Optional
        vol_mod.In = _In

    # --- homeassistant -------------------------------------------------------
    _ensure_module("homeassistant")
    _ensure_module("homeassistant.components")
    _ensure_module("homeassistant.helpers")

    core = _ensure_module("homeassistant.core")
    if not hasattr(core, "HomeAssistant"):

        class HomeAssistant:
            """Stub HomeAssistant; tests use MagicMock instances instead."""

        def callback(func):
            return func

        core.HomeAssistant = HomeAssistant
        core.callback = callback

    config_entries = _ensure_module("homeassistant.config_entries")
    if not hasattr(config_entries, "ConfigFlow"):

        class ConfigEntry:
            """Stub ConfigEntry; tests use MagicMock instances."""

        class ConfigFlow:
            VERSION = 1

            def __init_subclass__(cls, *, domain: str | None = None, **kw: Any) -> None:
                cls.domain = domain
                super().__init_subclass__(**kw)

            async def async_set_unique_id(
                self, unique_id: str, *, raise_on_progress: bool = True
            ) -> None:
                self.unique_id = unique_id

            def _abort_if_unique_id_configured(self) -> None:
                # Tests do not exercise the abort path; behave as if no
                # entry conflicts.
                return None

            def async_create_entry(
                self, *, title: str, data: dict[str, Any], **kw: Any
            ) -> dict[str, Any]:
                return {
                    "type": "create_entry",
                    "title": title,
                    "data": data,
                    **kw,
                }

            def async_show_form(
                self,
                *,
                step_id: str,
                data_schema: Any = None,
                errors: dict[str, str] | None = None,
                description_placeholders: dict[str, Any] | None = None,
                **kw: Any,
            ) -> dict[str, Any]:
                return {
                    "type": "form",
                    "step_id": step_id,
                    "data_schema": data_schema,
                    "errors": errors or {},
                    "description_placeholders": description_placeholders or {},
                    **kw,
                }

            def async_abort(self, *, reason: str, **kw: Any) -> dict[str, Any]:
                return {"type": "abort", "reason": reason, **kw}

        class OptionsFlow:
            def async_create_entry(
                self, *, title: str, data: dict[str, Any], **kw: Any
            ) -> dict[str, Any]:
                return {
                    "type": "create_entry",
                    "title": title,
                    "data": data,
                    **kw,
                }

            def async_show_form(
                self,
                *,
                step_id: str,
                data_schema: Any = None,
                errors: dict[str, str] | None = None,
                **kw: Any,
            ) -> dict[str, Any]:
                return {
                    "type": "form",
                    "step_id": step_id,
                    "data_schema": data_schema,
                    "errors": errors or {},
                    **kw,
                }

        config_entries.ConfigEntry = ConfigEntry
        config_entries.ConfigFlow = ConfigFlow
        config_entries.OptionsFlow = OptionsFlow
        config_entries.ConfigFlowResult = dict

    aiohttp_helper = _ensure_module("homeassistant.helpers.aiohttp_client")
    if not hasattr(aiohttp_helper, "async_get_clientsession"):
        aiohttp_helper.async_get_clientsession = MagicMock(
            name="async_get_clientsession",
            return_value=MagicMock(name="ClientSession"),
        )

    event_helper = _ensure_module("homeassistant.helpers.event")
    if not hasattr(event_helper, "async_track_time_change"):
        event_helper.async_track_time_change = MagicMock(
            name="async_track_time_change",
            return_value=MagicMock(name="unsub"),
        )

    selector_helper = _ensure_module("homeassistant.helpers.selector")
    if not hasattr(selector_helper, "TextSelector"):

        class _Selector:
            def __init__(self, config: Any = None) -> None:
                self.config = config

            def __call__(self, value: Any) -> Any:
                return value

        class TextSelectorConfig:
            def __init__(self, **kw: Any) -> None:
                self.kw = kw

        class _TextSelectorType:
            EMAIL = "email"
            PASSWORD = "password"
            TEXT = "text"

        class EntitySelectorConfig:
            def __init__(self, **kw: Any) -> None:
                self.kw = kw

        selector_helper.TextSelector = _Selector
        selector_helper.TextSelectorConfig = TextSelectorConfig
        selector_helper.TextSelectorType = _TextSelectorType
        selector_helper.EntitySelector = _Selector
        selector_helper.EntitySelectorConfig = EntitySelectorConfig

    frontend_mod = _ensure_module("homeassistant.components.frontend")
    if not hasattr(frontend_mod, "add_extra_js_url"):
        frontend_mod.add_extra_js_url = MagicMock(name="add_extra_js_url")
        frontend_mod.async_register_built_in_panel = MagicMock(
            name="async_register_built_in_panel"
        )
        frontend_mod.async_remove_panel = MagicMock(name="async_remove_panel")

    http_mod = _ensure_module("homeassistant.components.http")
    if not hasattr(http_mod, "StaticPathConfig"):

        class StaticPathConfig:
            def __init__(self, *args: Any, **kw: Any) -> None:
                self.args = args
                self.kw = kw

        http_mod.StaticPathConfig = StaticPathConfig


_install_stubs()
