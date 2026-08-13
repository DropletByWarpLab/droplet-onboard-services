"""Frigate NVR API client.

Manages camera configuration in Frigate by reading and updating
its config via the REST API.
"""

from __future__ import annotations

import logging
import re

import httpx

from camera_retention_defaults import build_record_block, build_snapshots_block

logger = logging.getLogger(__name__)

# WARP-1918 — the managed birdseye section. The dashboard's multi-camera
# live view (/cameras/birdseye) renders Frigate's birdseye composite, so
# the platform owns turning it on: this exact section is shipped in the
# baseline docker/frigate/config.yml AND converged onto running boxes by
# ensure_birdseye() at startup. ``mode: continuous`` (not Frigate's
# ``objects`` default) keeps idle cameras in the frame — the surface is
# "show me everything", not "show me detections".
BIRDSEYE_CONFIG: dict = {"enabled": True, "mode": "continuous"}


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

    async def ensure_birdseye(self) -> bool:
        """Converge Frigate's ``birdseye`` section on the managed config.

        Reads the *resolved* config first so an already-converged box is
        a strict no-op — ``PUT /api/config/set`` with ``requires_restart=1``
        bounces Frigate and takes every camera dark for seconds, which
        must not happen on a routine service start. When the box differs
        (birdseye disabled, or the wrong mode), the managed section is
        deep-merged in and persisted to disk, so the fix survives
        restarts and every Droplet converges without a manual box step.

        Returns True when a config write was applied, False otherwise.
        Never raises — the caller is the startup path.
        """
        try:
            config = await self.get_config()
        except Exception as e:
            logger.warning("Birdseye convergence skipped (config fetch failed): %s", e)
            return False

        current = config.get("birdseye") or {}
        if all(current.get(key) == value for key, value in BIRDSEYE_CONFIG.items()):
            logger.debug("Birdseye already enabled (mode=%s)", current.get("mode"))
            return False

        try:
            resp = await self._client.put(
                "/api/config/set",
                json={
                    "config_data": {"birdseye": dict(BIRDSEYE_CONFIG)},
                    "requires_restart": 1,
                },
            )
            body = resp.json() if resp.content else {}
            if resp.status_code in (200, 201) and body.get("success") is True:
                logger.info(
                    "Enabled birdseye in Frigate config (mode=%s)",
                    BIRDSEYE_CONFIG["mode"],
                )
                return True
            logger.warning(
                "Frigate rejected birdseye config (%d): %s",
                resp.status_code,
                str(body.get("message", resp.text))[:200],
            )
            return False
        except Exception as e:
            logger.error("Failed to enable birdseye in Frigate: %s", e)
            return False

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

        # 🔴 `record` MUST carry the retention windows explicitly. This
        # block used to be {"enabled": True}, which inherits
        # continuous: 0 / motion: 0 from Frigate's schema — the camera
        # then keeps ONLY segments overlapping an alert or detection,
        # while every surface reports "Recording" (WARP-1957).
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
                    "record": build_record_block(),
                    "snapshots": build_snapshots_block(),
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
