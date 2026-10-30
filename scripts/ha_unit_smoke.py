"""Real-HA unit smoke: boots HA core in the pinned image and drives our integration.

Fake hass objects cannot prove how HA converts climate values, so this uses a
real HomeAssistant object and a real generic_thermostat. No network, no API, no
credentials. Run from the repo root:

  docker run --rm --entrypoint python3 \
    -v "$PWD/hungry-machines_base-frontend/custom_components:/hm/custom_components:ro" \
    -v "$PWD/hungry-machines_base-frontend/scripts/ha_unit_smoke.py:/hm/smoke.py:ro" \
    ghcr.io/home-assistant/home-assistant:2026.6.4 /hm/smoke.py

Exit 0 means every scenario passed. Each line reports one observed value.
"""
from __future__ import annotations

import asyncio
import subprocess
import sys
import tempfile

sys.path.insert(0, "/hm")

from homeassistant import bootstrap  # noqa: E402
from homeassistant.const import EVENT_CALL_SERVICE  # noqa: E402
from homeassistant.runner import RuntimeConfig  # noqa: E402

ENTITY = "climate.hm_smoke"
SENSOR = "sensor.hm_room"
AUX_SENSOR = "sensor.hm_aux"
READINGS_MIN_F, READINGS_MAX_F = 30.0, 120.0  # hungry-machines-api routes/readings.py


def schedule(setpoint_f: float, low_f: float, high_f: float, mode: str) -> dict:
    return {
        "mode": mode,  # the comfort guard gates on this, so without it the check is vacuous
        "setpoint_temps": [setpoint_f] * 48,
        "room_target_temps": [setpoint_f] * 48,
        "high_temps": [high_f] * 48,
        "low_temps": [low_f] * 48,
        "hvac_mode_schedule": [mode] * 48,
    }


CONFIG = """
homeassistant:
  unit_system: {unit_system}
  time_zone: UTC
  name: hm-smoke
  latitude: 41.0
  longitude: -87.0
  elevation: 0
  currency: USD
  country: US
input_boolean:
  hm_unit:
climate:
  - platform: generic_thermostat
    name: hm_smoke
    unique_id: hm_smoke
    heater: input_boolean.hm_unit
    target_sensor: {sensor}
    ac_mode: {ac_mode}
    initial_hvac_mode: {mode}
    target_temp_step: {step}
"""


async def boot(unit_system: str, room: str, room_unit: str, step: float, ac_mode: bool):
    config_dir = tempfile.mkdtemp()
    with open(f"{config_dir}/configuration.yaml", "w") as f:
        f.write(
            CONFIG.format(
                unit_system=unit_system,
                sensor=SENSOR,
                ac_mode=str(ac_mode).lower(),
                mode="cool" if ac_mode else "heat",
                step=step,
            )
        )
    hass = await bootstrap.async_setup_hass(
        RuntimeConfig(config_dir=config_dir, skip_pip=True, recovery_mode=False, safe_mode=False)
    )
    assert hass is not None, "HA did not boot"
    hass.states.async_set(
        SENSOR, room, {"unit_of_measurement": room_unit, "device_class": "temperature"}
    )
    await hass.async_start()
    await hass.async_block_till_done()
    return hass


