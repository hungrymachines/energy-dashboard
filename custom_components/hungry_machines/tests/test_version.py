"""Tests for custom_components.hungry_machines.version (US-CTL-006).

The `client` object rides on every readings push so fleet diagnostics
can answer "which build is this home running?". Shape is pinned by
`ClientInfo` in the backend's `app/routes/readings.py`: `kind` is a
Literal['hacs','node'] and `version` must be 1-40 chars, so both are
asserted here as well as the HACS/node split itself.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from hungry_machines import api, version


def _entry() -> MagicMock:
    e = MagicMock()
    e.entry_id = "abc"
    e.data = {}
    e.options = {}
    return e


def test_client_info_hacs_when_node_bundle_unset(monkeypatch):
    monkeypatch.delenv(version.NODE_BUNDLE_ENV, raising=False)

    info = version.build_client_info()

    assert info == {
        "kind": "hacs",
        "version": version.MANIFEST_VERSION,
        "node_bundle": None,
        "ha_version": "2025.7.0",
    }
    # The backend's ClientInfo bounds `version` at 1-40 chars.
    assert 1 <= len(info["version"]) <= 40


def test_client_info_node_when_node_bundle_set(monkeypatch):
    monkeypatch.setenv(version.NODE_BUNDLE_ENV, "0.2.5")

    info = version.build_client_info()

    assert info["kind"] == "node"
    assert info["node_bundle"] == "0.2.5"
    assert info["version"] == version.MANIFEST_VERSION


def test_client_info_treats_empty_node_bundle_as_hacs(monkeypatch):
    """An empty `HM_NODE_BUNDLE=` in compose must not claim to be a node."""
    monkeypatch.setenv(version.NODE_BUNDLE_ENV, "")

    info = version.build_client_info()

    assert info["kind"] == "hacs"
    assert info["node_bundle"] is None


def test_manifest_version_matches_manifest_json():
    import json
    from pathlib import Path

    manifest = json.loads(
        (Path(version.__file__).parent / "manifest.json").read_text()
    )
    assert version.MANIFEST_VERSION == manifest["version"]


@pytest.mark.asyncio
async def test_post_home_readings_sends_the_client_object(monkeypatch):
    monkeypatch.delenv(version.NODE_BUNDLE_ENV, raising=False)
    request = AsyncMock(return_value={"inserted": 1})

    with patch.object(api, "_authenticated_request", request):
        ok = await api.post_home_readings(
            MagicMock(), _entry(), [{"indoor_temp": 72.0}]
        )

    assert ok is True
    body = request.await_args.kwargs["json"]
    assert body["readings"] == [{"indoor_temp": 72.0}]
    assert body["client"]["kind"] == "hacs"
    assert body["client"]["version"] == version.MANIFEST_VERSION


@pytest.mark.asyncio
async def test_post_home_readings_skips_empty_batch(monkeypatch):
    """No readings means no request at all — and so no client stamp."""
    request = AsyncMock(return_value={"inserted": 0})

    with patch.object(api, "_authenticated_request", request):
        ok = await api.post_home_readings(MagicMock(), _entry(), [])

    assert ok is False
    request.assert_not_awaited()
