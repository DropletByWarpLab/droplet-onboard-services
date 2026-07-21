"""GET /weather — Open-Meteo geocode + forecast, all upstream calls mocked."""

from __future__ import annotations

from datetime import datetime

import httpx
import pytest

import providers
from tests.conftest import AUTH

GEOCODE_JSON = {
    "results": [
        {
            "id": 2972315,
            "name": "Toulouse",
            "latitude": 43.60426,
            "longitude": 1.44367,
            "country": "France",
            "country_code": "FR",
        }
    ]
}

FORECAST_JSON = {
    "current": {
        "time": "2026-07-20T10:00",
        "temperature_2m": 24.6,
        "apparent_temperature": 25.1,
        "relative_humidity_2m": 48,
        "wind_speed_10m": 11.2,
        "weather_code": 2,
    },
    "daily": {
        "time": [
            "2026-07-20",
            "2026-07-21",
            "2026-07-22",
            "2026-07-23",
            "2026-07-24",
            "2026-07-25",
            "2026-07-26",
        ],
        "temperature_2m_min": [16.1, 15.4, 14.9, 15.8, 17.0, 16.3, 15.2],
        "temperature_2m_max": [28.4, 27.9, 25.2, 26.6, 29.1, 30.0, 27.3],
        "weather_code": [0, 1, 2, 3, 61, 95, 45],
    },
}


def _happy_handler(request: httpx.Request) -> httpx.Response:
    if request.url.host == providers.GEOCODING_HOST:
        assert request.url.params["name"] == "Toulouse"
        assert request.url.params["count"] == "1"
        return httpx.Response(200, json=GEOCODE_JSON)
    if request.url.host == providers.FORECAST_HOST:
        # The forecast request must ask for every field the contract maps.
        assert "apparent_temperature" in request.url.params["current"]
        assert "temperature_2m_min" in request.url.params["daily"]
        assert request.url.params["forecast_days"] == "7"
        return httpx.Response(200, json=FORECAST_JSON)
    raise AssertionError(f"unexpected outbound host: {request.url.host}")


def test_weather_happy_path_shape(client, mock_transport):
    mock_transport(_happy_handler)
    resp = client.get("/weather?location=Toulouse", headers=AUTH)
    assert resp.status_code == 200
    body = resp.json()

    assert set(body) == {"location", "current", "daily", "asOf"}
    assert body["location"] == {
        "name": "Toulouse",
        "latitude": 43.60426,
        "longitude": 1.44367,
        "country": "France",
    }
    assert body["current"] == {
        "temperatureC": 24.6,
        "apparentC": 25.1,
        "humidityPct": 48,
        "windKmh": 11.2,
        "code": 2,
        "description": "Partly cloudy",  # WMO code 2
    }
    assert len(body["daily"]) == 7
    assert body["daily"][0] == {
        "date": "2026-07-20",
        "minC": 16.1,
        "maxC": 28.4,
        "code": 0,
        "description": "Clear sky",
    }
    # WMO mapping across the whole daily window.
    assert [d["description"] for d in body["daily"]] == [
        "Clear sky",
        "Mainly clear",
        "Partly cloudy",
        "Overcast",
        "Slight rain",
        "Thunderstorm",
        "Fog",
    ]
    # asOf is ISO-8601 UTC.
    as_of = datetime.fromisoformat(body["asOf"])
    assert as_of.utcoffset().total_seconds() == 0


def test_geocode_miss_returns_404(client, mock_transport):
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.host == providers.GEOCODING_HOST
        return httpx.Response(200, json={"generationtime_ms": 0.5})

    mock_transport(handler)
    resp = client.get("/weather?location=Nowhereville-xyz", headers=AUTH)
    assert resp.status_code == 404
    assert resp.json() == {"detail": "location_not_found"}


def test_geocode_provider_500_returns_502(client, mock_transport):
    mock_transport(lambda request: httpx.Response(500, text="boom"))
    resp = client.get("/weather?location=Toulouse", headers=AUTH)
    assert resp.status_code == 502
    assert resp.json() == {"detail": "weather_unavailable"}


def test_forecast_provider_500_returns_502(client, mock_transport):
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == providers.GEOCODING_HOST:
            return httpx.Response(200, json=GEOCODE_JSON)
        return httpx.Response(500, text="boom")

    mock_transport(handler)
    resp = client.get("/weather?location=Toulouse", headers=AUTH)
    assert resp.status_code == 502
    assert resp.json() == {"detail": "weather_unavailable"}


def test_provider_timeout_returns_502(client, mock_transport):
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("simulated timeout")

    mock_transport(handler)
    resp = client.get("/weather?location=Toulouse", headers=AUTH)
    assert resp.status_code == 502
    assert resp.json() == {"detail": "weather_unavailable"}


@pytest.mark.parametrize(
    "query",
    [
        "",  # missing param entirely
        "?location=",  # empty (min_length=1)
        f"?location={'x' * 121}",  # over max_length=120
    ],
)
def test_location_length_validation(client, query):
    resp = client.get(f"/weather{query}", headers=AUTH)
    assert resp.status_code == 422
