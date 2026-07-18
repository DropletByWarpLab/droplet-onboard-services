"""WARP-963 / WARP-1025 — fleet-agent entrypoint.

Boot order:
  1. Load config; evaluate BOTH gates independently — telemetry
     (flag + credentials, WARP-963) and update-poll (its own opt-in
     flag, WARP-1025/ADR-028). Different operator consents; either half
     can run without the other.
  2. Both gates closed → log the honest reasons once and idle forever.
     The container stays up (no crash-loop, no restart churn) but dials
     NOTHING — a disabled agent has zero egress.
  3. Telemetry gate open → best-effort register (portal down at boot is
     fine; the heartbeat tick retries and spools) and push one boot
     inventory per the contract's "every 6h, plus on boot".
  4. Start the apscheduler jobs (build_scheduler mounts only the
     gated-open halves) and park on an Event that never fires
     (apscheduler owns all cadences — no while-True loops,
     architecture-guard rule 9).

Fail-open is absolute: any unexpected exception in a tick is logged and
swallowed inside the agent; this process only exits when Docker stops it.
"""

from __future__ import annotations

import sys as _sys

# WARP-229: FIPS 140-3 boot self-test. Runs at module import, BEFORE
# any other heavy imports that could initialize OpenSSL on first use
# (this service's whole job is outbound TLS). Env-gated: enforces only
# when DROPLET_FIPS_REQUIRED=true. See services/_shared/fips_selftest.py.
_sys.path.insert(0, "/app")
try:
    from _shared.fips_selftest import gated_assert_fips_at_boot  # type: ignore

    gated_assert_fips_at_boot("fleet-agent")
except ImportError:
    # Helper not present (running outside the production Docker layout).
    # The env-gated default skips when DROPLET_FIPS_REQUIRED is unset,
    # so this mirrors the no-op path.
    pass

import asyncio
import logging
import os

from agent import FleetAgent
from collectors import HostCollector
from config import load_config
from errors import ErrorReporter
from portal import PortalClient
from state import StateStore
from update_poll import UpdatePoller

logger = logging.getLogger("fleet_agent.main")


def _configure_logging() -> None:
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )


async def run() -> None:
    _configure_logging()
    config = load_config(os.environ)
    state = StateStore(config.state_dir)
    portal = PortalClient(
        base_url=config.portal_url,
        firmware_version=config.firmware_version,
    )
    # One shared ErrorReporter: rejected-manifest audits from the update
    # poll ride the same errors tick as the agent's own faults.
    errors = ErrorReporter()
    updates = UpdatePoller(config=config, state=state, errors=errors)
    agent = FleetAgent(
        config=config,
        state=state,
        portal=portal,
        collector=HostCollector(firmware_version=config.firmware_version),
        errors=errors,
        updates=updates,
    )

    telemetry_active, telemetry_reason = agent.gate()
    update_active, update_reason = agent.update_gate()
    if not telemetry_active and not update_active:
        logger.info("fleet-agent idle: %s; %s", telemetry_reason, update_reason)
        await asyncio.Event().wait()  # park forever; zero egress while off
        return

    if telemetry_active:
        logger.info(
            "fleet-agent telemetry starting: portal=%s heartbeat=%ds",
            config.portal_url,
            config.heartbeat_interval_s,
        )
        await agent.ensure_registered()  # best-effort; ticks retry + spool
        await agent.inventory_tick()  # contract: inventory on boot
    else:
        logger.info("telemetry half idle: %s", telemetry_reason)

    if update_active:
        logger.info(
            "update-poll starting (WARP-1025): releases=%s every %ds",
            config.releases_url,
            config.update_poll_interval_s,
        )
    else:
        logger.info("update-poll half idle: %s", update_reason)

    scheduler = agent.build_scheduler()
    scheduler.start()
    try:
        await asyncio.Event().wait()  # apscheduler owns every cadence
    finally:
        scheduler.shutdown(wait=False)
        await portal.aclose()
        await updates.aclose()


if __name__ == "__main__":
    asyncio.run(run())
