# ADR-031: Own WireGuard overlay for remote access (direct-first, hole-punched, HQ-signaled)

- **Status:** Accepted (founder decision, Stefan Cruceru, 2026-07-18) — relay-fallback transport sub-decision pending the WARP-1390 spike
- **Epic:** [WARP-1382](https://warp-lab.atlassian.net/browse/WARP-1382) · this doc: [WARP-1383](https://warp-lab.atlassian.net/browse/WARP-1383)
- **Supersedes:** the *customer-facing client* story of ADR-025A (`droplet-fleet-hq`) as amended by WARP-1000 (Cloudflare One/WARP client + Zero Trust org). The box-side `cloudflared` relay and the `still-credit-6887` Zero Trust org **remain**, re-scoped to *internal-only* (team + WARP-Lab-operated pilot boxes).
- **Builds on:** ADR-009 (no public inbound), ADR-023 (per-device public-CA TLS, split-horizon `<name>.droplet-us.com`), WARP-975 (named addresses), the P1 hybrid home/away peer model (PR #897), and the P2 native WG clients (android #18, iOS #31, windows WARP-359).

## Context

The product promise is a one-tap **Connect** in our own apps that reaches
`https://<name>.droplet-us.com` from anywhere, with the padlock terminating on
the box's own certificate — and a hard product requirement set 2026-07-18:
**customers must never be asked to change anything later.** Whatever ships to
customer #1 must be the architecture at customer #100,000.

Two facts forced this decision:

1. **The away-mode WireGuard conf the dashboard mints today is dead by design**
   ([WARP-1391](https://warp-lab.atlassian.net/browse/WARP-1391)): its
   `Endpoint = <name>.droplet-us.com` is deliberately public-NXDOMAIN
   (ADR-023 §split-horizon), so a stock WG client off-LAN has no handshake
   target. Verified live on .87: peer present, keepalive set, zero handshakes.

2. **The Cloudflare Zero Trust path does not scale to customers.** Verified
   against [Cloudflare's account limits](https://developers.cloudflare.com/cloudflare-one/account-limits/)
   and [pricing](https://www.cloudflare.com/plans/zero-trust-services/)
   on 2026-07-18:

   | Per-account cap (shared org) | Limit | Consequence |
   |---|---|---|
   | Tunnels / routes / virtual networks | 1,000 each | hard fleet ceiling |
   | Gateway DNS policies | **500** | per-box DNS overrides die first |
   | Gateway network policies | **500** | per-customer isolation policies die ≈500 customers |
   | Seats past 50 users | $7/user/month | recurring COGS per customer |

   Org-per-customer (Tenant API) fixes the limits and makes isolation
   structural, but gates on a Cloudflare partnership agreement, keeps
   Cloudflare's own client app + enrollment UX (team name, email OTP) in front
   of customers, and rests customer economics on free-tier terms Cloudflare can
   change. Any later exit would mean telling every customer to switch apps —
   exactly what the requirement forbids.

## Decision

Ship remote access as an **own WireGuard overlay**:

1. **Client = our apps.** The native WG tunnels already built in P2 (android
   GoBackend, iOS WireGuardKit/NE, windows wintun per WARP-359) are the only
   client surface. No third-party app is ever in front of a customer.
2. **Control plane = the HQ Worker** (`droplet-fleet-hq`) — it already holds
   the device registry, names, certs, and PoP-auth patterns. It gains
   rendezvous/signaling endpoints and a **box-vouched client-device registry**
   (the box signs a grant over its owner's device pubkeys; HQ never owns user
   accounts) — [WARP-1384](https://warp-lab.atlassian.net/browse/WARP-1384).
3. **Data plane = direct WireGuard via NAT hole-punching.** The box keeps an
   *outbound* long-poll/heartbeat to HQ (no inbound listener — ADR-009 holds).
   On a connect request both sides STUN-discover their public UDP mappings,
   exchange them through the Worker, and simultaneous-open; the phone↔box
   WG tunnel is end-to-end — no intermediary can read traffic
   ([WARP-1385](https://warp-lab.atlassian.net/browse/WARP-1385) box agent,
   [WARP-1386](https://warp-lab.atlassian.net/browse/WARP-1386) android
   reference, [WARP-1387](https://warp-lab.atlassian.net/browse/WARP-1387) iOS,
   [WARP-1388](https://warp-lab.atlassian.net/browse/WARP-1388) windows).
4. **DNS = the box itself.** Peer confs already carry `DNS = 192.168.20.1`,
   and the box's dnsmasq already resolves `<name>.droplet-us.com`
   split-horizon. Nothing new is hosted; no external DNS product, no policy
   caps. The public zone stays NXDOMAIN (box invisible to the internet).
5. **Fallback for punch failures** (hard NAT/CGNAT; industry folklore says
   ~10–15% of sessions, we will measure —
   [WARP-1389](https://warp-lab.atlassian.net/browse/WARP-1389)): a **blind
   relay** that forwards encrypted WG packets it cannot read. Transport choice
   is data-gated by the [WARP-1390](https://warp-lab.atlassian.net/browse/WARP-1390)
   spike: Cloudflare TURN (managed, per-GB, serverless-for-us) vs tiny
   self-run stateless relays (the Nabu Casa / Home Assistant precedent — the
   sovereign-appliance market leader runs exactly these blind relays as its
   paid cloud product). Either is invisible to customers.
6. **The Zero Trust org `still-credit-6887` is internal-only** from this day.
   Team and WARP-Lab-operated pilot boxes may use the cloudflared/WARP bridge;
   **no external customer is ever enrolled in it**, so no customer ever
   migrates off it.

### The customer-stable contract (the invariant this ADR exists to protect)

> **Our app + `https://<name>.droplet-us.com` + the box's own certificate.**

Everything beneath that line — direct vs relayed, the relay vendor, the
signaling protocol version — is swappable without the customer noticing.
No third party's client app, account limits, or pricing can force a
customer-facing change, because no third party is in the customer-facing path.

## Consequences

**Positive**
- Isolation is structural per box key-pair, not per-policy in a shared org; no
  500-policy walls, no 1,000-tunnel ceiling, no per-seat COGS.
- The sovereignty thesis extends to remote access: e2e WG crypto phone↔box;
  in the direct case no packet touches any intermediary at all.
- Reuses what exists: HQ Worker (registry/names/certs/PoP), P2 native
  tunnels, the box's wg0 + split-horizon resolver. The genuinely new code is
  signaling endpoints, a box punch agent, and client connect flows.
- White-label "Droplet Connect" (P4) shares the same driver and contract.

**Negative / risks (owned, not hidden)**
- **Punch failure is real.** Until the relay fallback ships, some networks
  (CGNAT-behind-CGNAT, symmetric NAT both ends) will fail with an honest
  "remote connect unavailable on this network" message and home-mode still
  working. Telemetry (WARP-1389) sizes this before the relay decision.
- **The relay question reopens the "no servers" stance.** v1 ships with zero
  servers (Worker signaling + direct punch only). If the data says the tail
  matters, the CEO decision is CF TURN (per-GB, no ops) vs tiny self-run
  relays (~tens of $/month/region, real ops). WARP-1390 carries that memo.
- **Signaling is a DoS/abuse surface.** Rendezvous endpoints must be
  PoP-authed with distinct domain-prefix messages (existing `crypto.ts`
  pattern), rate-limited, and audit-logged like provision/claim.
- **The single-box NAT path was rebuilt for the punch** (shipped in
  WARP-1385): wg0 lives in `droplet-openwrt`, and the original docker-proxy
  publish of udp/51820 masqueraded the container's *outbound* wg packets with
  an ephemeral host source port — so the home router's egress mapping never
  matched the inbound path and hole-punching could not work. The listener is
  now wired at the host layer by `droplet-openwrt-attach`: DNAT of inbound
  udp/51820 into the container plus a source-port-preserving masquerade on
  egress; the compose port-publish is removed. Any future change to the
  openwrt networking must preserve this src-port-51820 invariant (tcpdump
  verification recipe in the epic).
- **IPv6 and app-JWT-vs-host caveats** are tracked in the client stories
  (tokens are minted against the LAN baseURL today).

## Phasing

| Phase | Scope | Tickets |
|---|---|---|
| 0 (interim, ships first) | Stop minting dead away confs from the user toggle; home-mode default + honest copy | WARP-1391 |
| 1 | HQ signaling + device grants; box punch agent | WARP-1384, WARP-1385 |
| 2 | Android reference client e2e (cellular → .87) | WARP-1386 |
| 3 | iOS + Windows parity; telemetry | WARP-1387, WARP-1388, WARP-1389 |
| 4 | Relay-fallback decision + implementation | WARP-1390 (+ follow-up ticket) |

Home mode (PR #897 semantics) is unchanged throughout: on the home LAN the
apps keep dialing the box's LAN IP directly — it doubles as the fallback UX
whenever the overlay can't connect.
