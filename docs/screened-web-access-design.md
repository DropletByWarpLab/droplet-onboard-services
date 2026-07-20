# Screened web access for LLM tools — design (WARP-1427)

**Status:** Draft for review
**Tickets:** WARP-1427 (this design); parent analysis WARP-1423
**Tools covered:** `web_fetch`, `web_search`, `get_weather`, `currency_convert` rate refresh

## 1. Context and goals

The four highest-value missing LLM tools from the MCP tool gap analysis
(WARP-1423) all require internet egress. Per the Foundation this is
on-thesis, not an exception: the local AI is never exposed to the
network; everything crossing the WAN boundary is screened both ways,
default-deny, audited. This design routes the new tools through that
mechanism — extending three enforcement layers that already exist
rather than inventing new ones.

Non-goals: general browsing/JS rendering; authenticated fetches; any
egress from the tool handlers themselves.

## 2. As-built anchors (what this design extends)

| Layer | Existing machinery | How this design uses it |
|---|---|---|
| Destination allowlist | `docs/security/allowed-egress.yaml`, default-deny, CI-enforced by `scripts/check-egress-allowlist.py` (WARP-269) | New entries per provider + a `user-requested-url` class for `web_fetch` |
| Runtime gate | Fail-closed off-LAN gate (WARP-468): ai-gateway middleware + orchestrator `off-lan-gate.service.ts`; `OffLanChannelKey` enum **already reserves `web_fetch`** | Every request checks a per-channel gate; closed ⇒ clean tool error |
| Byte metering | `OffLanEgressSample` | Per-channel byte accounting for the new channels |
| Audit | HMAC-chained `ActivityRow` via `recordActivity`; `POST /api/security/egress-anomaly` precedent (`kind:"network"`, structured `refs`, no new table) | Per-request audit rows — closing the WARP-268-class "unaudited egress" gap for this channel family |
| Egress enforcement pattern | Declarative desired state → reconciler → OpenWrt fw4/UCI via routing/ubus (`set_phone_home_blocking`, WARP-613) | Settings/allowlist writes are separate from enforcement; handlers never dispatch egress config |
| Edge placement | `cloudflared` / `fleet-agent` / `egress-audit` — profile-gated, outbound-only services at the WAN edge | The fetcher service follows the same shape |

Note: the nginx `gateway` image is ingress-only (TLS terminator + path
router, ADR-009) and plays no role here.

## 3. Architecture

```
tools-core handler ──▶ orchestrator (/api/web/*) ──▶ web-fetch service ──▶ internet
     (no egress)          gate + policy + audit         the ONLY component
                                                        with outbound HTTP
```

### 3.1 New service: `services/web-fetch/`

FastAPI, profile-gated (`web` profile, default **off**), the only
component that opens outbound connections for these tools. On the
shipping single-box it runs as an isolated container attached to (a) an
orchestrator-facing internal network and (b) egress — with **no LAN
network membership**. On the dual-subsystem hardware it migrates to the
untrusted WAN/Edge computer unchanged (same HTTP surface), honoring the
two-subsystem split.

Endpoints (orchestrator-only caller, service-token auth):
- `POST /fetch` `{url, maxBytes}` → readability-extracted text + metadata
- `POST /search` `{query, count}` → provider-normalized results
- `GET /weather` `{location}` → current + forecast (provider-normalized)
- `GET /rates` `{base}` → daily reference rates

### 3.2 Orchestrator: gate, policy, audit (`/api/web/*`)

The orchestrator fronts the service (tools never reach it directly):

1. **Channel gate** — fail-closed off-LAN gate per channel:
   `web_fetch` (fetch + search; already reserved in `OffLanChannelKey`)
   and a new `ambient_data` channel (weather + rates: fixed keyless
   destinations, low sensitivity, cacheable). Explicit enum values, per
   the no-guessing rule. Both default **off**; enabled from the
   dashboard's off-LAN settings surface.
