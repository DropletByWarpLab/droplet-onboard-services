"""WARP-963 — the fail-open fleet agent (portal-push half).

ONE on-device agent for fleet telemetry, per the WARP-963 v1 slice:
heartbeat + metrics + errors + inventory + network snapshots pushed to
the droplet-analytics portal, and the portal's command queue answered
with an explicit "unsupported" for every command type. Flag-gated OFF
by default (see config.py) and FAIL-OPEN everywhere: no exception in
this module may ever degrade the box.

Scheduling: apscheduler interval jobs only (architecture-guard rule 9);
the long-poll's own wait happens inside one bounded HTTP request, not a
loop.

# ----------------------------------------------------------------------
# Update poll — INTENTIONALLY NOT IMPLEMENTED in v1 (WARP-963 scope cut).
#
# FLEET_MANAGEMENT_DESIGN.md gives the agent a third duty: poll for a
# signed release manifest and self-update the compose stack. That half
# is NOT built here yet: WARP-538 tracks the orchestrator-side update
# poller — the box already has an owner for "what version should I be
# on". WARP-961 resolved the unification decision (2026-07-03,
# docs/ADR-028-fleet-telemetry-and-design-answers.md, Accepted): the
# poller mounts HERE as one more apscheduler job (signed-manifest poll,
# WARP-537 verification), NOT as a separate service — tracked by
# WARP-1025.
# ----------------------------------------------------------------------
"""

from __future__ import annotations

import asyncio
import functools
import logging
from typing import Optional

from apscheduler.schedulers.asyncio import AsyncIOScheduler

from collectors import utc_now_iso
from config import AgentConfig
from errors import ErrorReporter
from portal import PortalClient
from spool import DiskSpool
from state import StateStore

logger = logging.getLogger("fleet_agent")

UNSUPPORTED_STDERR_TEMPLATE = (
    "command type '{type}' is unsupported in fleet-agent v1 (WARP-963); "
    "no action taken"
)


def _fail_open(fn):
    """No tick may ever raise: log, optionally queue an error report,
    and move on. The agent exists to observe the box, never to hurt it."""

    @functools.wraps(fn)
    async def wrapper(self: "FleetAgent", *args, **kwargs):
        try:
            return await fn(self, *args, **kwargs)
        except Exception as exc:  # noqa: BLE001 — fail-open by design
            logger.exception("%s failed (fail-open): %s", fn.__name__, exc)
            try:
                self.errors.report(
                    severity="error",
                    service="fleet-agent",
                    title=f"{fn.__name__} failed",
                    message=f"{type(exc).__name__}: {exc}",
                )
            except Exception:  # noqa: BLE001 — reporting must never cascade
                logger.exception("error reporting itself failed")
            return None

    return wrapper


