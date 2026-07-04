"""Unit tests for the pure comfort-band hysteresis state machine.

These import `comfort.py` directly — it has no Home Assistant dependency —
so they run under plain pytest without an HA test harness. The HA-coupled
wrapper (`scheduler._comfort_band_override`) and the 5-min watchdog are
integration-tested manually; the risk that needs automated coverage is the
hysteresis logic (trigger / release deadband / minimum on-time), which
lives entirely here.

Run: pytest custom_components/hungry_machines/tests/test_comfort.py
"""
from datetime import datetime, timedelta, timezone

from hungry_machines import comfort


T0 = datetime(2026, 7, 4, 14, 0, 0, tzinfo=timezone.utc)


def _cool_schedule_state(latch=None, now=T0, indoor=80.0, high=76.0, low=64.0):
    return comfort.decide(
        indoor=indoor, high=high, low=low, sched_mode="cool", latch=latch, now=now,
    )


def test_no_breach_no_override():
    """In-band room with no latch → nothing happens."""
    override, latch = comfort.decide(
        indoor=74.0, high=76.0, low=64.0, sched_mode="cool", latch=None, now=T0,
    )
    assert override is None
    assert latch is None


def test_trigger_fires_the_moment_past_the_limit():
    """Cooling: indoor just past the high edge → COOL at the band edge."""
    override, latch = comfort.decide(
        indoor=76.1, high=76.0, low=64.0, sched_mode="cool", latch=None, now=T0,
    )
    assert override == ("COOL", 76.0)
    assert latch["active"] is True
    assert latch["direction"] == "cool"
    assert latch["since"] == T0


def test_exactly_at_edge_does_not_trigger():
    """At the edge is still in band — only STRICTLY past it triggers."""
    override, latch = comfort.decide(
        indoor=76.0, high=76.0, low=64.0, sched_mode="cool", latch=None, now=T0,
    )
    assert override is None
    assert latch is None


def test_heat_direction_triggers_on_low_breach():
    override, latch = comfort.decide(
        indoor=63.9, high=76.0, low=64.0, sched_mode="heat", latch=None, now=T0,
    )
    assert override == ("HEAT", 64.0)
    assert latch["direction"] == "heat"


def test_auto_mode_covers_both_directions():
    hi, _ = comfort.decide(
        indoor=80.0, high=76.0, low=64.0, sched_mode="auto", latch=None, now=T0,
    )
    lo, _ = comfort.decide(
        indoor=60.0, high=76.0, low=64.0, sched_mode="auto", latch=None, now=T0,
    )
    assert hi == ("COOL", 76.0)
    assert lo == ("HEAT", 64.0)


def test_unknown_mode_never_overrides():
    override, latch = comfort.decide(
        indoor=90.0, high=76.0, low=64.0, sched_mode="", latch=None, now=T0,
    )
    assert override is None
    assert latch is None


def test_min_on_time_holds_even_after_room_recovers():
    """Latched, room already back inside, but < MIN_ON_SECONDS elapsed →
    keep conditioning (short-cycle guard)."""
    latch = {"active": True, "direction": "cool", "since": T0}
    # 5 minutes later, room is well back inside the band.
    override, new_latch = comfort.decide(
        indoor=70.0, high=76.0, low=64.0, sched_mode="cool",
        latch=latch, now=T0 + timedelta(seconds=300),
    )
    assert override == ("COOL", 76.0)
    assert new_latch is latch  # unchanged, still engaged


def test_releases_only_when_inside_by_release_margin_and_min_on_met():
    """After MIN_ON_SECONDS AND back inside by RELEASE_MARGIN_F → release."""
    latch = {"active": True, "direction": "cool", "since": T0}
    later = T0 + timedelta(seconds=comfort.MIN_ON_SECONDS + 1)
    # Back inside by exactly the release margin (76 - 1.0 = 75.0).
    override, new_latch = comfort.decide(
        indoor=75.0, high=76.0, low=64.0, sched_mode="cool",
        latch=latch, now=later,
    )
    assert override is None
    assert new_latch is None


def test_does_not_release_at_band_edge_even_after_min_on():
    """Min-on elapsed but room only back AT the edge (not inside by the
    release margin) → keep conditioning. This is the anti-short-cycle
    deadband: releasing here would let it climb straight back out."""
    latch = {"active": True, "direction": "cool", "since": T0}
    later = T0 + timedelta(seconds=comfort.MIN_ON_SECONDS + 60)
    override, new_latch = comfort.decide(
        indoor=75.5, high=76.0, low=64.0, sched_mode="cool",
        latch=latch, now=later,
    )
    assert override == ("COOL", 76.0)
    assert new_latch is latch


def test_still_hot_after_min_on_keeps_conditioning():
    latch = {"active": True, "direction": "cool", "since": T0}
    later = T0 + timedelta(seconds=comfort.MIN_ON_SECONDS + 600)
    override, new_latch = comfort.decide(
        indoor=79.0, high=76.0, low=64.0, sched_mode="cool",
        latch=latch, now=later,
    )
    assert override == ("COOL", 76.0)
    assert new_latch is latch


def test_heat_release_symmetric():
    """Heating latch releases once inside by the margin and min-on met."""
    latch = {"active": True, "direction": "heat", "since": T0}
    later = T0 + timedelta(seconds=comfort.MIN_ON_SECONDS + 1)
    # low=64, release when indoor >= 64 + 1.0 = 65.0
    still_low, l1 = comfort.decide(
        indoor=64.5, high=76.0, low=64.0, sched_mode="heat", latch=latch, now=later,
    )
    assert still_low == ("HEAT", 64.0)
    released, l2 = comfort.decide(
        indoor=65.0, high=76.0, low=64.0, sched_mode="heat", latch=latch, now=later,
    )
    assert released is None
    assert l2 is None


def test_missing_band_edge_while_latched_clears():
    """If the slot lacks the relevant band edge while latched, fail safe
    to released rather than command against a missing limit."""
    latch = {"active": True, "direction": "cool", "since": T0}
    override, new_latch = comfort.decide(
        indoor=80.0, high=None, low=64.0, sched_mode="cool",
        latch=latch, now=T0 + timedelta(seconds=900),
    )
    assert override is None
    assert new_latch is None


def test_idempotent_within_same_instant():
    """Calling twice with the same `now` yields the same result and latch
    — the watchdog relies on this because it evaluates, then _apply_hvac
    re-evaluates, within the same tick."""
    # Enter.
    o1, l1 = _cool_schedule_state(latch=None)
    o2, l2 = _cool_schedule_state(latch=l1)
    assert o1 == o2 == ("COOL", 76.0)
    assert l2 is l1  # stays engaged, `since` not bumped

    # Release.
    latch = {"active": True, "direction": "cool", "since": T0}
    later = T0 + timedelta(seconds=comfort.MIN_ON_SECONDS + 10)
    r1, rl1 = comfort.decide(
        indoor=70.0, high=76.0, low=64.0, sched_mode="cool", latch=latch, now=later,
    )
    r2, rl2 = comfort.decide(
        indoor=70.0, high=76.0, low=64.0, sched_mode="cool", latch=rl1, now=later,
    )
    assert r1 is None and r2 is None
    assert rl1 is None and rl2 is None