2. **Egress screening (outbound):**
   - `https:` + port 443 only; no credentials/userinfo in URLs.
   - SSRF guard: resolve the host and reject private/LAN/link-local/
     metadata ranges (RFC1918, 169.254/16, ::1, fd00::/8) — re-checked
     on every redirect hop (max 3).
   - Secret/PII pattern screen on outbound URLs and search queries
     (key-shaped strings, e-mail addresses) → reject with a named error.
   - Per-role + per-tool rate limits via the existing Redis counter
     idiom (`auth.ts` progressive backoff pattern).
3. **Ingress screening (inbound):** fetched content is untrusted model
   input — readability extraction (no scripts/markup), content-type
   allowlist (`text/html`, `text/plain`, `application/json`,
   `application/xml`), size cap (default 512 KB raw / 24 KB extracted),
   and the extracted text is delimited and labeled as untrusted
   third-party content before it enters a prompt.
4. **Audit:** every request (allowed or refused) →
   `recordActivity` `ActivityRow` `kind:"network"`, `sub:"web_egress"`,
   `refs: {tool, channel, dst, bytes, status, refusalReason?, userId}`.
   Bytes also flow into `OffLanEgressSample`. No new table — same
   pattern as the egress-anomaly route.

### 3.3 Destination policy

- `get_weather`, `/rates`: fixed keyless providers registered in
  `allowed-egress.yaml` (see §5) — ordinary default-deny entries.
- `web_search`: single registered provider destination.
- `web_fetch`: inherently open-destination — registered as a
  `user-requested-url` data class whose entry documents that the
  destination is user-supplied and the screening in §3.2 is the control,
  mirroring how `cloud-llm-providers-optin` documents its gating
  middleware.

### 3.4 Tool surface (tools-core, all Tier-1 read)

`web_fetch {url}`, `web_search {query, count?}`,
`get_weather {location?}` (default: workspace home location setting),
`currency_convert {value, from, to}` (pure math over the cached daily
rates — works offline with a `ratesAsOf` staleness stamp). Handlers call
`ctx.http.orchestrator` only; gate-closed or offline states surface as
structured errors (`EGRESS_DISABLED` with a dashboard pointer,
`RATES_STALE` warning field, etc.).

## 4. Offline and failure behavior

- Weather and rates cached (Redis + `WorkspaceSetting` fallback) with
  explicit staleness stamps; served stale with a flag rather than
  failing hard.
- Gate closed / boundary down / provider error → structured tool errors,
  never silent empty results; every refusal audited with the reason.

## 5. Provider decision points (for review)

| Need | Recommended | Alternative | Trade-off |
|---|---|---|---|
| Weather | Open-Meteo (keyless, no account) | NWS (US-only) | Open-Meteo = zero-credential, minimal data class |
| Rates | ECB daily reference (keyless) | exchangerate.host | ECB is authoritative, 1 fetch/day, EUR-based math |
| Search | Brave Search API (key, cheap tier) | Self-hosted SearXNG on the edge (no key, more RAM; fits ≥32 GB SKUs) | API = 1 vendor sees queries; SearXNG = privacy-max but operational surface |

Recommendation: phase 1 ships weather + rates (fixed keyless
destinations, lowest risk); phase 2 `web_fetch` (SSRF + sanitization
hardening); phase 3 `web_search` after the provider decision.

## 6. Implementation tickets (to be filed on approval)

1. `ambient_data` channel + `services/web-fetch` skeleton + weather/rates
   tools (+ allowlist entries, audit rows, caching).
2. `web_fetch` tool + SSRF/sanitization screens + `user-requested-url`
   allowlist class.
3. `web_search` tool + provider integration per the §5 decision.
4. Dashboard: off-LAN settings rows for the two new channels; activity
   feed rendering for `sub:"web_egress"`.

## 7. Open questions

1. Search provider: Brave API vs self-hosted SearXNG (§5) — privacy
   posture vs operational surface.
2. Should `web_fetch` verification also require per-domain first-use
   confirmation in chat (one-time "allow example.com?" prompt persisted
   as an explicit allow row), or is the channel gate + screening enough?
3. Home location for default weather: reuse an existing workspace
   setting or add one (explicit column, never derived)?
