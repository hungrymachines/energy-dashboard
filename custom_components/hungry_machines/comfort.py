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

Narrow bands (November 2026). The step and the release margin above are
sized for a band several degrees wide. In a 70-71.6 band they produced a
cycle: HEAT at the far edge (71.6), an overshoot past it, COOL at the far
edge (70.0), an undershoot, HEAT again, three reversals in forty minutes
on a heat pump. Three things stop it. The first step never crosses the
middle of the band (`_first_step`), so a correction aims at the room's
target rather than at the opposite limit. The release margin shrinks to a
third of a narrow band (`_release_margin`), so the guard can let go of a
room it has brought back to the middle. And on an Auto plan the guard
will not answer a breach in one direction within
`CROSS_LOCKOUT_SECONDS` of its own correction in the other unless the
room is `CROSS_OVERRIDE_F` past the edge: an overshoot it caused is left
to settle, with the unit stopped if it is still running.

Stopping a unit needs a unit that is running. The two OFF overrides
exist for active conditioning that ran past the far edge. A house that
floats above a night ceiling with the heat off is not that, and holding
an OFF override over it for hours only reported the guard as "in
control" of half the day. When the caller can say what the unit is doing
(`conditioning`), an OFF override fires only while it is conditioning in
the direction that caused the breach. With no such signal the override
fires as before.

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


# Auto plans only: after the guard corrects in one direction, a breach
# in the other is its own overshoot more often than weather. It is left
# alone for this long, unless the room is this far past the edge.
CROSS_LOCKOUT_SECONDS = 1800  # 30 minutes
CROSS_OVERRIDE_F = 2.0


# The room is never left below this, whatever the plan, a pause or the
# thermostat's own mode says: pipes can freeze. Crossing it heats to the
# release temperature, then hands the unit back as it was found.
FREEZE_FLOOR_F = 50.0
FREEZE_RELEASE_F = 52.0


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

# The modes under which each latch direction could have fired. A latch held
# into a mode outside its set is dropped and the breach judged afresh: an
# OFF latched on a heat evening ("too warm, keep the heat off") must not
# block a cool plan that night, and a cool day's OFF must not keep the heat
# off once the plan turns to heat.
_LATCH_MODES = {
    "cool": ("cool", "auto"),
    "heat": ("heat", "auto"),
    "off_overcool": ("cool",),
    "off_overheat": ("heat",),
}

# What the caller may say the unit is doing right now.
HEATING = "heating"
COOLING = "cooling"
IDLE = "idle"

# The guard's last finished correction, kept by the caller after the
# latch clears: {"direction": "cool"|"heat", "at": datetime}. Only the
# Auto cross-direction lockout reads it.
LastCorrection = Optional[dict]


def _release_margin(high: Optional[float], low: Optional[float]) -> float:
    """How far inside the breached edge the room must be before the guard
    lets go: `RELEASE_MARGIN_F`, or a third of the band when that is
    smaller, so a narrow band has a release point the room can reach."""
    if high is None or low is None or high <= low:
        return RELEASE_MARGIN_F
    return min(RELEASE_MARGIN_F, (high - low) / 3.0)


def _first_step(breached: float, far: Optional[float], sign: float) -> float:
    """The first setpoint of a correction: `GUARD_STEP_F` in from the
    breached edge, but never past the middle of the band. `sign` is +1
    stepping up from the floor (heat), -1 stepping down from the ceiling
    (cool)."""
    stepped = breached + sign * GUARD_STEP_F
    if far is None:
        return stepped
    mid = (breached + far) / 2.0
    return min(stepped, mid) if sign > 0 else max(stepped, mid)


def _locked_out(
    direction: str, last: LastCorrection, now: datetime, depth_f: float,
) -> bool:
    """Whether an Auto plan's guard should leave this breach alone: it
    corrected the other way within the lockout and the room is not far
    past the edge."""
    if not last or last.get("direction") == direction:
        return False
    at = last.get("at")
    if not isinstance(at, datetime):
        return False
    if (now - at).total_seconds() >= CROSS_LOCKOUT_SECONDS:
        return False
    return depth_f < CROSS_OVERRIDE_F


