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

# Minimum time to hold an override once engaged, regardless of how fast
# the room comes back — a hard floor on compressor cycle length.
MIN_ON_SECONDS = 600  # 10 minutes


# An override decision: (canonical_mode, edge) or None to apply the
# schedule as-is. canonical_mode is "COOL" / "HEAT" / "OFF". For COOL/HEAT,
# edge is the setpoint to command — the unit pulls the house just back to
# the limit, then the schedule resumes. For OFF, edge is the crossed band
# edge for logging/context only; the caller issues no setpoint.
Override = Optional[Tuple[str, float]]

# The per-entity latch persisted by the caller between calls. Shape:
#   {"active": True, "direction": "cool"|"heat"|"off_overcool"|"off_overheat",
#    "since": datetime}
# or None when no override is engaged. "off_overcool"/"off_overheat" mean
# active conditioning ran past the far band edge and was stopped.
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
                     breached: overheat+cool/auto → COOL at ``high``;
                     undercool+heat/auto → HEAT at ``low``; overcool+cool
                     (actively cooling past ``low``) → OFF; overheat+heat
                     (actively heating past ``high``) → OFF.
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
        return ("COOL", high), latch

    if active and direction == "heat":
        if low is None:
            return None, None
        if indoor >= low + RELEASE_MARGIN_F and held_long_enough:
            return None, None
        return ("HEAT", low), latch

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
        return ("COOL", high), {"active": True, "direction": "cool", "since": now}

    if low_breach and sched_mode in ("heat", "auto"):
        return ("HEAT", low), {"active": True, "direction": "heat", "since": now}

    if low_breach and sched_mode == "cool":
        return ("OFF", low), {"active": True, "direction": "off_overcool", "since": now}

    if high_breach and sched_mode == "heat":
        return ("OFF", high), {"active": True, "direction": "off_overheat", "since": now}

    return None, None