async def run_scenario(name, unit_system, room, room_unit, step, setpoint_f, ac_mode, mode, expect):
    from custom_components.hungry_machines import comfort as _comfort  # noqa: F401
    from custom_components.hungry_machines import readings, scheduler

    hass = await boot(unit_system, room, room_unit, step, ac_mode)
    failures: list[str] = []
    set_temperature_calls: list[dict] = []
    verify_runs: list[int] = []
    if expect.get("verify"):
        # The real pass, armed by _apply_hvac through async_call_later, just sooner.
        real_verify = scheduler._verify_hvac_apply
        scheduler._VERIFY_DELAY_SECONDS = 0.01

        async def counted_verify(*args, **kwargs):
            verify_runs.append(1)
            await real_verify(*args, **kwargs)

        scheduler._verify_hvac_apply = counted_verify

        def count_call(event):
            data = event.data
            if data.get("domain") == "climate" and data.get("service") == "set_temperature":
                set_temperature_calls.append(dict(data.get("service_data") or {}))

        hass.bus.async_listen(EVENT_CALL_SERVICE, count_call)
    sched = schedule(setpoint_f, 70.0, 73.0, mode)
    slot = scheduler._current_slot()
    hass.data.setdefault(scheduler.DOMAIN, {})
    await scheduler._apply_hvac(hass, ENTITY, sched, slot, appliance_name="smoke")
    await hass.async_block_till_done()
    if expect.get("verify"):
        await asyncio.sleep(0.2)
        await hass.async_block_till_done()

    state = hass.states.get(ENTITY)
    aux = None
    if "aux" in expect:
        aux = AUX_SENSOR
        hass.states.async_set(
            AUX_SENSOR, expect["aux"][0],
            {"unit_of_measurement": expect["aux"][1], "device_class": "temperature"},
        )
    reading = readings._build_hvac_home_reading(hass, state, aux, None)
    indoor = None if reading is None else reading.get("indoor_temp")
    target = state.attributes.get("temperature")
    latch = (hass.data[scheduler.DOMAIN].get("comfort_latch") or {}).get(ENTITY)
    guard_active = bool(latch and latch.get("active"))
    print(
        f"{name}: ha_unit={hass.config.units.temperature_unit} state={state.state} target={target} "
        f"min={state.attributes.get('min_temp')} max={state.attributes.get('max_temp')} "
        f"reading_indoor={indoor} guard_active={guard_active}"
        + (
            f" verify_runs={len(verify_runs)} set_temperature={set_temperature_calls}"
            if expect.get("verify") else ""
        )
    )
    if indoor is None or not READINGS_MIN_F <= float(indoor) <= READINGS_MAX_F:
        failures.append(f"reading {indoor} would fail the API's 30-120 check")
    elif abs(float(indoor) - expect["indoor_f"]) > 0.11:
        failures.append(f"reading {indoor} != {expect['indoor_f']}")
    if target is None or abs(float(target) - expect["target"]) > 0.11:
        failures.append(f"target {target} != {expect['target']}")
    if guard_active != expect.get("guard", False):
        failures.append(f"guard_active {guard_active} != {expect.get('guard', False)}")
    if expect.get("verify"):
        if len(verify_runs) != 1:
            failures.append(f"verify ran {len(verify_runs)} times, expected 1")
        if len(set_temperature_calls) != 1:
            failures.append(f"{len(set_temperature_calls)} set_temperature calls, expected 1")
    await hass.async_stop(force=True)
    for f in failures:
        print(f"  FAIL {name}: {f}")
    return failures


SCENARIOS = [
    # °F HA is the regression anchor: it must behave exactly as it does today.
    ("us-cool", "us_customary", "72", "°F", 1.0, 72.0, True, "cool",
     {"indoor_f": 72.0, "target": 72.0}),
    # 22.2 °C is inside a 70-73 °F band, so nothing should escalate.
    ("metric-cool", "metric", "22.2", "°C", 0.5, 72.0, True, "cool",
     {"indoor_f": 72.0, "target": 22.0}),
    ("metric-heat", "metric", "22.2", "°C", 0.5, 72.0, False, "heat",
     {"indoor_f": 72.0, "target": 22.0}),
    ("metric-1deg", "metric", "22", "°C", 1.0, 72.0, True, "cool",
     {"indoor_f": 71.6, "target": 22.0}),
    # An assigned room sensor that reports °C on a US HA, read through indoor_temp_entity_id.
    ("us-with-c-sensor", "us_customary", "72", "°F", 1.0, 72.0, True, "cool",
     {"indoor_f": 72.0, "target": 72.0, "aux": ("22.2", "°C")}),
    # 25 °C is 77 °F, over the band: guard commands high - GUARD_STEP_F = 71 °F, snapped to 21.5.
    ("metric-guard", "metric", "25", "°C", 0.5, 72.0, True, "cool",
     {"indoor_f": 77.0, "target": 21.5, "guard": True}),
    # A 1 °C unit holds 22 °C for a 72 °F plan; verify must read that as held, not re-send.
    ("metric-verify", "metric", "22", "°C", 1.0, 72.0, True, "cool",
     {"indoor_f": 71.6, "target": 22.0, "verify": True}),
]


if __name__ == "__main__":
    # HA's bootstrap can only run once per process, so each scenario gets its own.
    if len(sys.argv) > 1:
        failed = asyncio.run(run_scenario(*SCENARIOS[int(sys.argv[1])]))
        sys.exit(1 if failed else 0)
    bad = 0
    for i in range(len(SCENARIOS)):
        rc = subprocess.run([sys.executable, __file__, str(i)], check=False).returncode
        bad += 1 if rc else 0
    print(f"RESULT: {len(SCENARIOS)} scenarios, {bad} failed")
    sys.exit(1 if bad else 0)