class FleetAgent:
    def __init__(
        self,
        config: AgentConfig,
        state: StateStore,
        portal: PortalClient,
        collector,
        errors: Optional[ErrorReporter] = None,
    ) -> None:
        self.config = config
        self.state = state
        self.portal = portal
        self.collector = collector
        self.errors = errors or ErrorReporter()
        self.spool = DiskSpool(state.spool_path, config.spool_max)
        self._register_permanently_failed = False
        # Serializes registration: while it is pending, the 5s/15s/30s
        # ticks align every 30s and can await ensure_registered()
        # concurrently — without this lock each would POST the SAME
        # single-use provisioning code (the portal's consumption check
        # is racy under concurrency → duplicate/orphan Machine rows, and
        # the loser logs a false "code consumed" error).
        self._register_lock = asyncio.Lock()

        identity = state.identity()
        if identity:
            portal.adopt_identity(identity.machine_id, identity.ingest_token)
            self._intervals = dict(identity.intervals)
        else:
            self._intervals = {}

    # ------------------------------------------------------------------
    # Gate — OFF unless the flag AND credentials are both present
    # ------------------------------------------------------------------

    def gate(self) -> tuple[bool, str]:
        if not self.config.flag_enabled:
            return (
                False,
                "telemetry disabled: DROPLET_TELEMETRY_ENABLED is not 1 "
                "(explicit operator opt-in required)",
            )
        if not (self.state.identity() or self.config.provisioning_code):
            return (
                False,
                "telemetry enabled but no credentials present: neither a "
                "persisted identity nor DROPLET_TELEMETRY_PROVISIONING_CODE",
            )
        return True, ""

    # ------------------------------------------------------------------
    # Registration — one-time; the provisioning code is single-use
    # ------------------------------------------------------------------

    async def ensure_registered(self) -> bool:
        try:
            if self.portal.has_identity:
                return True
            if self._register_permanently_failed:
                return False
            if not self.config.provisioning_code:
                return False

            # Only ONE in-flight register, ever: the losing awaiters block
            # here and re-check identity below, adopting the winner's
            # result instead of re-POSTing the single-use code.
            async with self._register_lock:
                if self.portal.has_identity:
                    return True
                if self._register_permanently_failed:
                    return False

                payload = {
                    "hostname": self.config.hostname,
                    "tier": self.config.tier,
                    "firmware_version": self.config.firmware_version,
                }
                if self.config.hardware_revision:
                    payload["hardware_revision"] = self.config.hardware_revision

                result = await self.portal.register(
                    self.config.provisioning_code, payload
                )
                if result.ok and result.body:
                    machine_id = str(result.body["machine_id"])
                    token = str(result.body["ingest_token"])
                    intervals = dict(result.body.get("config", {}))
                    self.state.save_identity(
                        machine_id=machine_id,
                        ingest_token=token,
                        ingest_endpoint=str(result.body.get("ingest_endpoint", "")),
                        intervals=intervals,
                    )
                    self.portal.adopt_identity(machine_id, token)
                    self._intervals = intervals
                    logger.info("registered with portal as machine_id=%s", machine_id)
                    return True

                if result.status in (401, 403, 409):
                    # Consumed/invalid provisioning code — hammering the
                    # portal will not fix it. Log loudly ONCE, keep the box
                    # unbothered.
                    self._register_permanently_failed = True
                    logger.error(
                        "registration rejected (HTTP %s) — provisioning code is "
                        "invalid or already consumed; operator must mint a new "
                        "one in the portal's /settings/tokens",
                        result.status,
                    )
                    return False

                logger.warning(
                    "registration attempt failed transiently (status=%s transport_error=%s) — will retry",
                    result.status,
                    result.transport_error,
                )
                return False
        except Exception:  # noqa: BLE001 — fail-open
            logger.exception("ensure_registered failed (fail-open)")
            return False

    # ------------------------------------------------------------------
    # Ticks (each mounted as an apscheduler interval job)
    # ------------------------------------------------------------------

    @_fail_open
    async def heartbeat_tick(self) -> None:
        ts = utc_now_iso()
        payload = self.collector.heartbeat_payload(ts)
        if self.config.geo_country:
            payload["geoCountry"] = self.config.geo_country
        if self.config.geo_region:
            payload["geoRegion"] = self.config.geo_region

        if not await self.ensure_registered():
            # Registration pending (portal down / no code yet): keep the
            # history — the spool replays once we can authenticate.
            self.spool.append(payload)
            return

        # Replay any spooled beats oldest-first BEFORE the live one; the
        # portal is idempotent on (machine_id, ts) so replays are safe.
        # Return the full PortalResult so drain() can tell a retryable
        # failure (keep + retry) from a non-retryable 4xx poison pill
        # (drop), using the same should_spool classification as below.
        async def _send(entry: dict):
            return await self.portal.heartbeat(entry)

        if not await self.spool.drain(_send):
            # Still can't reach the portal — keep ordering, spool the live
            # beat behind the backlog.
            self.spool.append(payload)
            return

        result = await self.portal.heartbeat(payload)
        if result.ok:
            return
        if result.should_spool:
            self.spool.append(payload)
        else:
            # 4xx validation/auth rejects are poison pills — replaying them
            # forever would wedge the spool. Log + drop.
            logger.warning(
                "heartbeat rejected (HTTP %s) — dropping beat, not spooling",
                result.status,
            )

    @_fail_open
    async def metrics_tick(self) -> None:
        if not await self.ensure_registered():
            return
        samples = self.collector.metrics_samples(utc_now_iso())
        if not samples:
            return
        await self.portal.metrics({"samples": samples})

    @_fail_open
    async def errors_tick(self) -> None:
        if not await self.ensure_registered():
            return
        while True:
            item = self.errors.peek()
            if item is None:
                return
            result = await self.portal.errors(item)
            if not result.ok:
                # Portal failure NEVER re-enqueues as a new error (that
                # would self-amplify) — the item just waits for next tick.
                return
            self.errors.pop()

    @_fail_open
    async def inventory_tick(self) -> None:
        if not await self.ensure_registered():
            return
        await self.portal.inventory(self.collector.inventory_payload(utc_now_iso()))

    @_fail_open
    async def network_tick(self) -> None:
        if not await self.ensure_registered():
            return
        await self.portal.network(self.collector.network_payload(utc_now_iso()))

    @_fail_open
    async def commands_tick(self) -> None:
        """v1 command policy: EVERY command type is answered with an
        explicit 'unsupported' error result. No ssh.tunnel.*, no
        container.restart, no action of any kind is taken on the box —
        remote actuation needs its own security review (WARP-961)."""
        if not await self.ensure_registered():
            return
        commands = await self.portal.poll_commands(wait=25)
        for command in commands:
            command_id = str(command.get("id", ""))
            command_type = str(command.get("type", "unknown"))
            started = utc_now_iso()
            logger.warning(
                "portal command %s (type=%s) received — unsupported in v1, "
                "reporting back without acting",
                command_id,
                command_type,
            )
            if not command_id:
                continue
            await self.portal.post_command_result(
                command_id,
                {
                    "status": "error",
                    "started_at": started,
                    "finished_at": utc_now_iso(),
                    "stdout": "",
                    "stderr": UNSUPPORTED_STDERR_TEMPLATE.format(type=command_type),
                    "data": {"unsupported": True, "type": command_type},
                },
            )

    # ------------------------------------------------------------------
    # Scheduler wiring
    # ------------------------------------------------------------------

    def _interval(self, key: str, fallback: int) -> int:
        value = self._intervals.get(key)
        if isinstance(value, int) and value > 0:
            return value
        return fallback

    def build_scheduler(self) -> AsyncIOScheduler:
        scheduler = AsyncIOScheduler()
        jobs = (
            (
                "warp-963-heartbeat",
                self.heartbeat_tick,
                self._interval("heartbeat_interval_s", self.config.heartbeat_interval_s),
            ),
            (
                "warp-963-metrics",
                self.metrics_tick,
                self._interval("metrics_interval_s", self.config.metrics_interval_s),
            ),
            (
                "warp-963-errors",
                self.errors_tick,
                self.config.errors_flush_interval_s,
            ),
            (
                "warp-963-inventory",
                self.inventory_tick,
                self.config.inventory_interval_s,
            ),
            (
                "warp-963-network",
                self.network_tick,
                self._interval(
                    "network_snapshot_interval_s",
                    self.config.network_snapshot_interval_s,
                ),
            ),
            (
                "warp-963-commands",
                self.commands_tick,
                self._interval(
                    "command_poll_interval_s", self.config.command_poll_interval_s
                ),
            ),
        )
        for job_id, fn, seconds in jobs:
            scheduler.add_job(
                fn,
                "interval",
                seconds=seconds,
                id=job_id,
                max_instances=1,
                coalesce=True,
            )
        return scheduler
