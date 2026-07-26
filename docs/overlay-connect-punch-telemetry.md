# Overlay connect — punch telemetry (WARP-1389)

Stage-3 observability for the direct-punch remote-access overlay (ADR-031 /
WARP-1382). Opt-in, operational only: **no packet contents, no client IPs at
rest** beyond the session rows that already expire. Two surfaces:

## 1. Box-side counters (orchestrator)

Emitted by `apps/orchestrator/src/services/overlay-connect.service.ts` on the
existing box metric surface — the `Analytics.metric(name, value, labels)` sink
(`apps/orchestrator/src/services/analytics`). No new endpoint, no new env.

| Metric | When | Labels |
|---|---|---|
| `overlay.punch.attempted` | one HQ session offer fully processed (answer sent + peer installed), per tick | `nat_class` = `port_preserving` \| `symmetric` |
| `overlay.punch.succeeded` | idle-expiry sweep tears down an overlay peer that **has** a real wg `latest handshake` | — |
| `overlay.punch.failed` | idle-expiry sweep tears down an overlay peer that **never** handshook | — |

- **`nat_class`** is derived from the box's OWN STUN mapping only: observed
  reflexive port `== 51820` (the wg listen port) ⇒ the upstream NAT is
  port-preserving (punch-friendly); otherwise it rewrote the port
  (`symmetric`, punch-hostile). No client data.
- **succeeded / failed** are settled at teardown from the peer's real
  `latest_handshake`, read via the routing `GET /vpn/peers` enrichment
  (`peer_handshakes`, a *permitted* ubus `network.interface.<iface> status`
  read — deliberately **not** `wg show` / `file.exec`, which the droplet-ai
  rpcd ACL denies on purpose).
- **UNKNOWN is kept distinct from an observed 0.** When the runtime read
  succeeds, every peer carries `latest_handshake` (a real `0` = the peer exists
  but never handshook ⇒ **failure**; `>0` ⇒ **success**). When the read is
  UNAVAILABLE (ubus carried no peer data), routing **omits** the field
  entirely and the sweep emits **neither** metric for that peer — it never
  guesses `0`. A `latest_handshake` of `0` therefore means failure ONLY because
  the field's presence proves the read succeeded; an absent field is UNKNOWN,
  not a failure. (Collapsing the two would report a false 0% success rate on any
  box lacking the ubus peer surface and poison the WARP-1390 relay dataset.)

## 2. HQ-side success-rate (D1 query recipe — operator doc, not code)

The HQ Worker (`droplet-fleet-hq`, WARP-1384) audit-logs each overlay signaling
step into its D1 `audit_log` (same pattern as `provision` / `claim`). An
operator computes weekly punch success-rate per box from those rows —
`overlay_connect` (offered) vs `overlay_answer` vs `overlay_complete`:

```sql
-- Weekly overlay punch success-rate per device (paste into `wrangler d1 execute`).
-- Assumes audit_log(device_id TEXT, action TEXT, ts INTEGER epoch-seconds).
SELECT
  device_id,
  strftime('%Y-%W', datetime(ts, 'unixepoch'))                              AS week,
  SUM(action = 'overlay_connect')                                           AS offered,
  SUM(action = 'overlay_answer')                                            AS answered,
  SUM(action = 'overlay_complete')                                          AS completed,
  ROUND(
    100.0 * SUM(action = 'overlay_complete')
          / NULLIF(SUM(action = 'overlay_connect'), 0), 1)                  AS success_rate_pct
FROM audit_log
WHERE action IN ('overlay_connect', 'overlay_answer', 'overlay_complete')
  AND ts >= unixepoch('now', '-56 days')
GROUP BY device_id, week
ORDER BY device_id, week;
```

```bash
wrangler d1 execute droplet-fleet-hq --command "$(cat this_query.sql)"
```

This sizes the punch-failure tail that gates the relay-fallback decision
(WARP-1390) — the ~10–15% folklore we replace with measured data.
