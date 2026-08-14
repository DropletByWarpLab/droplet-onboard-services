"""WARP-1957 — auto-adopted cameras must actually keep footage.

This service's auto-adopt loop is the path most cameras arrive through,
so the bug bit hardest here: ``add_camera`` sent ``record: {enabled: True}``
and nothing else, and Frigate 0.17 defaults ``continuous`` and ``motion``
to 0. The camera decoded, detected, and kept only segments overlapping an
alert or detection review item.

The expected block below was validated against the RUNNING Frigate 0.17.1
container on the production box — ``RecordConfig(**block)`` accepted it —
and the orchestrator's TypeScript builder emits a byte-identical payload.
"""

from __future__ import annotations

import pytest

from camera_retention_defaults import (
    MAX_CAPTURE_PADDING_SEC,
    MAX_RETENTION_DAYS,
    SHIPPED,
    build_record_block,
    build_snapshots_block,
    resolve_defaults,
)


@pytest.fixture(autouse=True)
def _clear_overrides(monkeypatch):
    """Start each case from the shipped defaults, not the dev shell's env."""
    for name in (
        "NVR_DEFAULT_CONTINUOUS_DAYS",
        "NVR_DEFAULT_MOTION_DAYS",
        "NVR_DEFAULT_ALERTS_RETAIN_DAYS",
        "NVR_DEFAULT_DETECTIONS_RETAIN_DAYS",
        "NVR_DEFAULT_EVENT_PRE_CAPTURE_SEC",
        "NVR_DEFAULT_EVENT_POST_CAPTURE_SEC",
        "NVR_DEFAULT_SNAPSHOT_RETAIN_DAYS",
    ):
        monkeypatch.delenv(name, raising=False)


def test_adopted_camera_keeps_continuous_and_motion_footage():
    """THE regression: both of these used to inherit 0."""
    d = resolve_defaults()
    assert d.continuous_days > 0
    assert d.motion_days > 0


def test_record_block_matches_what_frigate_accepted():
    assert build_record_block() == {
        "enabled": True,
        "continuous": {"days": 3},
        "motion": {"days": 30},
        "alerts": {
            "retain": {"days": 14},
            "pre_capture": 20,
            "post_capture": 20,
        },
        "detections": {
            "retain": {"days": 14},
            "pre_capture": 20,
            "post_capture": 20,
        },
    }


def test_days_nest_under_retain_only_for_alerts_and_detections():
    """Frigate's model is extra="forbid" — wrong depth fails the WHOLE save."""
    block = build_record_block()
    assert block["continuous"] == {"days": 3}
    assert "retain" not in block["continuous"]
    assert block["alerts"]["retain"] == {"days": 14}
    assert "days" not in block["alerts"]


def test_snapshots_get_an_explicit_window():
    assert build_snapshots_block() == {"enabled": True, "retain": {"default": 14}}


def test_environment_overrides_are_honoured(monkeypatch):
    monkeypatch.setenv("NVR_DEFAULT_CONTINUOUS_DAYS", "7")
    monkeypatch.setenv("NVR_DEFAULT_MOTION_DAYS", "45")
    d = resolve_defaults()
    assert d.continuous_days == 7
    assert d.motion_days == 45


def test_zero_is_a_legitimate_operator_choice(monkeypatch):
    """Deliberate 0 is respected; the bug was the ACCIDENTAL 0."""
    monkeypatch.setenv("NVR_DEFAULT_CONTINUOUS_DAYS", "0")
    assert resolve_defaults().continuous_days == 0


@pytest.mark.parametrize("blank", ["", "   "])
def test_empty_value_means_unset_not_zero(monkeypatch, blank):
    """Compose writes ``FOO=`` for an unset variable.

    Coercing that to 0 would silently mean "keep nothing" — the same
    footgun as ``${VAR:-}`` defeating a schema default elsewhere.
    """
    monkeypatch.setenv("NVR_DEFAULT_CONTINUOUS_DAYS", blank)
    assert resolve_defaults().continuous_days == SHIPPED.continuous_days


@pytest.mark.parametrize("garbage", ["three", "-4", "NaN"])
def test_garbage_falls_back_rather_than_writing_a_broken_config(monkeypatch, garbage):
    monkeypatch.setenv("NVR_DEFAULT_MOTION_DAYS", garbage)
    assert resolve_defaults().motion_days == SHIPPED.motion_days


def test_capture_padding_is_clamped_to_frigates_bound(monkeypatch):
    """pre_capture=120 raises "less than or equal to 60" and fails the save."""
    monkeypatch.setenv("NVR_DEFAULT_EVENT_PRE_CAPTURE_SEC", "120")
    monkeypatch.setenv("NVR_DEFAULT_EVENT_POST_CAPTURE_SEC", "999")
    d = resolve_defaults()
    assert d.pre_capture_sec == MAX_CAPTURE_PADDING_SEC
    assert d.post_capture_sec == MAX_CAPTURE_PADDING_SEC


def test_retention_days_are_clamped(monkeypatch):
    monkeypatch.setenv("NVR_DEFAULT_MOTION_DAYS", "9999")
    assert resolve_defaults().motion_days == MAX_RETENTION_DAYS


@pytest.mark.asyncio
async def test_add_camera_sends_retention_on_the_wire(monkeypatch):
    """The block must reach Frigate, not merely exist in a helper."""
    from frigate_client import FrigateClient

    captured: dict = {}

    class _Resp:
        status_code = 200
        # add_camera guards its json() with `if resp.content`, and
        # _trigger_restart reads .text on failure — a stub missing either
        # fails inside the client's own try/except and returns False,
        # which would look exactly like a rejected config.
        content = b'{"success": true}'
        text = ""

        def raise_for_status(self):
            return None

        def json(self):
            return {"success": True}

    class _Client:
        async def put(self, url, json=None, **kwargs):
            captured["url"] = url
            captured["json"] = json
            return _Resp()

        async def post(self, url, **kwargs):
            captured.setdefault("posts", []).append(url)
            return _Resp()

    client = FrigateClient.__new__(FrigateClient)
    client._client = _Client()

    ok = await client.add_camera("Front Door", "rtsp://10.0.0.5:554/s")
    assert ok is True

    cam = captured["json"]["config_data"]["cameras"]["front_door"]
    assert cam["record"]["continuous"]["days"] > 0
    assert cam["record"]["motion"]["days"] > 0
    assert 0 < cam["record"]["alerts"]["pre_capture"] <= MAX_CAPTURE_PADDING_SEC
    assert cam["snapshots"]["retain"]["default"] > 0
