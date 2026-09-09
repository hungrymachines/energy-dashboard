"""Client identity — which build of which integration is talking to the API.

The backend stamps `users.client_kind` / `client_version` /
`client_node_bundle` from the `client` object on every readings push and
raises a `client_version_change` fleet event when it moves
(`app/routes/readings.py`). That lets fleet diagnostics answer "which
build is this home running?" without asking the customer.

Two deployments share this integration:

* **HACS** — the customer installed the package into their own Home
  Assistant. Nothing sets `HM_NODE_BUNDLE`, so `kind` is `"hacs"` and
  `node_bundle` is None.
* **Fleet node** — `hm-node/docker-compose.yml` passes `HM_NODE_BUNDLE`
  into the Home Assistant container, so the bundle version rides along
  with the integration version and `kind` is `"node"`.

`MANIFEST_VERSION` lives here rather than in `__init__.py` so `api.py`
can read it: the package `__init__` imports `readings`, which imports
`api`, so anything `api` pulls from `__init__` would land mid-import.
`__init__` re-exports it for backwards compatibility.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from homeassistant.const import __version__ as HA_VERSION

NODE_BUNDLE_ENV = "HM_NODE_BUNDLE"


def _read_manifest_version() -> str:
    """Read the integration version from manifest.json.

    Called once at module import time (synchronous, before HA's event
    loop starts) and cached in MANIFEST_VERSION below. Reading it lazily
    instead would trip HA's blocking-IO-on-event-loop warning per
    https://developers.home-assistant.io/docs/asyncio_blocking_operations/
    """
    try:
        with (Path(__file__).parent / "manifest.json").open() as f:
            return str(json.load(f).get("version") or "0")
    except (OSError, ValueError):
        return "0"


# Read once at import. HA imports custom_components synchronously during
# integration loading (before the event loop fully spins up), so doing
# the file IO here is safe.
MANIFEST_VERSION = _read_manifest_version()


def build_client_info() -> dict[str, Any]:
    """The `client` object sent with every readings push.

    Shape matches `ClientInfo` in `app/routes/readings.py`: `kind` is a
    Literal['hacs','node'], `version` is 1-40 chars, the other two are
    optional. Read `HM_NODE_BUNDLE` per call rather than at import so a
    node that gains the variable on its next restart reports it without
    a code change.
    """
    node_bundle = os.environ.get(NODE_BUNDLE_ENV) or None
    return {
        "kind": "node" if node_bundle else "hacs",
        "version": MANIFEST_VERSION,
        "node_bundle": node_bundle,
        "ha_version": HA_VERSION,
    }
