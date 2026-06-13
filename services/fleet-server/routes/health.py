"""Liveness + readiness probes for the fleet HQ issuance service.

/healthz — process is up (no dependency checks).
/readyz  — the DB pool answers a trivial query (ready to issue).
"""

from __future__ import annotations

import logging

from fastapi import APIRouter
from fastapi.responses import JSONResponse

import db

logger = logging.getLogger(__name__)

router = APIRouter(tags=["health"])


@router.get("/healthz")
async def healthz():
    return {"status": "ok"}


@router.get("/readyz")
async def readyz():
    try:
        pool = db.get_pool()
        await pool.fetchval("SELECT 1")
    except Exception as exc:  # noqa: BLE001
        logger.warning("readyz: db not ready: %s", exc)
        return JSONResponse(status_code=503, content={"status": "not_ready", "db": False})
    return {"status": "ready", "db": True}
