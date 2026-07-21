"""
Droplet Web-Fetch Service
=========================
The ONLY component allowed outbound HTTP for the ambient-data LLM tools
(WARP-1436): weather via Open-Meteo and currency reference rates via the
ECB daily XML. Keyless fixed providers only — every destination is a
hardcoded constant in providers.py, registered in
docs/security/allowed-egress.yaml. Design: docs/screened-web-access-design.md.

Purely request-driven: no schedulers, no caches. Caching and audit logging
are the orchestrator's job.
"""

import sys as _sys

# WARP-229 sibling idiom: env-gated FIPS 140-3 boot self-test. web-fetch is
# NOT one of the six provider-carrying images — compose pins
# DROPLET_FIPS_REQUIRED=false for it, so this is a documented no-op kept for
# shape parity with routing/camera-discovery.
_sys.path.insert(0, "/app")
try:
    from _shared.fips_selftest import gated_assert_fips_at_boot  # type: ignore

    gated_assert_fips_at_boot("web-fetch")
except ImportError:
    # Helper not present (running outside the production Docker layout).
    pass

import hmac
import os
from datetime import datetime, timezone

from fastapi import Depends, FastAPI, HTTPException, Query, Request

import providers

# Bearer token shared with the orchestrator (docker-compose:
# WEB_FETCH_SERVICE_TOKEN). Read at import; require_bearer looks the module
# global up at call time so tests can monkeypatch it (routing precedent).
WEB_FETCH_SERVICE_TOKEN = os.getenv("WEB_FETCH_SERVICE_TOKEN", "").strip()

AUTH_EXEMPT_PATHS = frozenset({"/health"})


def require_bearer(request: Request) -> None:
    """Reject requests without a matching `Authorization: Bearer <token>`.

    Fails CLOSED when no token is configured: an unset WEB_FETCH_SERVICE_TOKEN
    (e.g. a failed secret injection at deploy) yields 503 on every non-/health
    route rather than silently opening the one component with outbound HTTP.
    Same posture as routing's require_bearer, deliberately WITHOUT an
    *_ALLOW_NO_AUTH dev escape — this service must never run open.
    """
    # /health stays reachable without a token (Docker healthcheck).
    if request.url.path in AUTH_EXEMPT_PATHS:
        return
    if not WEB_FETCH_SERVICE_TOKEN:
        raise HTTPException(
            status_code=503,
            detail="web-fetch auth is not configured (WEB_FETCH_SERVICE_TOKEN unset)",
        )
    header = request.headers.get("authorization", "")
    scheme, _, token = header.partition(" ")
    if scheme.lower() != "bearer" or not hmac.compare_digest(
        token.strip(), WEB_FETCH_SERVICE_TOKEN
    ):
        raise HTTPException(status_code=401, detail="Unauthorized")


app = FastAPI(
    title="Droplet Web-Fetch Service",
    version="1.0.0",
    dependencies=[Depends(require_bearer)],
)


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/weather")
async def weather(location: str = Query(..., min_length=1, max_length=120)):
    try:
        place = await providers.geocode(location)
    except providers.ProviderError:
        raise HTTPException(status_code=502, detail="weather_unavailable")
    if place is None:
        raise HTTPException(status_code=404, detail="location_not_found")
    try:
        current, daily = await providers.forecast(
            place["latitude"], place["longitude"]
        )
    except providers.ProviderError:
        raise HTTPException(status_code=502, detail="weather_unavailable")

    current["description"] = providers.wmo_description(current["code"])
    for day in daily:
        day["description"] = providers.wmo_description(day["code"])
    return {
        "location": place,
        "current": current,
        "daily": daily,
        "asOf": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }


@app.get("/rates")
async def rates(base: str = Query("EUR", min_length=3, max_length=3)):
    try:
        as_of, ecb = await providers.ecb_rates()
    except providers.ProviderError:
        raise HTTPException(status_code=502, detail="rates_unavailable")

    base_upper = base.upper()
    if base_upper == "EUR":
        # ECB rates are already EUR-based; the base key (EUR) is simply absent.
        out = dict(ecb)
    elif base_upper in ecb:
        # Re-base: rate[Y] = ecb[Y] / ecb[X]; EUR itself becomes 1 / ecb[X].
        base_rate = ecb[base_upper]
        out = {cur: rate / base_rate for cur, rate in ecb.items() if cur != base_upper}
        out["EUR"] = 1.0 / base_rate
    else:
        raise HTTPException(status_code=400, detail="unknown_currency")
    return {"base": base_upper, "asOf": as_of, "rates": out}