def decide(
    *,
    indoor: float,
    high: Optional[float],
    low: Optional[float],
    sched_mode: str,
    latch: Latch,
    now: datetime,
    overshoot_f: float = 0.0,
    conditioning: Optional[str] = None,
    last_correction: LastCorrection = None,
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
    ``conditioning`` — what the unit is doing now: ``HEATING`` / ``COOLING``
                     / ``IDLE``, or None when the caller cannot tell. An OFF
                     override needs the unit to be conditioning in the
                     direction that caused the breach; None keeps the old
                     behaviour and fires regardless.
    ``last_correction`` — the guard's last finished COOL/HEAT correction
                     (see ``LastCorrection``), for the Auto cross-direction
                     lockout. None means no recent one.

    The caller decides eligibility up front (e.g. pause flags); every slot
    is otherwise a candidate. ``new_latch`` is what the caller must persist
    back — None means "clear the latch."

    A latch whose direction ``sched_mode`` could not have produced (see
    ``_LATCH_MODES``) is dropped before anything else, without waiting out
    ``MIN_ON_SECONDS``: the mode changed under it, so the breach is judged
    again as if fresh.
    """
    active = bool(latch and latch.get("active"))
    direction = latch.get("direction") if latch else None
    if active and sched_mode not in _LATCH_MODES.get(direction, ()):
        latch, active, direction = None, False, None
    since = latch.get("since") if (latch and active) else None
    elapsed = (now - since).total_seconds() if isinstance(since, datetime) else 0.0
    held_long_enough = elapsed >= MIN_ON_SECONDS
    margin = _release_margin(high, low)

    # --- Already engaged: hold until safely back inside AND min-on met ---
    if active and direction == "cool":
        if high is None:
            return None, None
        if indoor <= high - margin and held_long_enough:
            return None, None
        # Release still measures against `high` (the breached edge); only
        # the commanded setpoint steps toward the far edge.
        command_f = latch.get("command_f")
        if command_f is None:
            command_f = _first_step(high, low, -1.0)
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
        if indoor >= low + margin and held_long_enough:
            return None, None
        command_f = latch.get("command_f")
        if command_f is None:
            command_f = _first_step(low, high, 1.0)
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
        if indoor >= low + margin and held_long_enough:
            return None, None
        # The unit has stopped and the room is only floating: nothing left
        # to hold off, so let go rather than sit "in control" for hours.
        if conditioning == IDLE and held_long_enough:
            return None, None
        return ("OFF", low), latch

    if active and direction == "off_overheat":
        if high is None:
            return None, None
        if indoor <= high - margin and held_long_enough:
            return None, None
        if conditioning == IDLE and held_long_enough:
            return None, None
        return ("OFF", high), latch

    # --- Not engaged: trigger on a fresh breach past the band edge,
    # widened by overshoot_f during calibration ---
    high_breach = high is not None and indoor > high + TRIGGER_MARGIN_F + overshoot_f
    low_breach = low is not None and indoor < low - TRIGGER_MARGIN_F - overshoot_f

    # An Auto plan answers either breach, except one that follows its own
    # correction the other way: that is left to settle, and handled below
    # like a single-direction plan (stop the unit if it is still running).
    # An OFF taken that way is re-judged every call (`_LATCH_MODES` drops
    # it under auto), so the moment the lockout ends a breach that is
    # still there gets its COOL or HEAT.
    cool_ok = sched_mode == "cool" or (
        sched_mode == "auto" and high_breach
        and not _locked_out("cool", last_correction, now, indoor - high)
    )
    heat_ok = sched_mode == "heat" or (
        sched_mode == "auto" and low_breach
        and not _locked_out("heat", last_correction, now, low - indoor)
    )

    if high_breach and cool_ok:
        command_f = _first_step(high, low, -1.0)
        return ("COOL", command_f), {
            "active": True, "direction": "cool", "since": now,
            "command_f": command_f,
        }

    if low_breach and heat_ok:
        command_f = _first_step(low, high, 1.0)
        return ("HEAT", command_f), {
            "active": True, "direction": "heat", "since": now,
            "command_f": command_f,
        }

    # Past the edge this unit cannot act on. The only thing to do is stop
    # a unit that is still pushing the room that way.
    if low_breach and sched_mode in ("cool", "auto") and conditioning in (None, COOLING):
        return ("OFF", low), {"active": True, "direction": "off_overcool", "since": now}

    if high_breach and sched_mode in ("heat", "auto") and conditioning in (None, HEATING):
        return ("OFF", high), {"active": True, "direction": "off_overheat", "since": now}

    return None, None
