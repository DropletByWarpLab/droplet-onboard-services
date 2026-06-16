"""Issuance background-task flow (ADR-023 §issuance contract).

``run_order_flow`` is the async background task kicked off by POST /order
and POST /renew. It drives the row pending -> active | failed:

  * call the ACME issuer with the box CSR + fqdn;
  * parse the leaf metadata off the returned fullchain;
  * mark the row active with the cert + validity window;
  * on ANY failure, mark the row failed with last_error — the row is
    NEVER left stuck in pending.
"""

from __future__ import annotations

import logging
from typing import Any

from acme_issuance import certinfo

logger = logging.getLogger(__name__)


async def run_order_flow(
    *,
    repo: Any,
    issuer: Any,
    device_id: str,
    csr_pem: str,
    fqdn: str,
) -> None:
    """Run the ACME order for one device and persist the outcome.

    Swallows exceptions into a 'failed' row — this runs as a fire-and-
    forget background task, so an unhandled raise would be lost AND would
    leave the row stuck in 'pending'."""
    try:
        order = await issuer.order_certificate(csr_pem=csr_pem, fqdn=fqdn)
        info = certinfo.parse_leaf(order.fullchain_pem)
        await repo.mark_cert_active(
            device_id=device_id,
            fullchain_pem=order.fullchain_pem,
            cert_serial=info.serial,
            not_before=info.not_before,
            not_after=info.not_after,
        )
        logger.info("issuance: %s -> active (%s)", device_id, fqdn)
    except Exception as exc:  # noqa: BLE001 — must not leave row pending
        logger.error("issuance: %s -> failed: %s", device_id, exc)
        await repo.mark_cert_failed(
            device_id=device_id, last_error=f"ACME issuance failed: {exc}"
        )
