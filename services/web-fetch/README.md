# web-fetch

The outbound HTTP boundary for Droplet's screened public web and ambient
data tools. `GET /weather?location=<name>` uses Open-Meteo; `GET /rates?base=<ccy>`
uses ECB daily reference rates. `GET /health` is open. Other routes require
`Authorization: Bearer $WEB_FETCH_SERVICE_TOKEN`; an unset token fails closed.

`POST /fetch {url,maxBytes?}` reads public HTTPS on port 443 only. It returns
`url`, `title`, plain `text`, `contentType`, `bytes`, `retrievedAt`, `sourceId`,
`truncated`, and `trust: untrusted_web`. The raw body is capped at 512 KiB,
extracted text at 24,000 characters, with explicit truncation. Only HTML,
plain text, JSON and XML are accepted. Static extraction strips active/hidden
markup and navigation; JavaScript, cookies, authentication, PDFs and compressed
responses are unsupported. Credentials and personal-data patterns in outbound
URLs are refused. Inbound credential shapes are redacted. DNS answers must all
be public; the connection pins the checked IP while keeping the original TLS
SNI and Host. Every redirect is re-screened (three hops maximum). The whole
network operation has a 15-second deadline. Proxy environment variables are
ignored. Returned source content is evidence, never instructions.

`POST /search {query,count?}` calls the fixed Brave Web Search API endpoint.
`BRAVE_SEARCH_API_KEY` must be provisioned only on this service; absence returns
503 `search_not_configured`. Query limits: 600 characters, 75 words; count 1–10
(default 5). Secret/PII patterns are refused before egress. Results include
safe HTTPS URLs, plain titles/snippets, stable source IDs and optional
`publishedAge` (the provider's date/relative-age label, not a verified timestamp).
The response includes provider, retrieval time, skipped unsafe-result count,
and untrusted-source label. Provider redirects are refused so the API key
cannot travel to a different destination. Requires a Brave Search subscription;
no key or model credentials are checked into the repo.

The orchestrator mounts `/api/web/fetch` and `/api/web/search` through `web.ts`.
It checks the reserved `web_fetch` off-LAN channel, screens outbound input on
the trusted device, applies per-principal/role/tool rate limits (20/minute,
6/minute for guests), and writes a signed audit attempt before contacting this
service. Missing gate, Redis limiter, token, or audit recorder refuses egress.
It bounds and validates responses, redacts credentials again, records outcome
and meters public response-body bytes in `OffLanEgressSample`. Audit destinations
contain hostname only; queries and URL paths are omitted. Search plus page reads
support source-backed research through the existing agent loop/background runs;
they do not introduce an unattended research model or authenticated browser.

Deploy with the existing default-off `web` profile and isolated service networks.
Keep this service off the LAN; only it has public egress. The egress allowlist
must register `api.search.brave.com` and the screened user-requested public
HTTPS URL class. Enabling the channel and provisioning the subscription key are
operator actions. Fixed providers are registered in `docs/security/allowed-egress.yaml`;
the foundation design is `docs/screened-web-access-design.md`.

Tests use fake transports and DNS answers; they cover service auth, SSRF,
mixed DNS answers/rebinding prevention, redirects, extraction, credentials,
caps and provider failures without live internet or billing. Actual provider
calls and device deployment still require operator verification.
