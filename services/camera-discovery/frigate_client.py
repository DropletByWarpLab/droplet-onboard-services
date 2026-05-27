"""Frigate NVR API client.

Manages camera configuration in Frigate by reading and updating
its config via the REST API.
"""

from __future__ import annotations

import logging
import re
from urllib.parse import quote

import httpx

logger = logging.getLogger(__name__)


# WARP-400 §5 — per-vendor RTSP URL templates.
#
# Pre-fix, `accept_camera` blindly handed Frigate whatever URL the
# rtsp_prober had stashed. For a Hanwha that hadn't yet initialised
# (or for the placeholder fallback at rtsp_prober.py:318) that URL is
# wrong (Hikvision-shape `/Streaming/Channels/101` instead of
# Hanwha's `/profile2/media.smp`), so Frigate keeps the camera in
# "loading" forever. With the vendor known (the
# `initialize_camera` flow yields `InitResult.vendor`) we can build
# the right URL from a small table that covers every vendor whose
# `init-cgi`/setup endpoint we know about.
#
# `{user}` and `{pw}` are url-encoded by `build_rtsp_url`. Don't pre-
# encode them in the templates — the format-string substitution would
# double-encode.
VENDOR_RTSP_TEMPLATES: dict[str, str] = {
    "hanwha":    "rtsp://{user}:{pw}@{ip}:554/profile2/media.smp",
    "hikvision": "rtsp://{user}:{pw}@{ip}:554/Streaming/Channels/101",
    "axis":      "rtsp://{user}:{pw}@{ip}:554/axis-media/media.amp",
    "dahua":     "rtsp://{user}:{pw}@{ip}:554/cam/realmonitor?channel=1&subtype=0",
    "reolink":   "rtsp://{user}:{pw}@{ip}:554/h264Preview_01_main",
    "amcrest":   "rtsp://{user}:{pw}@{ip}:554/cam/realmonitor?channel=1&subtype=0",
}


class UnsupportedVendor(ValueError):
    """Raised when we don't have an RTSP template for the given vendor."""


def build_rtsp_url(vendor: str, ip: str, user: str, pw: str) -> str:
    """Build a credentialed RTSP URL for a known camera vendor.

    Once Phase 2's accept_camera plumbing lands, this replaces the
    placeholder URL from rtsp_prober.py:318 for any vendor we know.
    For vendors we don't have a template for, callers should fall back
    to the discovered URL from the probe.
    """
    if not ip:
        raise ValueError("ip is required")
    # Templates hardcode `:554`, so an embedded port on `ip` would
    # double-up (`192.168.1.10:8554:554`). Today's callers
    # (urlparse().hostname from ONVIF, separate ip/port fields in
    # rtsp_prober) all pass bare IPs, so no current path triggers this
    # — but reject it loudly so a future caller doesn't silently ship
    # a malformed URL to Frigate.
    if ":" in ip:
        raise ValueError(
            f"ip must be a bare address without port (got {ip!r}); "
            "templates supply the RTSP port",
        )
    vendor_key = (vendor or "").strip().lower()
    template = VENDOR_RTSP_TEMPLATES.get(vendor_key)
    if not template:
        raise UnsupportedVendor(f"no RTSP template for vendor={vendor!r}")
    return template.format(
        user=quote(user or "", safe=""),
        pw=quote(pw or "", safe=""),
        ip=ip,
    )


