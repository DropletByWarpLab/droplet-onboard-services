"""Auto-locate the Droplet via free IP-geolocation.

Voice replies need fresh time + place (so "what time is it?" works
without freelancing). Operator can pin both via env (`DROPLET_LOCATION`
+ `TZ`); when those are empty we ask a public geolocation service to
fill in based on the appliance's egress IP.

Service choice: **ipapi.co/json/** — no auth, HTTPS, 1000 req/day free
(we make ONE call per process lifetime, refreshed on container
restart). Returns city + region + country + timezone in one shot. We
fall back to UTC silently if the call fails — the model just gets a
slightly less informed system prompt rather than crashing on lookup.

This module is deliberately small + dependency-light: just `httpx`
(already in requirements for voice/llm.py) and the stdlib. No
caching layer — the LLM bridge calls `get_geo()` once at startup and
holds the result for the process lifetime.
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Optional
from urllib.parse import urlparse

import httpx

logger = logging.getLogger("voice.geo")

# ipapi.co is the default — free tier, no API key, HTTPS, 1000/day.
# Override via env if you want to swap services or use a paid tier.
DEFAULT_GEO_URL = "https://ipapi.co/json/"
DEFAULT_GEO_TIMEOUT_S = 5.0

# Sentinel returned when the lookup fails or is disabled. Callers
# should pass through gracefully — the system prompt just omits the
# location line and uses UTC for time formatting.
UNKNOWN_TIMEZONE = "UTC"


@dataclass(frozen=True)
class GeoLocation:
    """One IP-geolocation result, normalized across providers.

    `description` is the free-form string we splice into the LLM's
    system prompt — formatted as "City, Region, Country" so the model
    can answer "where am I?" with something natural-sounding.

    `timezone` is an IANA name (e.g. "America/Los_Angeles") suitable
    for `zoneinfo.ZoneInfo()`. Falls back to UTC when the lookup
    fails or returns nothing usable.
    """

    description: Optional[str]
    timezone: str
    source: str  # "env", "ipapi.co", "ip-api.com", "fallback"


def get_geo() -> GeoLocation:
    """Resolve the Droplet's location once, with this priority:

      1. `DROPLET_LOCATION` env (free-form text) + `TZ` env (IANA).
         Operator-pin wins.
      2. `GEO_URL` env (defaults to ipapi.co) — HTTPS GET, parse JSON.
      3. UTC + no description — silent fallback.

    Synchronous + no caching. The LLM bridge calls this exactly once
    at startup; subsequent calls re-issue the HTTP lookup. If the
    operator wants to refresh after a move, restart the voice container.
    """
    env_loc = (os.environ.get("DROPLET_LOCATION") or "").strip()
    env_tz = (os.environ.get("TZ") or "").strip()
    if env_loc and env_tz:
        logger.info(
            "geo: using env-pinned location=%r tz=%r (skipping web lookup)",
            env_loc, env_tz,
        )
        return GeoLocation(description=env_loc, timezone=env_tz, source="env")

    fetched = _fetch_via_ipapi()
    if fetched is None:
        logger.info("geo: lookup failed or returned nothing; falling back to UTC")
        return GeoLocation(
            description=env_loc or None,  # respect partial env if present
            timezone=env_tz or UNKNOWN_TIMEZONE,
            source="fallback",
        )

    # Apply env-overrides for either field if pinned.
    desc = env_loc or fetched.description
    tz = env_tz or fetched.timezone
    logger.info("geo: resolved location=%r tz=%r (source=%s)", desc, tz, fetched.source)
    return GeoLocation(description=desc, timezone=tz, source=fetched.source)


# Providers whose response shape we know how to normalise. `source` is
# reported by exact hostname so a status line names the real answerer.
_KNOWN_GEO_HOSTS = ("ipapi.co", "ip-api.com")


def _source_label(url: str) -> str:
    """Label the geo provider by its parsed hostname, not by substring.

    CodeQL py/incomplete-url-substring-sanitization: `"ip-api.com" in url`
    also matched a lookalike host that merely *starts* with the provider's
    name under someone else's domain, or a path that mentions it. The host
    must equal a known domain (or be a subdomain of it); anything else is
    reported as the raw URL.
    """
    host = (urlparse(url).hostname or "").lower()
    for known in _KNOWN_GEO_HOSTS:
        if host == known or host.endswith("." + known):
            return known
    return url


def _fetch_via_ipapi() -> Optional[GeoLocation]:
    """One HTTP GET to ipapi.co (or override). Returns None on any
    error — caller falls back to UTC.

    Response shape (per ipapi.co docs):
      { "city": "Los Angeles", "region": "California",
        "country_name": "United States", "timezone": "America/Los_Angeles",
        "latitude": 34.05, "longitude": -118.25, ... }

    Also handles ip-api.com's slightly different shape (city /
    regionName / country / timezone) so a swap via GEO_URL works
    without code change.
    """
    url = (os.environ.get("GEO_URL") or DEFAULT_GEO_URL).strip()
    timeout = float(os.environ.get("GEO_TIMEOUT_S") or DEFAULT_GEO_TIMEOUT_S)
    try:
        resp = httpx.get(url, timeout=timeout, headers={"Accept": "application/json"})
    except (httpx.HTTPError, OSError) as exc:
        logger.warning("geo: GET %s failed: %s", url, exc)
        return None
    if not resp.is_success:
        logger.warning("geo: GET %s returned %d", url, resp.status_code)
        return None
    try:
        data = resp.json()
    except ValueError as exc:
        logger.warning("geo: GET %s returned non-JSON: %s", url, exc)
        return None

    if not isinstance(data, dict):
        return None

    # Some services rate-limit by returning an error object instead
    # of geo data. ipapi.co uses {"error": True, "reason": "..."}.
    if data.get("error"):
        logger.warning("geo: %s returned error: %s", url, data.get("reason") or data)
        return None

    # Normalize: try ipapi.co keys first, then ip-api.com keys.
    city = data.get("city") or ""
    region = data.get("region") or data.get("regionName") or ""
    country = data.get("country_name") or data.get("country") or ""
    tz = (data.get("timezone") or "").strip()
    source = _source_label(url)

    parts = [p for p in (city, region, country) if p and p.strip()]
    description = ", ".join(parts) if parts else None
    if not tz:
        tz = UNKNOWN_TIMEZONE

    if description is None and tz == UNKNOWN_TIMEZONE:
        # Lookup succeeded but returned nothing useful. Treat as failure.
        return None

    return GeoLocation(description=description, timezone=tz, source=source)
