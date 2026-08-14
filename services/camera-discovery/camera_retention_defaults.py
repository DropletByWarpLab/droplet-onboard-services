"""What a newly adopted camera actually keeps (WARP-1957).

Mirror of ``apps/orchestrator/src/services/camera-retention-defaults.ts``.
Both adoption paths — this service's auto-adopt loop and the
orchestrator's manual ``POST /api/cameras`` — must produce the SAME
``record`` block, so the two files share environment variable names and
shipped values. Change one, change the other.

## The bug this closes

``add_camera`` used to send ``"record": {"enabled": True}`` and nothing
else. Frigate 0.17 expires against four independent windows, and the
appliance's ``docker/frigate/config.yml`` defines only ``alerts`` and
``detections`` at the top level — it has no ``continuous:`` and no
``motion:`` key at all, and Frigate's schema defaults both to **0**.

So an adopted camera decoded, detected, and kept only the segments that
overlapped an alert or detection review item, while every UI surface
reported "Recording". Measured on the box: event-only segments until
``continuous`` was hand-set, then a full 360 segments/hour.

The defaults are NOT written into ``config.yml`` on purpose — that file
is dirty-by-design on every box (Frigate rewrites it in place with live
camera registrations), so a tracked change to it makes the next deploy
checkout clobber real camera state.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

# Frigate 0.17's RecordConfig bounds pre_capture/post_capture at le=60.
# Verified against the running container's own pydantic model, not docs:
#   RecordConfig(**{"alerts": {"pre_capture": 120}})
#     -> Input should be less than or equal to 60
# Exceeding it fails the WHOLE config save, taking the rest of the camera
# block down with it.
MAX_CAPTURE_PADDING_SEC = 60
MAX_RETENTION_DAYS = 90


@dataclass(frozen=True)
class RetentionDefaults:
    """Retention applied to a camera at adoption time."""

    continuous_days: int = 3
    motion_days: int = 30
    alerts_retain_days: int = 14
    detections_retain_days: int = 14
    pre_capture_sec: int = 20
    post_capture_sec: int = 20
    snapshot_retain_days: int = 14


#: Shipped defaults, agreed 2026-08-13: three days of 24/7 footage so any
#: moment in the last 72 hours is scrubbable, a month of motion segments so
#: the interesting parts outlive that, and 20 seconds of padding each side
#: of an event so a clip opens before its trigger.
SHIPPED = RetentionDefaults()


def _env_int(name: str, fallback: int, maximum: int) -> int:
    """Read one numeric override.

    Compose writes ``FOO=`` for an unset variable, so an EMPTY STRING must
    be treated as absent — ``int("")`` raises and a naive ``or 0`` would
    silently mean "keep nothing" for a retention window.
    """
    raw = os.environ.get(name)
    if raw is None:
        return fallback
    raw = raw.strip()
    if not raw:
        return fallback
    try:
        value = int(float(raw))
    except ValueError:
        return fallback
    if value < 0:
        return fallback
    return min(value, maximum)


def resolve_defaults() -> RetentionDefaults:
    """Shipped defaults with environment overrides applied."""
    return RetentionDefaults(
        continuous_days=_env_int(
            "NVR_DEFAULT_CONTINUOUS_DAYS", SHIPPED.continuous_days, MAX_RETENTION_DAYS
        ),
        motion_days=_env_int(
            "NVR_DEFAULT_MOTION_DAYS", SHIPPED.motion_days, MAX_RETENTION_DAYS
        ),
        alerts_retain_days=_env_int(
            "NVR_DEFAULT_ALERTS_RETAIN_DAYS",
            SHIPPED.alerts_retain_days,
            MAX_RETENTION_DAYS,
        ),
        detections_retain_days=_env_int(
            "NVR_DEFAULT_DETECTIONS_RETAIN_DAYS",
            SHIPPED.detections_retain_days,
            MAX_RETENTION_DAYS,
        ),
        pre_capture_sec=_env_int(
            "NVR_DEFAULT_EVENT_PRE_CAPTURE_SEC",
            SHIPPED.pre_capture_sec,
            MAX_CAPTURE_PADDING_SEC,
        ),
        post_capture_sec=_env_int(
            "NVR_DEFAULT_EVENT_POST_CAPTURE_SEC",
            SHIPPED.post_capture_sec,
            MAX_CAPTURE_PADDING_SEC,
        ),
        snapshot_retain_days=_env_int(
            "NVR_DEFAULT_SNAPSHOT_RETAIN_DAYS",
            SHIPPED.snapshot_retain_days,
            MAX_RETENTION_DAYS,
        ),
    )


def build_record_block(defaults: RetentionDefaults | None = None) -> dict:
    """The ``record:`` block for a newly adopted camera.

    Shape matches Frigate 0.17's ``RecordConfig`` exactly — note that
    ``alerts``/``detections`` nest their days under ``retain`` while
    ``continuous``/``motion`` do not. Getting that wrong fails the save.
    """
    d = defaults or resolve_defaults()
    return {
        "enabled": True,
        "continuous": {"days": d.continuous_days},
        "motion": {"days": d.motion_days},
        "alerts": {
            "retain": {"days": d.alerts_retain_days},
            "pre_capture": d.pre_capture_sec,
            "post_capture": d.post_capture_sec,
        },
        "detections": {
            "retain": {"days": d.detections_retain_days},
            "pre_capture": d.pre_capture_sec,
            "post_capture": d.post_capture_sec,
        },
    }


def build_snapshots_block(defaults: RetentionDefaults | None = None) -> dict:
    """The ``snapshots:`` block for a newly adopted camera."""
    d = defaults or resolve_defaults()
    return {"enabled": True, "retain": {"default": d.snapshot_retain_days}}
