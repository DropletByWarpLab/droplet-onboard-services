# web-fetch

The ONLY component allowed outbound HTTP for the ambient-data LLM tools
(WARP-1436): `GET /weather?location=<name>` (Open-Meteo geocoding + 7-day
forecast) and `GET /rates?base=<ccy>` (ECB daily reference rates, re-based),
plus an open `GET /health`. Everything else requires
`Authorization: Bearer $WEB_FETCH_SERVICE_TOKEN` and fails CLOSED when the
token is unset. Destinations are fixed keyless constants in `providers.py`,
registered in `docs/security/allowed-egress.yaml`; design rationale in
`docs/screened-web-access-design.md`.
