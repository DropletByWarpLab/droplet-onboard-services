"""WARP-963 — fleet-agent entrypoint.

Boot order:
  1. Load config; evaluate the gate (flag + credentials).
  2. Gate closed → log the honest reason once and idle forever. The
     container stays up (no crash-loop, no restart churn) but dials
     NOTHING — a disabled agent has zero egress.
  3. Gate open → best-effort register (portal down at boot is fine; the
     heartbeat tick retries and spools), push one boot inventory per the
     contract's "every 6h, plus on boot", start the apscheduler jobs,
     and park on an Event that never fires (apscheduler owns all
     cadences — no while-True loops, architecture-guard rule 9).

Fail-open is absolute: any unexpected exception in a tick is logged and
swallowed inside the agent; this process only exits when Docker stops it.
"""

from __future__ import annotations

import asyncio
import logging
import os

from agent import FleetAgent
from collectors import HostCollector
from config import load_config
from portal import PortalClient
from state import StateStore

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
    agent = FleetAgent(
        config=config,
        state=state,
        portal=portal,
        collector=HostCollector(firmware_version=config.firmware_version),
    )

    active, reason = agent.gate()
    if not active:
        logger.info("fleet-agent idle: %s", reason)
        await asyncio.Event().wait()  # park forever; zero egress while off
        return

    logger.info(
        "fleet-agent starting: portal=%s heartbeat=%ds",
        config.portal_url,
        config.heartbeat_interval_s,
    )
    await agent.ensure_registered()  # best-effort; ticks retry + spool
    await agent.inventory_tick()  # contract: inventory on boot
    scheduler = agent.build_scheduler()
    scheduler.start()
    try:
        await asyncio.Event().wait()  # apscheduler owns every cadence
    finally:
        scheduler.shutdown(wait=False)
        await portal.aclose()


if __name__ == "__main__":
    asyncio.run(run())
