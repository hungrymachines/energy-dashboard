"""Closed-loop comfort-band failsafe: the pure decision core.

The backend schedule is OPEN-LOOP — computed overnight from a predicted
temperature trajectory. When the building heats or cools faster than the
thermal model expected, reality drifts out of the comfort band while the
schedule keeps commanding OFF. Only the HA integration sees the live
indoor temperature, so the failsafe that pulls the house back into band
lives on this side.

This module is the pure, Home-Assistant-free heart of that failsafe: a
hysteresis state machine with no I/O, so it can be unit-tested with plain
pytest (the integration has no HA test harness). `scheduler.py` wraps it
with the entity reads, latch persistence, and service calls.

Hysteresis (why three thresholds, not one):
  * TRIGGER at the band edge — the moment the room is past the limit, act.
    Comfort-first: users feel a 1°F excursion, so don't wait for a margin.
  * RELEASE only once the room is back INSIDE the band by
    `RELEASE_MARGIN_F`, not merely back at the edge. Releasing at the edge
    would hand control back to the scheduled OFF, the room would climb
    past the edge again within minutes, and the compressor would
    short-cycle. The release deadband is what breaks that loop.
  * MIN_ON_SECONDS — once engaged, keep conditioning at least this long
    even if the sensor briefly reads back inside. Belt-and-suspenders
    against compressor short-cycling on sensor noise.

Which edge is commanded (why a STEP, not the far edge): a high breach
in cool/auto commands COOL at ``high - GUARD_STEP_F`` (clamped at
``low``), not the far edge outright. Commanding the BREACHED edge
itself is a no-op on the units that need the guard most — a window
unit whose internal thermostat reads a few degrees below the room is
already parked at that setpoint, so re-sending it changes nothing and
the room stays over the ceiling. But jumping straight to the far edge
overshoots by the SAME gap: a unit that runs until its own sensor
reaches ``low`` keeps going well past the point where the ROOM reaches
``low``. A small step is enough to make the unit run at all; if the
room is still past ``high`` after ``MIN_ON_SECONDS``, the command
steps down by another ``GUARD_STEP_F``, still clamped at ``low`` —
escalating gradually instead of overshooting in one jump. A slot with
no far edge to clamp against steps unclamped. ``RELEASE_MARGIN_F``,
not the setpoint, still bounds the excursion: the guard releases once
the room is back inside the BREACHED edge by that margin. Heat mirrors
this: COOL at ``high - GUARD_STEP_F`` becomes HEAT at
``low + GUARD_STEP_F``, stepping up instead of down.

Eligibility (which slots this runs against) is decided entirely by the
caller -- every slot is a candidate, including one that already commands
COOL/HEAT, since active conditioning can itself overshoot past the far
band edge (a unit that doesn't respect its own setpoint precisely, or a
schedule mode that only ever commands one direction).

`overshoot_f` widens both trigger thresholds (not the release thresholds)
by this many degrees. The caller passes a non-zero value during
calibration: the plan may deliberately produce a bounded excursion while
the thermal model is still being learned, and the guard should tolerate
that without going deaf to a genuine runaway.
"""
from __future__ import annotations

from datetime import datetime
from typing import Optional, Tuple

# Fire the moment the room is past the band edge — no trigger margin.
# The release deadband + minimum on-time below prevent short-cycling, so
# there's no need to let the excursion grow before acting.
TRIGGER_MARGIN_F = 0.0

# Keep conditioning until the room is back inside the band by this much.
# Releasing exactly at the edge would immediately resume the scheduled
# OFF and let the room drift back out, flapping the compressor.
RELEASE_MARGIN_F = 1.0

# Command a STEP toward the far edge, not the far edge itself — see the
# module docstring. Escalates by this many degrees every MIN_ON_SECONDS
# the room is still past the breached edge, clamped at the far edge.
GUARD_STEP_F = 2.0

# Minimum time to hold an override once engaged, regardless of how fast
# the room comes back — a hard floor on compressor cycle length.
MIN_ON_SECONDS = 600  # 10 minutes


# An override decision: (canonical_mode, edge) or None to apply the
# schedule as-is. canonical_mode is "COOL" / "HEAT" / "OFF". For COOL/HEAT,
# edge is the setpoint to command — a step toward the far band edge (see
# GUARD_STEP_F and the module docstring), not the far edge outright; the
# release margin, not the setpoint, is what stops the excursion. For OFF,
# edge is the crossed band edge for logging/context only; the caller
# issues no setpoint.
Override = Optional[Tuple[str, float]]

# The per-entity latch persisted by the caller between calls. Shape:
#   {"active": True, "direction": "cool"|"heat"|"off_overcool"|"off_overheat",
#    "since": datetime, "command_f": float}
# or None when no override is engaged. "command_f" is only present for
# "cool"/"heat" (the setpoint last commanded, so a later tick can step
# further from it without recomputing history — keeps `decide` pure).
# "off_overcool"/"off_overheat" mean active conditioning ran past the far
# band edge and was stopped; they carry no "command_f".
Latch = Optional[dict]


