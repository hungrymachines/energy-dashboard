"""Plain-language health lines for the Home Assistant log.

Each feature or device reports under a stable key. A problem logs a WARNING
when it starts and again every 24 hours while it lasts; the first good report
and every recovery log at INFO. Steady state logs nothing, so a 5-minute caller
cannot flood the log.

Deliberately imports neither scheduler nor readings.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)
# Home Assistant's root logger sits at WARNING, which would hide every "this
# is working" line. A `logger:` entry for this module still takes priority.
_LOGGER.setLevel(logging.INFO)

_HEALTH_KEY = "health"
_REWARN_AFTER = timedelta(hours=24)


def _health(hass: Any) -> dict[str, dict]:
    return hass.data.setdefault(DOMAIN, {}).setdefault(_HEALTH_KEY, {})


def report(
    hass: Any, key: str, ok: bool, message: str, *args: Any, error: bool = False,
) -> None:
    """Record `key`'s state and log `message` if that is news.

    `error` logs a problem at ERROR instead of WARNING.
    """
    health = _health(hass)
    prev = health.get(key)
    now = datetime.now(timezone.utc)
    if ok:
        health[key] = {"ok": True}
        if prev is None or not prev["ok"]:
            _LOGGER.info("Hungry Machines: " + message, *args)
        return
    if prev is None or prev["ok"] or now - prev["warned_at"] >= _REWARN_AFTER:
        level = logging.ERROR if error else logging.WARNING
        _LOGGER.log(level, "Hungry Machines: " + message, *args)
        health[key] = {"ok": False, "warned_at": now}


def note(message: str, *args: Any) -> None:
    """Log a good-news line that is not tied to a state change."""
    _LOGGER.info("Hungry Machines: " + message, *args)


def forget(hass: Any, key: str) -> None:
    """Drop `key`, so its next good report logs again."""
    _health(hass).pop(key, None)
