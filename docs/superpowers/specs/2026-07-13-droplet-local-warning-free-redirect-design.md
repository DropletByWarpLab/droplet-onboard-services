# Warning-free `droplet.local` via canonical-host redirect — design

**Date:** 2026-07-13
**Status:** Approved (brainstorm with Romain, 2026-07-13)
**Builds on:** [ADR-023](../../ADR-023-public-ca-per-device-tls-via-hq-dns01.md) (public-CA per-device TLS — this design is the follow-through on its action item #5: "FQDN as the happy path, retire the trust-script"), WARP-979 (friendly `<name>.droplet-us.com` claimed names), WARP-584 (trust-flow UX).
**Ticket:** TBD — file under the ADR-023 epic.

## Problem

Visiting `https://droplet.local` on the LAN always hits the browser
"connection not private" interstitial: the name is served with the
bootstrap self-signed cert, and **no public CA may ever sign a `.local`
name** (mDNS special-use, prohibited by CA/Browser Forum rules). ADR-023
gave every box a publicly-trusted Let's Encrypt cert on a per-device FQDN
(`d-<hmac>.devices.warp-lab.ai`, or `<box-name>.droplet-us.com` once
WARP-979 lands), but the friendly `.local` name still funnels users into
the warning: nginx's `:80` server upgrades every host to
`https://$host`, i.e. straight into the self-signed handshake.

**Goal:** typing `droplet.local` never shows a warning, on any client,
with zero per-client trust install. The trust-install script survives
only as the air-gapped escape hatch.

## Decision (Approach A, approved)

`droplet.local` (and the other friendly names) becomes a **memorable
entry point that redirects to the trusted per-device FQDN**. The
cert-less state is made an anomaly by issuing the first cert at
provisioning time, and the anomaly itself is handled by a **plain-HTTP
status page** (no interstitial, no secrets) instead of a forced HTTPS
upgrade.

Ratified judgment calls:
- **Bare-IP access is exempt from the redirect** (`https://192.168.x.1`
  keeps serving the app directly, self-signed warning and all): it is
  the break-glass door when DNS itself is broken; redirecting it into a
  DNS-dependent name could lock the operator out.
- **No app content ever rides plain HTTP.** The status page is static,
  unauthenticated, cookie-free. Full-dashboard-over-HTTP was considered
  and rejected (Foundation: no credentials in cleartext, ever).

## User journey (what people type, see, and end up on)

The mental model we teach: **"`droplet.local` is what you type; your
box's real address is `https://<box-name>.droplet-us.com`."** The user
never has to install, configure, or click through anything.

| # | User action | What they see | Final address bar |
|---|---|---|---|
| 1 | Types `droplet.local` (normal state) | Instant hop, then the dashboard with a **green padlock**. No warning, no flash of content in between. | `https://<box-name>.droplet-us.com` (or `d-<hmac>.devices.warp-lab.ai` pre-naming) |
| 2 | Clicks an **old bookmark** `https://droplet.local` | One last cert interstitial (unavoidable — TLS fails before a redirect can be sent) → Proceed → padlocked dashboard. Re-bookmark from there; never seen again. | the FQDN |
| 3 | Follows any **emitted link** (setup wizard, invite, QR, docs) | Straight to the padlocked dashboard — links always carry the FQDN (§5). | the FQDN |
| 4 | **Off-LAN over the VPN** | Uses the same FQDN (split-horizon resolves it to the WG gateway). `droplet.local` doesn't exist off-LAN — mDNS doesn't cross the tunnel — so the FQDN is the one URL that works everywhere. | the FQDN |
| 5 | Types `droplet.local` in the **anomaly state** (no valid cert) | Plain status page: "Your Droplet is securing its connection…" — auto-advances to the padlocked FQDN when issuance lands. Nothing to do. | the FQDN (after auto-advance) |
| 6 | Same, **air-gapped box** | Status page explains, offers the trust-install package or "continue anyway (one warning)". | `https://droplet.local` (trusted after install, or post-click-through) |
| 7 | **Break-glass:** types `https://192.168.x.1` | Self-signed warning → proceed → dashboard. Deliberately exempt from the redirect (works even when DNS is down). | the IP |

One-time cost on rollout: sessions don't cross origins, so existing
`.local` users log in once more on the FQDN.

## Components

### 1. nginx — host-aware canonical redirect

New rendered include `canonical-host.active.conf` in
`docker/nginx/`, following the existing render/symlink-at-start pattern
(`internal-scheme.active.conf`, `cipher-profile.active.conf`). Two
variants:

- **ON** — rendered with the live `DROPLET_PUBLIC_FQDN`; a
  `map $host $canonical_redirect` marks the friendly names
  (`droplet.local`, `droplet-ai.local`, `droplet.lan`,
  `droplet-ai.lan` — the SAN set from
  `scripts/lib/secrets.sh::_generate_tls_cert`) as redirect sources.
  Exempt: the FQDN itself, `localhost`, and any literal-IP Host.
- **OFF** — empty map; byte-identical behavior to today.

Server-block behavior:

| State | `:80` friendly name | `:80` FQDN | `:443` friendly name | `:443` FQDN / IP / localhost |
|---|---|---|---|---|
| ON  | `307 https://<fqdn>$request_uri` | upgrade to HTTPS (as today) | `307 https://<fqdn>$request_uri` (after the unavoidable one-time interstitial for old bookmarks) | serve app |
| OFF | serve **status page** (no HTTPS upgrade) | upgrade to HTTPS | serve app (self-signed, click-through — today's behavior) | serve app |

Redirect status is **307**: method-preserving (API `POST`s aren't
downgraded to `GET`) and non-cacheable (state can flip OFF without
clients holding a poisoned permanent redirect). Path + query are
preserved via `$request_uri`.

### 2. ON/OFF decision — derived from the cert artifact

Redirect is ON iff **all four** hold: **(a)** `docker/certs/droplet.crt`
is not self-issued, **(b)** it is unexpired, **(c)** it carries the FQDN
in its SANs — all checked with `openssl` at render time — and **(d)**
the box owns the LAN's DNS, via an **explicit `.env` flag**
(`DROPLET_LAN_DNS_AUTHORITY=1`, written once by `setup.sh` on shapes
where the box is the router/DHCP/DNS — single-box — and `0` elsewhere;
explicit column, never derived, per the repo's no-guessing rule).

Condition (d) exists because the redirect target is only resolvable
through the box's own dnsmasq (split-horizon; public NXDOMAIN), while
`droplet.local` resolves via mDNS peer-to-peer regardless of the
client's DNS server. On a dev/lab shape where the box sits behind an
existing router, clients resolve `.local` but NOT the FQDN — a 307
there would dead-end in a browser DNS error, strictly worse than
today's warning. Those shapes keep today's behavior. The render lives in the
host-side `scripts/lib/tls-reload.sh` (or a sibling it sources), which
is already the single choke point every cert writer passes through:
the self-signed bootstrap (`_generate_tls_cert`), the LE install path
(orchestrator → device-bridge), and `--sync-secrets` re-runs. Render
the include → `nginx -s reload`. One writer, no drift.

`TlsCertState` (Prisma enum) remains the orchestrator's source of truth
for *issuance decisions*; nginx deliberately trusts the artifact so a
`LE_RENEW_FAILED` box with a still-valid cert keeps redirecting until
the cert actually dies (30-day renewal threshold = 30 days of
self-healing runway). Accepted staleness: redirect may stay ON up to
one daily issuance tick (~24 h) past expiry before the render flips it.

### 3. Cert-less state — plain-HTTP status page

When OFF, `http://droplet.local` serves a small static page from nginx
itself (no proxying to the dashboard): "Your Droplet is securing its
connection…". The page:

- polls one **unauthenticated, read-only** orchestrator endpoint
  (`GET /api/tls/status` — cert state only, no device details) proxied
  over HTTP, and auto-redirects to `https://<fqdn>` the moment issuance
  lands;
- when the box reports HQ unreachable/disabled (air-gapped branch),
  explains that, and offers (i) the packaged trust-install path
  (`trust-droplet-cert.{sh,ps1}`) and (ii) a plain link to
  `https://droplet.local` — "continue anyway (you'll see a browser
  warning once)".

Browsers render plain-HTTP local pages with only the grey "Not Secure"
chip — no interstitial. This is the only surface that ever rides HTTP.

### 4. Provision-time issuance — kill the first-boot window

Mostly process, not code: boxes are Warp-leased hardware and the
issuance machinery (boot-tick → TPM PoP → HQ → LE install →
split-horizon dnsmasq) already runs unattended. The provisioning bench
runs first boot **with WAN connected**; the packing checklist gains
"padlock green on the bench" as a gate. The box ships with ~90 days of
cert validity; the renewal cron takes over at the customer's home.
Because the box *is* the router, the split-horizon record (FQDN → its
own LAN-side IP) travels with it — nothing re-registers on-site.

Code-side addition: a provisioning assertion (in `scripts/verify.sh`
or a `setup.sh --provisioning` flag) that fails the bench run unless
`TlsCertState = LE_ISSUED` and the render check reports ON.

**Verify during implementation:** that the dnsmasq hostrecord written
at install time persists across the factory→customer move with no
dependency on a setup re-run (the LAN-side IP is the box's own static
router address, so it should; confirm on hardware).

### 5. FQDN-everywhere (ADR-023 item #5 completion)

Every emitted URL — `setup.sh` output, setup wizard, VPN client
configs, invite links (already FQDN-first via
`apps/orchestrator/src/lib/trusted-origin.ts`), docs — prints
`https://<fqdn>`, never `https://droplet.local`. The `.local` name
survives only as the thing humans type. With WARP-979, the render reads
`DROPLET_PUBLIC_FQDN`, so the redirect target automatically becomes the
friendly `<box-name>.droplet-us.com` once the owner names the box.

Known one-time cost: cookies don't cross origins, so existing `.local`
users re-authenticate once on the FQDN.

## Edge cases

- **Typed `droplet.local`:** Chrome/Edge (HTTPS-Upgrades) and Firefox
  (HTTPS-First) silently fall back to `:80` on cert failure; Safari
  starts at HTTP. All land on the 307 → padlock. Each verified in the
  E2E pass.
- **"Browsers are killing HTTP" — why this design survives that trend
  (assessed 2026-07):** no major browser blocks HTTP; they attempt
  HTTPS first and **silently fall back** on failure, and all of them
  deliberately exempt local/private hostnames from the HTTPS-first
  push. Chromium classifies `.local` (RFC 6762), RFC 1918 IP literals,
  and single-label names as *non-unique hostnames*
  (`net::IsHostnameNonUnique()`) and excludes them from HTTPS-First
  warnings — including the "Always Use Secure Connections" default
  Google has announced for ~October 2026 (Chrome 154), whose warning
  campaign targets insecure *public* sites precisely because local
  devices cannot obtain publicly-trusted certs. Firefox's HTTPS-First
  (default since 129) likewise downgrades silently on failure with
  local-address exemptions; Safari starts typed local names at HTTP.
  Only users who opt into strict HTTPS-Only mode see anything: a
  bypassable "continue?" notice, accepted for every router/printer
  admin page they own. Design posture: HTTP carries only a sub-second
  307 bounce and the anomaly status page — never app content — and if
  a future browser tightened past the private-site exemption, the
  failure floor is today's interstitial, never worse.
- **Explicit `https://droplet.local` bookmarks:** one final
  interstitial click-through, then the 307 moves them to the FQDN for
  good. Physics — TLS fails before any redirect can be sent.
- **Hard-forced DoH clients** (e.g. Firefox "Max Protection", manual
  resolver): can't resolve the split-horizon FQDN (public NXDOMAIN) →
  documented limitation; `.local` + click-through still works.
  Default-mode browser DoH falls back to the OS resolver and is fine.
- **HSTS:** browsers ignore HSTS from untrusted connections, so the
  existing `Strict-Transport-Security` header cannot wedge `.local`
  clients; add a config comment saying so.
- **Client with hardcoded third-party DNS** (user set 8.8.8.8 on their
  laptop, on an otherwise normal single-box network): `.local` resolves
  via mDNS, the FQDN doesn't → the 307 lands on a browser DNS error.
  Self-inflicted and rare; recovery paths are the break-glass IP or
  reverting their DNS override. A future smart interstitial (below)
  would soften this.
- **Initial-setup ordering:** there is no "before DNS is set" window on
  the shipping shape. The box *is* the router: a client that can reach
  `droplet.local` at all necessarily joined the box's network, whose
  DHCP hands out the box's dnsmasq — which answers the FQDN from the
  same host-record store. Cert (provisioned at bench) and DNS record
  (registered at install, travels with the box) both pre-exist first
  customer contact. If dnsmasq/mDNS are down entirely, `droplet.local`
  doesn't resolve either — unreachable, same as today; break-glass IP
  applies.
- **Trust-script clients** (installed the self-signed cert): in the ON
  state the box serves the LE cert (single cert pair, and no CA can put
  `.local` in it), so an explicit `https://droplet.local` bookmark gets
  a hostname-mismatch interstitial once — same as any other client —
  then the 307 moves them to the FQDN. Typed `droplet.local` falls back
  to `:80` and redirects cleanly. In the OFF state their install works
  as today (self-signed cert carries the `.local` SANs).

## Testing

- `tests/nginx-canonical-host.test.sh`, mirroring the
  `tests/nginx-internal-scheme.test.sh` harness: render both variants,
  `nginx -t` inside the gateway image, then curl assertions for the
  full host × state × port matrix (redirect / serve / status page /
  IP-exempt / localhost-exempt / path+query preservation / 307 method
  preservation).
- Unit tests for the render decision (openssl parsing: self-issued,
  expired, SAN-mismatch, happy path) beside `tls-reload.sh`.
- Orchestrator vitest for `GET /api/tls/status` (unauthenticated,
  state-only payload).
- Final gate (ADR-023 action item #7): reflash `192.168.1.87` — green
  padlock typing `droplet.local` on LAN and over the VPN, per-browser
  matrix (Chrome, Safari, Firefox, Edge; macOS + iOS + Android).

## Out of scope

- Making the address bar *stay* on `droplet.local` (impossible without
  per-client trust install — explicitly traded away).
- Serving the full dashboard over plain HTTP (rejected, Foundation).
- Client trust-onboarding UX beyond the status-page links (Approach C;
  revisit only if air-gapped installs become a real segment).
- A "smart interstitial" replacing the bare 307 (tiny page that beacons
  `https://<fqdn>` and redirects only on success, showing DNS guidance
  otherwise). Would gracefully handle clients with hardcoded
  third-party DNS; deliberately deferred — the explicit
  `DROPLET_LAN_DNS_AUTHORITY` gate covers the deployment-shape version
  of the problem, and the per-client version is rare + self-inflicted.
- fleet-hq changes (issuance contract is untouched; WARP-979 name claim
  is its own coupled follow-up).
