"""Bring-up provisioner — reconcile the managed switch to a desired VLAN state.

ADR-018 action item 9 (switch auto-provisioning on bring-up, shape-aware,
camera-safe). This is the *system* provisioning path that runs once on service
bring-up (see ``main.py`` lifespan + ``POST /provision``). It is DISTINCT from
the orchestrator's Tier-2 human-confirmation switch path
(``apps/orchestrator/src/routes/switch.ts``): no user is in the loop here, so
the routine is deliberately conservative — explicit desired state, read before
write, backup before the first write, read-back-verify after every write, and
a hard refusal to isolate the camera VLAN unless the routing service confirms
the inter-VLAN routing actually exists (item 9 depends on item 3).

Design rules honoured (droplet-architecture-guard):
  * Rule 10 — desired state comes from EXPLICIT config (SWITCH_VLAN_PROFILE et
    al.), never inferred from the absence of a VLAN or a port.
  * Rule 9  — this is a one-shot reconcile, invoked by an event (bring-up or
    ``POST /provision``); there is NO polling loop here.
  * ASIC seam — only the abstract ``SwitchDriver`` contract is used; no
    driver specifics leak above ``drivers/base.py``.

The routine is idempotent: it reads live membership, computes the delta against
the desired state, and writes ONLY the ports that differ. A second run against
an already-correct switch writes nothing (and takes no backup).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Optional, Protocol

from drivers.base import SwitchDriver, SwitchError

logger = logging.getLogger("droplet.switch.provisioner")

# Role-based VLAN ids for the segmented profile. These mirror the openwrt /
# handbook isolation posture and the existing `setup/cameras` default (100).
# They are NOT created under the flat-lan profile.
LAN_VLAN = 1
CAMERA_VLAN = 100
AP_VLAN = 50

VALID_PROFILES = ("flat-lan", "segmented")


class RoutingCrossCheck(Protocol):
    """The one read the segmented profile double-gates on.

    Returns the EXPLICIT camera-interface presence flag from the routing
    service (``cameras.present``), or ``None`` when presence can't be
    determined. Never inferred from absence (ADR-018 / rule 10).
    """

    async def cameras_present(self) -> Optional[bool]:  # pragma: no cover - Protocol
        ...


@dataclass
class ProvisionConfig:
    """Explicit desired state for the switch. Sourced from env in main.py.

    ``protected_port`` is the uplink/trunk port that is NEVER moved off the
    LAN/trunk (severing it would cut the box off). Empty port lists are the
    safe default — flat-lan needs no port hints at all (it just pulls strays
    back to VLAN 1); segmented falls back to "no ports to isolate" rather than
    guessing.
    """

    profile: str = "flat-lan"
    protected_port: int = 0
    camera_ports: list[int] = field(default_factory=list)
    ap_ports: list[int] = field(default_factory=list)
    client_ports: list[int] = field(default_factory=list)


def _result(
    status: str,
    profile_applied: str,
    ports_changed: Optional[list[int]] = None,
    skipped_reason: Optional[str] = None,
) -> dict:
    return {
        "status": status,
        "profile_applied": profile_applied,
        "ports_changed": ports_changed or [],
        "skipped_reason": skipped_reason,
    }


async def _read_access_pvids(driver: SwitchDriver) -> Optional[dict[int, int]]:
    """Read each access port's current untagged VLAN (PVID), confirming the
    VLAN read subsystem is reachable.

    Returns ``None`` (NOT an empty dict) when the switch can't be read — the
    v1.04.0079 firmware returns 404 for ``/stat/port`` / ``/stat/vlan`` /
    ``/stat/vlan_membership`` (driver-fix note). Any one of those endpoints
    faulting means we cannot compute a trustworthy delta, so we tell the caller
    to no-op rather than treat an unreadable switch as "no ports" and issue
    blind writes. We probe all three read paths up front (port table, VLAN
    table, and the LAN membership) precisely so a read-only 404 never escalates
    into a write/verify error later.
    """
    try:
        ports = await driver.get_ports()
        # Probe the VLAN read endpoints too — on v1.04 these 404 independently
        # of the port table; reconcile is unsafe if we can't read them.
        await driver.get_vlans()
        await driver.get_vlan_membership(LAN_VLAN)
    except SwitchError as exc:
        logger.warning(
            "provisioner: could not read VLAN state (%s) — skipping reconcile. "
            "No writes attempted.",
            exc,
        )
        return None

    pvids: dict[int, int] = {}
    for entry in ports:
        # Trunk/SFP uplink ports carry every VLAN; they have no single access
        # PVID to reconcile and must never be reassigned, so skip them here.
        if entry.get("is_sfp"):
            continue
        port = entry.get("port")
        if port is None:
            continue
        pvids[int(port)] = int(entry.get("vlan") or LAN_VLAN)
    return pvids


async def _verify_pvid(driver: SwitchDriver, port: int, expected_vlan: int) -> bool:
    """Read back the membership of ``expected_vlan`` and confirm ``port`` is an
    untagged member. Surfaces a silent-write failure (write recorded but didn't
    take) as a verification miss the caller reports as an error."""
    try:
        membership = await driver.get_vlan_membership(expected_vlan)
    except SwitchError as exc:
        logger.error("provisioner: read-back of VLAN %d failed: %s", expected_vlan, exc)
        return False
    for entry in membership.get("ports", []):
        if entry.get("port") == port and entry.get("member") and not entry.get("tagged"):
            return True
    return False


async def _move_port_to_vlan(driver: SwitchDriver, port: int, vlan_id: int) -> None:
    """Set ``port`` as an untagged member of ``vlan_id`` (its access VLAN)."""
    if vlan_id != LAN_VLAN:
        # Ensure the target VLAN exists before assigning membership. create_vlan
        # is tolerant of "already exists" at the driver layer.
        try:
            existing = {v.get("vlan_id") for v in await driver.get_vlans()}
        except SwitchError:
            existing = set()
        if vlan_id not in existing:
            await driver.create_vlan(vlan_id, _vlan_name(vlan_id))
    await driver.set_vlan_membership(
        vlan_id, [{"port": port, "tagged": False, "member": True}]
    )


def _vlan_name(vlan_id: int) -> str:
    if vlan_id == CAMERA_VLAN:
        return "cameras"
    if vlan_id == AP_VLAN:
        return "ap-downstream"
    return f"VLAN{vlan_id}"


def _desired_pvid(
    port: int, cfg: ProvisionConfig, segmented: bool
) -> int:
    """The VLAN this access port SHOULD sit on under the active profile."""
    if not segmented:
        # flat-lan: every access port belongs untagged on VLAN 1.
        return LAN_VLAN
    if port in cfg.camera_ports:
        return CAMERA_VLAN
    if port in cfg.ap_ports:
        return AP_VLAN
    # client ports (and anything unspecified) stay on the LAN.
    return LAN_VLAN


async def reconcile_switch(
    driver: Optional[SwitchDriver],
    cfg: ProvisionConfig,
    routing_client: Optional[RoutingCrossCheck] = None,
) -> dict:
    """Reconcile the switch to the desired VLAN state. Returns a ProvisionResult
    dict ``{status, profile_applied, ports_changed, skipped_reason}``.

    ``status`` is one of:
      * ``noop``     — already at desired state; nothing written.
      * ``applied``  — one or more ports were moved.
      * ``refused``  — segmented requested but the camera-VLAN routing cross
                       check failed; stayed flat-lan (misconfig surfaced).
      * ``skipped``  — switch absent or unreadable; no-op.
      * ``error``    — a write didn't verify on read-back.

    No exception escapes: callers (lifespan, POST /provision) treat any return
    as terminal and never block boot.
    """
    if driver is None:
        logger.info("provisioner: switch not connected — nothing to provision.")
        return _result(
            "skipped", cfg.profile, skipped_reason="switch not connected"
        )

    if cfg.profile not in VALID_PROFILES:
        logger.error(
            "provisioner: unknown SWITCH_VLAN_PROFILE=%r; refusing to provision.",
            cfg.profile,
        )
        return _result(
            "refused",
            cfg.profile,
            skipped_reason=f"unknown SWITCH_VLAN_PROFILE={cfg.profile!r}",
        )

    # ----- profile gate: segmented is DOUBLE-gated ------------------------
    segmented = cfg.profile == "segmented"
    refused_reason: Optional[str] = None
    if segmented:
        present: Optional[bool] = None
        if routing_client is not None:
            try:
                present = await routing_client.cameras_present()
            except Exception as exc:  # routing unreachable — fail safe
                logger.error(
                    "provisioner: routing cross-check failed (%s); refusing to "
                    "isolate the camera VLAN — staying flat-lan.",
                    exc,
                )
                present = None
        if present is not True:
            # Misconfig: SWITCH_VLAN_PROFILE=segmented but the camera VLAN
            # routing (ADR-018 item 3) is not present. Surface, don't honour.
            refused_reason = (
                "segmented requested but the camera VLAN routing is not present "
                "(cameras.present != true) — refusing to isolate; staying "
                "flat-lan until ADR-018 item 3 lands."
            )
            logger.error("provisioner: %s", refused_reason)
            segmented = False

    profile_applied = "segmented" if segmented else "flat-lan"

    # ----- read live state (tolerant of v1.04 endpoint 404s) --------------
    pvids = await _read_access_pvids(driver)
    if pvids is None:
        return _result(
            "skipped",
            profile_applied,
            skipped_reason="switch VLAN state unreadable (read returned 404/empty)",
        )

    # ----- compute the delta ----------------------------------------------
    to_change: list[tuple[int, int]] = []  # (port, desired_vlan)
    for port, current in sorted(pvids.items()):
        if port == cfg.protected_port:
            continue  # NEVER move the uplink/protected port
        desired = _desired_pvid(port, cfg, segmented)
        if current != desired:
            to_change.append((port, desired))

    if not to_change:
        logger.info("provisioner: switch already at desired state (%s).", profile_applied)
        status = "refused" if refused_reason else "noop"
        return _result(status, profile_applied, skipped_reason=refused_reason)

    # ----- apply: backup first, then per-port write + read-back verify ----
    try:
        await driver.backup_config()
    except SwitchError as exc:
        # A failed backup is not fatal to reading, but we refuse to write blind
        # without a restore point.
        logger.error("provisioner: config backup failed (%s); aborting writes.", exc)
        return _result(
            "error",
            profile_applied,
            skipped_reason=f"config backup failed before write: {exc}",
        )

    changed: list[int] = []
    for port, desired in to_change:
        try:
            await _move_port_to_vlan(driver, port, desired)
        except SwitchError as exc:
            logger.error("provisioner: write for port %d failed: %s", port, exc)
            return _result(
                "error",
                profile_applied,
                ports_changed=changed,
                skipped_reason=f"write failed for port {port}: {exc}",
            )
        if not await _verify_pvid(driver, port, desired):
            logger.error(
                "provisioner: read-back verification failed for port %d "
                "(expected untagged VLAN %d).",
                port,
                desired,
            )
            return _result(
                "error",
                profile_applied,
                ports_changed=changed,
                skipped_reason=(
                    f"read-back verification failed for port {port} "
                    f"(expected untagged VLAN {desired})"
                ),
            )
        changed.append(port)

    logger.info(
        "provisioner: reconcile complete (%s) — moved ports %s.",
        profile_applied,
        changed,
    )
    # If we got here under a segmented->flat-lan refusal we still applied the
    # flat-lan deltas, but the headline is the refusal so the operator sees it.
    if refused_reason:
        return _result("refused", profile_applied, ports_changed=changed, skipped_reason=refused_reason)
    return _result("applied", profile_applied, ports_changed=changed)
