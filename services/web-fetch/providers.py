"""Outbound providers for the web-fetch service (WARP-1436).

Fixed keyless destinations ONLY. The three hosts below are this service's
ENTIRE egress surface; each is registered in docs/security/allowed-egress.yaml
(entries `ambient-weather-open-meteo` and `ambient-rates-ecb`). Never add a
destination here without an allowlist entry + security review on the PR.
"""

from __future__ import annotations

# The ECB document comes from a fixed, trusted destination (see the
# allowed-egress entries above), so the stdlib parser is acceptable here.
# defusedxml is not part of this service's pinned dependency set.
import xml.etree.ElementTree as ET

import httpx

# docs/security/allowed-egress.yaml → id: ambient-weather-open-meteo
GEOCODING_HOST = "geocoding-api.open-meteo.com"
FORECAST_HOST = "api.open-meteo.com"
# docs/security/allowed-egress.yaml → id: ambient-rates-ecb
ECB_HOST = "www.ecb.europa.eu"

GEOCODING_URL = f"https://{GEOCODING_HOST}/v1/search"
FORECAST_URL = f"https://{FORECAST_HOST}/v1/forecast"
ECB_RATES_URL = f"https://{ECB_HOST}/stats/eurofxref/eurofxref-daily.xml"

HTTP_TIMEOUT_SECONDS = 10.0

# Standard WMO weather interpretation codes (WW) as documented by Open-Meteo.
WMO_WEATHER_CODES: dict[int, str] = {
    0: "Clear sky",
    1: "Mainly clear",
    2: "Partly cloudy",
    3: "Overcast",
    45: "Fog",
    48: "Depositing rime fog",
    51: "Light drizzle",
    53: "Moderate drizzle",
    55: "Dense drizzle",
    56: "Light freezing drizzle",
    57: "Dense freezing drizzle",
    61: "Slight rain",
    63: "Moderate rain",
    65: "Heavy rain",
    66: "Light freezing rain",
    67: "Heavy freezing rain",
    71: "Slight snow fall",
    73: "Moderate snow fall",
    75: "Heavy snow fall",
    77: "Snow grains",
    80: "Slight rain showers",
    81: "Moderate rain showers",
    82: "Violent rain showers",
    85: "Slight snow showers",
    86: "Heavy snow showers",
    95: "Thunderstorm",
    96: "Thunderstorm with slight hail",
    99: "Thunderstorm with heavy hail",
}


def wmo_description(code: int) -> str:
    """Human-readable string for a WMO weather code (defensive for unknowns)."""
    return WMO_WEATHER_CODES.get(code, f"Unknown (code {code})")


class ProviderError(Exception):
    """Any upstream failure (network, timeout, non-2xx, unparseable body)."""


def create_client() -> httpx.AsyncClient:
    """Factory for ALL outbound calls — tests monkeypatch this to inject an
    httpx.MockTransport; production always gets the 10 s timeout budget."""
    return httpx.AsyncClient(timeout=HTTP_TIMEOUT_SECONDS)


async def _get_json(url: str, params: dict) -> dict:
    try:
        async with create_client() as client:
            resp = await client.get(url, params=params)
            resp.raise_for_status()
            return resp.json()
    # ValueError covers json.JSONDecodeError on an unparseable body.
    except (httpx.HTTPError, ValueError) as exc:
        raise ProviderError(f"GET {url} failed: {exc!r}") from exc


async def geocode(location: str) -> dict | None:
    """Resolve a place name via Open-Meteo geocoding.

    Returns the top match as {name, latitude, longitude, country}, or None
    when the provider has no result. Raises ProviderError on upstream failure.
    """
    data = await _get_json(GEOCODING_URL, {"name": location, "count": 1})
    results = data.get("results") or []
    if not results:
        return None
    top = results[0]
    return {
        "name": top.get("name"),
        "latitude": top.get("latitude"),
        "longitude": top.get("longitude"),
        "country": top.get("country"),
    }


async def forecast(latitude: float, longitude: float) -> tuple[dict, list[dict]]:
    """Current conditions + 7-day daily forecast via Open-Meteo.

    Returns (current, daily) pre-shaped for the /weather response minus the
    `description` fields (main.py adds those from the WMO table).
    """
    params = {
        "latitude": latitude,
        "longitude": longitude,
        "current": (
            "temperature_2m,apparent_temperature,relative_humidity_2m,"
            "wind_speed_10m,weather_code"
        ),
        "daily": "temperature_2m_min,temperature_2m_max,weather_code",
        "forecast_days": 7,
        "timezone": "UTC",
    }
    data = await _get_json(FORECAST_URL, params)
    try:
        cur = data["current"]
        current = {
            "temperatureC": cur["temperature_2m"],
            "apparentC": cur["apparent_temperature"],
            "humidityPct": cur["relative_humidity_2m"],
            "windKmh": cur["wind_speed_10m"],
            "code": cur["weather_code"],
        }
        day = data["daily"]
        daily = [
            {"date": date, "minC": min_c, "maxC": max_c, "code": code}
            for date, min_c, max_c, code in zip(
                day["time"],
                day["temperature_2m_min"],
                day["temperature_2m_max"],
                day["weather_code"],
            )
        ]
    except (KeyError, TypeError) as exc:
        raise ProviderError(f"forecast response missing fields: {exc!r}") from exc
    return current, daily


async def ecb_rates() -> tuple[str, dict[str, float]]:
    """Fetch + parse the ECB daily reference rates (EUR-based).

    Returns (as_of_date, {currency: rate}). Raises ProviderError on any
    upstream or parse failure.
    """
    try:
        async with create_client() as client:
            resp = await client.get(ECB_RATES_URL)
            resp.raise_for_status()
            text = resp.text
    except httpx.HTTPError as exc:
        raise ProviderError(f"ECB fetch failed: {exc!r}") from exc

    try:
        root = ET.fromstring(text)
    except ET.ParseError as exc:
        raise ProviderError(f"ECB XML parse failed: {exc!r}") from exc

    as_of: str | None = None
    rates: dict[str, float] = {}
    # Namespace-agnostic walk: the time Cube carries a `time` attribute, each
    # rate Cube carries `currency` + `rate`.
    for el in root.iter():
        if not str(el.tag).endswith("Cube"):
            continue
        if as_of is None and "time" in el.attrib:
            as_of = el.attrib["time"]
        if "currency" in el.attrib and "rate" in el.attrib:
            try:
                rates[el.attrib["currency"].upper()] = float(el.attrib["rate"])
            except ValueError as exc:
                raise ProviderError(f"ECB rate not numeric: {exc!r}") from exc
    if not as_of or not rates:
        raise ProviderError("ECB XML missing time attribute or rate cubes")
    return as_of, rates
