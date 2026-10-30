"""Home Assistant temperature unit conversion.

HA reports and accepts climate values in its system unit (°C or °F). The
backend and everything in this integration work in °F, so every value crossing
the HA boundary goes through this module. Display units are a separate
concern handled in the panel.

Deliberately imports neither scheduler nor readings.
"""
from __future__ import annotations

from typing import Any

CELSIUS = "°C"
FAHRENHEIT = "°F"

# Plausible indoor range in °F; readings outside it are sensor garbage.
READING_MIN_F = 30.0
READING_MAX_F = 120.0
# The API rejects a whole batch over one setpoint_step_f outside (0, 5].
SETPOINT_STEP_MAX_F = 5.0

_CELSIUS_UNITS = {"°c", "c"}
_FAHRENHEIT_UNITS = {"°f", "f"}
_KELVIN_UNITS = {"k"}


def ha_unit(hass: Any) -> str:
    """Return the HA system temperature unit; anything but °C reads as °F."""
    units = getattr(getattr(hass, "config", None), "units", None)
    unit = getattr(units, "temperature_unit", None)
    return CELSIUS if unit == CELSIUS else FAHRENHEIT


def to_f(value: float, unit: str) -> float:
    """Convert a value in `unit` to °F."""
    if unit == CELSIUS:
        return round(value * 9.0 / 5.0 + 32.0, 2)
    return value


def from_f(value_f: float, unit: str) -> float:
    """Convert a °F value to `unit`."""
    if unit == CELSIUS:
        return round((value_f - 32.0) * 5.0 / 9.0, 2)
    return value_f


def _coerce_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def climate_attr_f(hass: Any, value: Any) -> float | None:
    """Convert a climate attribute (system unit) to °F; None if unusable."""
    number = _coerce_float(value)
    if number is None:
        return None
    return to_f(number, ha_unit(hass))


def sensor_state_f(hass: Any, state: Any) -> float | None:
    """Read a temperature sensor state as °F, honouring its own unit."""
    number = _coerce_float(getattr(state, "state", None))
    if number is None:
        return None
    attrs = getattr(state, "attributes", None)
    raw_unit = attrs.get("unit_of_measurement") if isinstance(attrs, dict) else None
    unit = str(raw_unit or "").strip().lower()
    if unit in _CELSIUS_UNITS:
        return to_f(number, CELSIUS)
    if unit in _FAHRENHEIT_UNITS:
        return number
    if unit in _KELVIN_UNITS:
        return to_f(number - 273.15, CELSIUS)
    return to_f(number, ha_unit(hass))