class FrigateClient:
    """HTTP client for the Frigate NVR API."""

    def __init__(self, base_url: str):
        self.base_url = base_url.rstrip("/")
        self._client = httpx.AsyncClient(base_url=self.base_url, timeout=15.0)

    async def health_check(self) -> bool:
        """Check if Frigate is reachable."""
        try:
            resp = await self._client.get("/api/version")
            return resp.status_code == 200
        except (httpx.HTTPError, OSError):
            return False

    async def get_config(self) -> dict:
        """Get the current Frigate configuration."""
        resp = await self._client.get("/api/config")
        resp.raise_for_status()
        return resp.json()

    async def get_cameras(self) -> dict:
        """Get status of all configured cameras."""
        resp = await self._client.get("/api/stats")
        resp.raise_for_status()
        data = resp.json()
        return data.get("cameras", {})

    async def get_events(self, limit: int = 20, camera: str | None = None) -> list[dict]:
        """Get recent detection events."""
        params: dict = {"limit": limit}
        if camera:
            params["camera"] = camera
        resp = await self._client.get("/api/events", params=params)
        resp.raise_for_status()
        return resp.json()

    async def get_stats(self) -> dict:
        """Get Frigate system stats (CPU, GPU, storage)."""
        resp = await self._client.get("/api/stats")
        resp.raise_for_status()
        return resp.json()

    async def get_snapshot(self, camera_name: str, height: int = 480) -> bytes:
        """Get latest snapshot from a camera."""
        resp = await self._client.get(
            f"/api/{camera_name}/latest.jpg",
            params={"h": height},
        )
        resp.raise_for_status()
        return resp.content

    async def add_camera(self, name: str, rtsp_url: str, detect: bool = True) -> bool:
        """Add a camera to Frigate configuration.

        Uses Frigate's config API to add a new camera entry.
        Returns True if the camera was successfully added.
        """
        # Sanitize camera name: lowercase, alphanumeric + underscores only
        safe_name = re.sub(r"[^a-z0-9_]", "_", name.lower()).strip("_")

        camera_config = {
            "cameras": {
                safe_name: {
                    "ffmpeg": {
                        "inputs": [
                            {
                                "path": rtsp_url,
                                "roles": ["detect", "record"],
                            }
                        ]
                    },
                    "detect": {
                        "enabled": detect,
                        "width": 1280,
                        "height": 720,
                        "fps": 5,
                    },
                    "record": {
                        "enabled": True,
                    },
                    "snapshots": {
                        "enabled": True,
                    },
                }
            }
        }

        try:
            # Frigate 0.17 replaced the POST + flat body with a PUT that
            # expects the ConfigSetBody envelope:
            #   {"config_data": <nested yaml dict>, "requires_restart": 0|1}
            # The query-string path (``?foo.bar=baz``) is reserved for
            # single-field dotted updates and doesn't fit a whole
            # camera block. ``requires_restart=1`` persists to disk AND
            # schedules an internal reload; ``=0`` applies live where
            # possible. Cameras require a full restart to start capture,
            # so ``=1`` is the right default for the add flow.
            resp = await self._client.put(
                "/api/config/set",
                json={
                    "config_data": camera_config,
                    "requires_restart": 1,
                },
            )
            if resp.status_code in (200, 201):
                body = resp.json() if resp.content else {}
                # Missing ``success`` key defaults to False: Frigate 0.17
                # always sets it, so absence means the response shape
                # changed and we shouldn't assume a silent add worked.
                if body.get("success") is True:
                    logger.info(
                        "Added camera %s to Frigate (triggering restart)",
                        safe_name,
                    )
                    # ``requires_restart=1`` persists the change on disk
                    # but on 0.17 doesn't always bounce capture workers —
                    # a belt-and-suspenders POST /api/restart makes the
                    # camera show up in /api/stats immediately.
                    await self._trigger_restart(safe_name)
                    return True
                logger.warning(
                    "Frigate config set rejected camera %s: %s",
                    safe_name, body.get("message", "")[:200],
                )
                return False

            logger.warning(
                "Frigate config set returned %d for camera %s: %s",
                resp.status_code,
                safe_name,
                resp.text[:200],
            )
            return False
        except Exception as e:
            logger.error("Failed to add camera %s to Frigate: %s", safe_name, e)
            return False

    async def _trigger_restart(self, camera_name: str) -> None:
        """Kick Frigate so a newly-added camera actually loads.

        Best-effort: we already staged the config so a manual bounce
        would still pick the change up. Swallow errors rather than
        failing the add — the caller already logged success.
        """
        try:
            resp = await self._client.post("/api/restart")
            if resp.status_code >= 400:
                logger.warning(
                    "Frigate restart returned %d after adding %s: %s",
                    resp.status_code, camera_name, resp.text[:200],
                )
        except Exception as exc:
            logger.warning(
                "Frigate restart failed after adding %s: %s", camera_name, exc
            )

    async def remove_camera(self, name: str) -> bool:
        """Remove a camera from Frigate configuration."""
        try:
            resp = await self._client.delete(f"/api/config/cameras/{name}")
            return resp.status_code in (200, 204)
        except Exception as e:
            logger.error("Failed to remove camera %s: %s", name, e)
            return False

    async def enable_camera(self, name: str) -> bool:
        """Enable detection on a camera."""
        try:
            resp = await self._client.post(f"/api/{name}/detect/enable")
            return resp.status_code == 200
        except Exception as e:
            logger.error("Failed to enable camera %s: %s", name, e)
            return False

    async def disable_camera(self, name: str) -> bool:
        """Disable detection on a camera."""
        try:
            resp = await self._client.post(f"/api/{name}/detect/disable")
            return resp.status_code == 200
        except Exception as e:
            logger.error("Failed to disable camera %s: %s", name, e)
            return False

    async def close(self):
        await self._client.aclose()