def decide(
    *,
    indoor: float,
    high: Optional[float],
    low: Optional[float],
    sched_mode: str,
    latch: Latch,
    now: datetime,
    overshoot_f: float = 0.0,
) -> Tuple[Override, Latch]:
    """Pure hysteresis step. Returns ``(override, new_latch)``.

    ``indoor``     — live indoor temperature (°F).
    ``high``/``low`` — this slot's comfort-band edges (°F), or None if the
                     schedule doesn't carry that bound for the slot.
    ``sched_mode`` — the day's mode: ``cool`` / ``heat`` / ``auto`` gates
                     which override kind may fire; anything else → no
                     override. Four kinds, gated by mode and which edge is
                     breached: overheat+cool/auto → COOL, stepping down
                     from ``high`` by ``GUARD_STEP_F`` per hold, clamped at
                     ``low`` (unclamped when the slot has no ``low``);
                     undercool+heat/auto → HEAT, stepping up from ``low``
                     by ``GUARD_STEP_F`` per hold, clamped at ``high``
                     (unclamped when absent); overcool+cool (actively
                     cooling past ``low``) → OFF; overheat+heat (actively
                     heating past ``high``) → OFF.
    ``latch``      — the caller's persisted latch (see ``Latch``), or None.
    ``now``        — current time; drives the minimum-on-time clock.
    ``overshoot_f`` — widens both trigger thresholds by this many degrees
                     (trigger above ``high + overshoot_f`` / below
                     ``low - overshoot_f``); release thresholds are always
                     relative to the true band edges, unaffected by this.

    The caller decides eligibility up front (e.g. pause flags); every slot
    is otherwise a candidate. ``new_latch`` is what the caller must persist
    back — None means "clear the latch."
    """
    active = bool(latch and latch.get("active"))
    direction = latch.get("direction") if latch else None
    since = latch.get("since") if (latch and active) else None
    elapsed = (now - since).total_seconds() if isinstance(since, datetime) else 0.0
    held_long_enough = elapsed >= MIN_ON_SECONDS

    # --- Already engaged: hold until safely back inside AND min-on met ---
    if active and direction == "cool":
        if high is None:
            return None, None
        if indoor <= high - RELEASE_MARGIN_F and held_long_enough:
            return None, None
        # Release still measures against `high` (the breached edge); only
        # the commanded setpoint steps toward the far edge.
        command_f = latch.get("command_f")
        if command_f is None:
            command_f = max(low, high - GUARD_STEP_F) if low is not None else high - GUARD_STEP_F
        if indoor > high and held_long_enough:
            command_f = command_f - GUARD_STEP_F
            if low is not None:
                command_f = max(low, command_f)
            return ("COOL", command_f), {
                "active": True, "direction": "cool", "since": now,
                "command_f": command_f,
            }
        return ("COOL", command_f), latch

    if active and direction == "heat":
        if low is None:
            return None, None
        if indoor >= low + RELEASE_MARGIN_F and held_long_enough:
            return None, None
        command_f = latch.get("command_f")
        if command_f is None:
            command_f = min(high, low + GUARD_STEP_F) if high is not None else low + GUARD_STEP_F
        if indoor < low and held_long_enough:
            command_f = command_f + GUARD_STEP_F
            if high is not None:
                command_f = min(high, command_f)
            return ("HEAT", command_f), {
                "active": True, "direction": "heat", "since": now,
                "command_f": command_f,
            }
        return ("HEAT", command_f), latch

    if active and direction == "off_overcool":
        if low is None:
            return None, None
        if indoor >= low + RELEASE_MARGIN_F and held_long_enough:
            return None, None
        return ("OFF", low), latch

    if active and direction == "off_overheat":
        if high is None:
            return None, None
        if indoor <= high - RELEASE_MARGIN_F and held_long_enough:
            return None, None
        return ("OFF", high), latch

    # --- Not engaged: trigger on a fresh breach past the band edge,
    # widened by overshoot_f during calibration ---
    high_breach = high is not None and indoor > high + TRIGGER_MARGIN_F + overshoot_f
    low_breach = low is not None and indoor < low - TRIGGER_MARGIN_F - overshoot_f

    if high_breach and sched_mode in ("cool", "auto"):
        command_f = max(low, high - GUARD_STEP_F) if low is not None else high - GUARD_STEP_F
        return ("COOL", command_f), {
            "active": True, "direction": "cool", "since": now,
            "command_f": command_f,
        }

    if low_breach and sched_mode in ("heat", "auto"):
        command_f = min(high, low + GUARD_STEP_F) if high is not None else low + GUARD_STEP_F
        return ("HEAT", command_f), {
            "active": True, "direction": "heat", "since": now,
            "command_f": command_f,
        }

    if low_breach and sched_mode == "cool":
        return ("OFF", low), {"active": True, "direction": "off_overcool", "since": now}

    if high_breach and sched_mode == "heat":
        return ("OFF", high), {"active": True, "direction": "off_overheat", "since": now}

    return None, None
