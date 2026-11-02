"""units.py: HA system unit <-> °F conversion at the HA boundary."""
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from custom_components.hungry_machines import units
from custom_components.hungry_machines.units import (
    CELSIUS,
    FAHRENHEIT,
    climate_attr_f,
    from_f,
    ha_unit,
    sensor_state_f,
    to_f,
)


def _hass(unit):
    return SimpleNamespace(config=SimpleNamespace(units=SimpleNamespace(temperature_unit=unit)))


def _state(value, unit=None):
    attrs = {} if unit is None else {"unit_of_measurement": unit}
    return SimpleNamespace(state=value, attributes=attrs)


def test_constants():
    assert (CELSIUS, FAHRENHEIT) == ("°C", "°F")
    assert (units.READING_MIN_F, units.READING_MAX_F) == (30.0, 120.0)


def test_ha_unit():
    assert ha_unit(_hass("°C")) == CELSIUS
    assert ha_unit(_hass("°F")) == FAHRENHEIT
    assert ha_unit(_hass("K")) == FAHRENHEIT
    assert ha_unit(object()) == FAHRENHEIT


def test_ha_unit_magicmock_is_fahrenheit():
    assert ha_unit(MagicMock()) == FAHRENHEIT


def test_both_directions():
    assert to_f(21.0, CELSIUS) == 69.8
    assert from_f(69.8, CELSIUS) == 21.0
    assert to_f(72.123456, FAHRENHEIT) == 72.123456
    assert from_f(72.123456, FAHRENHEIT) == 72.123456
    assert from_f(32.0, CELSIUS) == 0.0
    assert to_f(-40.0, CELSIUS) == -40.0


def test_climate_attr_f():
    assert climate_attr_f(_hass("°C"), 22) == 71.6
    assert climate_attr_f(_hass("°F"), 72) == 72.0
    assert climate_attr_f(_hass("°C"), "22.5") == 72.5
    assert climate_attr_f(_hass("°C"), None) is None
    assert climate_attr_f(_hass("°C"), "unavailable") is None
    assert climate_attr_f(_hass("°C"), [1]) is None


@pytest.mark.parametrize("raw", [None, "unknown", "unavailable", "", "abc"])
def test_sensor_garbage(raw):
    assert sensor_state_f(_hass("°F"), _state(raw, "°F")) is None


def test_sensor_none_state():
    assert sensor_state_f(_hass("°F"), None) is None


def test_sensor_kelvin():
    assert sensor_state_f(_hass("°F"), _state("294.15", "K")) == 69.8


def test_sensor_celsius_on_fahrenheit_ha():
    for unit in ("°C", "C"):
        assert sensor_state_f(_hass("°F"), _state("21", unit)) == 69.8


def test_sensor_fahrenheit_on_celsius_ha():
    for unit in ("°F", "F"):
        assert sensor_state_f(_hass("°C"), _state("70", unit)) == 70.0


def test_sensor_unitless_follows_ha():
    assert sensor_state_f(_hass("°C"), _state("21")) == 69.8
    assert sensor_state_f(_hass("°F"), _state("70")) == 70.0
    assert sensor_state_f(_hass("°C"), _state("21", "weird")) == 69.8


def test_sensor_magicmock_hass_is_fahrenheit():
    assert sensor_state_f(MagicMock(), _state("70")) == 70.0
