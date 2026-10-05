# ADR-071: Box ↔ edge-router pairing — the router opens a window, the box mints the credential, the owner clicks Pair

- **Status:** Proposed, 2026-10-05 ([WARP-3739](https://warp-lab.atlassian.net/browse/WARP-3739), epic [WARP-3834](https://warp-lab.atlassian.net/browse/WARP-3834)). The decisions it records are Romain's, 2026-10-05 (D4 and D6 on the ticket and the epic, plus the three answers in §8 on PR #2705 the same day). §2 is the decision; §3 narrows one clause of D4, says why, and records that Romain confirmed the narrowing.
- **Closes:** the gap named in [`ADR-033`](ADR-033-edge-router-shape.md) §5 ("an automatic pairing/enrollment handshake is the named gap") and [`ADR-035`](ADR-035-network-fabric.md) §3's "enrollment for future images" bullet (device advertises unenrolled state in mDNS TXT, physical presence proven device-side, the box mints the credential). It **replaces** ADR-035 §3's *bootstrap* bullet (the box uses the baked recovery SSH key once) — see §4 (b).
- **Builds on:** [`ADR-033`](ADR-033-edge-router-shape.md) (one protocol, three endpoints; per-unit `droplet-ai` passwords; the typed AUTH state), [`ADR-035`](ADR-035-network-fabric.md) §4 phase 0 (pinned HTTPS, which follows this), [`ADR-057`](https://github.com/DropletByWarpLab/warp-lab-engineering-handbook/blob/main/FABRIC-ADDRESSING-ARCHITECTURE-BRIEF.md) (handbook brief: the router is always `.1`, the unit always `.10` — the addresses this handshake runs between are fleet constants, so no discovery is needed to find the router), [`ADR-019`](ADR-019-storage-pool-management.md) D6.1 and [`ADR-070`](ADR-070-camera-recording-storage.md) (spool + root apply unit started through polkit), [`ADR-014`](ADR-014-llm-client-dispatched-actions.md) (writes ask).
- **Number:** 071. Checked 2026-10-05: `origin/stage` and `origin/main` carry `docs/ADR-*` up to `ADR-070`; no open PR in this repository adds or cites an `ADR-071`; no WARP ticket mentions `ADR-071` or `ADR-064`. The gaps below 070 (047, 048, 050, 052–054, 057–059, 064) are handbook briefs or numbers claimed elsewhere (`ADR-060` header, handbook README register), so this takes the next number above the ceiling, as `ADR-070` did. A claimed number reserves nothing: re-check before merge.

## 1. Context

The edge router mints a random `droplet-ai` password at first boot and after every `sysupgrade -n` (`droplet-edge-router` `files/etc/uci-defaults/99-droplet-edge-rpc:101-108`) and keeps it in `/etc/droplet/droplet-ai-password`. The box learns it only by hand: an operator copies it into `docker/secrets/openwrt_password` (edge-router `docs/OPERATIONS.md` § "Connecting the dashboard": *"There is no automatic pairing handshake yet, so this is a manual step after every flash"*). The AP and the switch need the same copy (`ap_openwrt_password`, `switch_password`).

What that costs, verified on `origin/stage` and `droplet-edge-router@main` on 2026-10-05:

- **A business without IT cannot do the step.** On 2026-10-05 the lab box turned out to have *never* been paired with its router; the dashboard's network views returned 503 and nothing in setup noticed (WARP-3834). Nobody has root on that router, because its image was built without an SSH key (`build/build.sh:181-193` only logs a note; WARP-3836 makes it refuse).
- **The credential travels outside any audited path** (SSH pipe or copy-paste).
- **The manual step was a repeating outage.** `setup.sh --sync-secrets` rewrote the pasted secret from the box's own `.env` on every run until WARP-3738 (#2694, merged 2026-10-05).
- **Every in-place router upgrade unpaired the box**, because `99-droplet-edge-rpc` re-mints on every boot even when `keep.d` preserved the file (WARP-3837, open).

What the box already has, which this ADR reuses rather than rebuilds:

- **A typed AUTH state.** `services/routing/main.py:272-303` records `_last_connect_failure = "auth"` when the router answers but rejects the credential; `get_router()` (`:359`) turns it into HTTP 502 `ROUTER_AUTH`, the orchestrator maps it to `RouterError` code `AUTH` (`apps/orchestrator/src/types/router-error.ts:24,100`), and the dashboard already renders "Credentials rejected" (`apps/web-dashboard/src/app/network/page.tsx:95`). The background reconnect keeps retrying with capped backoff (`services/routing/reconnect.py:68-160`), so a reflashed router is noticed within the backoff, with no new poller.
- **A fabric inventory that tolerates new TXT keys.** `FabricApi.browse_members()` (`services/routing/droplet_openwrt_sdk.py:2787`) parses `_droplet-*._tcp` adverts and lands any key outside `role/mac/model/version` (`:2771`) verbatim in `extra` (`:2885`), surfaced by `GET /fabric/members` (`main.py:3827`) and upserted as `FabricMember` rows (`apps/orchestrator/src/services/fabric-member-reconciler.ts`).
- **A root-executor pattern for things a container cannot do.** The device-bridge runs unprivileged and spools an owner-confirmed request to tmpfs, then asks PID 1 to start a root oneshot through one polkit rule, start verb only (`services/oled-display/50-droplet-device-bridge.rules:54-67`; units `droplet-storage-pool-apply.service`, `droplet-nvr-storage-apply.service`, `droplet-nvr-migrate.service`). The orchestrator reaches the bridge over `DEVICE_BRIDGE_URL` with a bearer token (`apps/orchestrator/src/services/reset.service.ts:14-16,385-386`).
- **An audit row for every confirmed network write.** `network-safety.service.ts:391` writes `CommandAuditLog` (`prisma/schema.prisma:1391`) with the user, domain, tier, `confirmed`, and secret-redacted params.
- **A device identity.** `device-identity-svc` exposes the box's TPM-backed key over a unix socket that the orchestrator mounts (`docker/docker-compose.yml:698-701`); the HQ contract already defines `key_fingerprint` = SHA-256 of the DER SPKI, lowercase hex.
- **A read-only rpcd plugin precedent on the switch.** `switch/files/usr/share/rpcd/ucode/droplet-bridge.uc` adds one ubus object (`bridge.fdb`) without granting `file exec`; its ACL line is `"bridge": ["fdb"]` in `switch/files/usr/share/rpcd/acl.d/droplet-ai.json:10`.

And the two constraints that shape the answer:

- **The AI side is never exposed to the network** (FOUNDATION). Anything that gives the box a standing root path onto the router is out.
- **The router is disposable.** A reflash must be routine, so the handshake must re-run after `sysupgrade -n` with no secret surviving on either side.

## 2. Decision

### 2.1 Router side: `droplet.pair`, open only during a pairing window

A ucode rpcd plugin, `files/usr/share/rpcd/ucode/droplet-pair.uc` in `droplet-edge-router`, registers one ubus object `droplet.pair` with two methods:

| Method | Args | Answers | Effect |
|---|---|---|---|
| `status` | — | `{pairing: "open"\|"closed"\|"paired", window_ends_at?, paired_box?}` | none |
| `claim` | `{password, box_fingerprint}` | `{ok: true}` or `{error}` | sets the `droplet-ai` password; records the box; closes the window |

Both methods are granted to rpcd's **`unauthenticated`** ACL group (a new `acl.d/droplet-pair.json`), because the whole point is that the caller does not yet hold a credential. Nothing else is granted to that group; `droplet-ai`'s own ACL is untouched.

**The window.** `claim` is accepted only while `/var/run/droplet-pair/open` exists (tmpfs: a window never survives a reboot). It is opened by:

1. **First boot with no box enrolled**: `99-droplet-edge-rpc` opens it after minting, and only when `/etc/droplet/paired-box` is absent. It closes on the first successful claim or after **24 h**, whichever comes first (`PAIR_FIRSTBOOT_WINDOW_SECONDS=86400` in `/etc/droplet-edge.conf`, the same `: "${VAR:=default}"` tunable pattern the file already uses for `GUEST_*` and `LAN_DHCP_*`). 24 h, not 30 min, because the box's own first boot can take up to 45 min after the router is up (Romain, 2026-10-05). After WARP-3837 a config-keeping `sysupgrade` reuses the kept password and does not open a window; only `sysupgrade -n` or a fresh unit does.
2. **A reset-button press** (`/etc/rc.button/reset`, RB5009): a short press (< 5 s) opens the window for **30 min** (`PAIR_BUTTON_WINDOW_SECONDS=1800`, same file). The stock handler reboots on short press and runs `firstboot` on a ≥ 5 s hold; the Droplet handler keeps the long-press factory reset (which also yields a fresh, windowed first boot) and replaces the short-press reboot with "open the pairing window". Boards with no button (Pi 5) have path 1 only.

**On `claim`:** the plugin validates the password (32 lowercase hex chars; refuse anything else, mirroring `set_password`'s length refusal in `99-droplet-edge-rpc:62-64`) and the fingerprint (64 lowercase hex chars), sets the system password (`passwd` through the same shadow-first idiom — trap 1 in `99-droplet-edge-rpc:15-17`), writes `/etc/droplet/droplet-ai-password` (0600) so WARP-3837's keep-on-boot path and the operator recipe keep working, writes `/etc/droplet/paired-box` (`fingerprint=<fp>\npaired_at=<utc>\n`), removes the window file, rewrites the umdns TXT and reloads umdns, and logs the event (never the password). `/etc/droplet` is already on the sysupgrade keep list (`files/lib/upgrade/keep.d/droplet:8`), so `paired-box` survives a config-keeping upgrade.

**Advertisement.** `99-droplet-router-umdns` adds one TXT key to the existing `_droplet-router._tcp` record (`files/etc/uci-defaults/99-droplet-router-umdns:42-55`): `pairing=open`, `pairing=closed` (no window, no box: a fresh unit whose window timed out) or `pairing=paired`. D4 named two values; `closed` is the third state a fresh unit is in once its window times out without a claim. The plugin rewrites `/etc/umdns/droplet-router.json` and reloads umdns whenever the window state changes. Discovery is never trust (ADR-035 §5): the TXT tells the dashboard what to show; the router's own window file is what decides a claim.

### 2.2 Box side: AUTH + open window → the owner is asked → the box mints and claims

1. **Detect.** The routing service is in the AUTH state (`_last_connect_failure == "auth"`). While there, its background reconnect tick also calls `droplet.pair status` on `OPENWRT_HOST` with the null session (no credential). `GET /health` gains `pairing: {state, window_ends_at, paired_box}` next to the existing `error`. (Why not read the umdns TXT? see §3.)
   **First claim wins, so a stranger's claim must be visible.** If `status` says `paired` and `paired_box` is not this box's fingerprint, routing raises a **distinct** state, `ROUTER_PAIRED_ELSEWHERE` (HTTP 502, its own `code`, beside `ROUTER_AUTH` in `main.py` and `RouterError` in `router-error.ts`), never the generic AUTH one. The dashboard shows *"This router is paired to another device (fingerprint `<first 16 hex>…`). Press the router's button to re-pair."* and the orchestrator writes a `CommandAuditLog` row (`service: "router-pairing"`, `reason: "paired_elsewhere"`, data `{host, paired_box}`) once per distinct foreign fingerprint. Nothing is automatic from there: re-pairing needs the button.
2. **Ask.** The dashboard's Network page, already showing "Credentials rejected", gets a card when `pairing.state == "open"`: *"Router `<model>` at `<host>` is ready to pair. Pairing gives this Droplet control of the router's network settings."* — **Pair** / **Not now**. Owner and admins (Romain, 2026-10-05: the roles that already edit firewall rules). This is a write, so it asks (ADR-014); reads keep running automatically.
3. **Claim.** `POST /api/network/router/pair` (orchestrator, `requireRole("owner"|"admin")`) → `POST /pairing/claim` on routing. Routing mints 32 hex chars from `secrets.token_hex(16)`, reads the box fingerprint from the orchestrator (SPKI SHA-256 via `device-identity-svc`), calls `droplet.pair claim`, then **proves the claim took** by logging in as `droplet-ai` with the new password before returning. On success it switches its live session to the new password immediately and returns the password to the orchestrator over the existing service-token channel; the orchestrator never logs or persists it (`redactSecretParams`, `network-safety.service.ts:388`).
4. **Persist.** The orchestrator POSTs `{password}` to the device-bridge (`POST /host/router-pairing`, bearer-gated like `/system/factory-reset`). The bridge spools it to `/run/droplet-bridge-pair-spool/request.json` (tmpfs, 0600) and starts **`droplet-pair-apply.service`** through a fifth entry in `50-droplet-device-bridge.rules` (start verb only, user `droplet`). The unit runs the repo-tracked `scripts/host/droplet-pair-apply.sh` as root: writes `docker/secrets/openwrt_password` (0600, atomic rename), zeroes and unlinks the spool, and runs `docker compose up -d --force-recreate routing` with the checked-in compose file — because routing reads the secret once at import (`main.py:161`) and the compose secret is a file bind (`docker-compose.yml:3943-3944`). The unit has no `[Install]` section and runs only on demand, like `droplet-storage-pool-apply.service`. Installed by `install-device-bridge.sh` and listed in `scripts/host/MANIFEST` so `droplet-host-units audit` (WARP-3740) sees drift.
5. **Audit.** One `CommandAuditLog` row, `domain: "network"`, `service: "router-pairing"`, `confirmed: true`, data `{host, model, box_fingerprint, paired_at}` — never the password. Failure at any step writes the row with `blocked: false` and `reason`.
6. **Result.** Routing comes back connected; the AUTH card disappears; `/fabric/members` shows the router with `pairing=paired`.

If step 4 fails after step 3 succeeded, routing is already running on the new password (step 3) so the dashboard works; the card changes to *"Paired, but the password could not be saved — it will be lost on the next restart"* with a Retry that re-runs step 4 only (routing still holds the password in memory until it is persisted or the container restarts). The owner is never asked to copy anything.

### 2.3 AP and switch reuse the plugin

The same `droplet-pair.uc`, `acl.d/droplet-pair.json`, window file, button handler and TXT key ship in `ap/files` and `switch/files`. Box side, the AP flow lands in the AP onboarding state machine (ADR-005/024; the AP's AUTH analogue, WARP-1675) and the switch flow in `services/switch`; both call the same `claim` and the same `droplet-pair-apply.service` with a `target` field (`router|ap|switch`) that selects the secret file (`openwrt_password`, `ap_openwrt_password`, `switch_password`) and the container to recreate. ADR-035 §3's "escrow is per-device rows" is unchanged in direction and not delivered here: one secret file per role is what the compose file reads today, so that is what the writer writes.

### 2.4 Transport (D6)

Pairing goes over **HTTP** to uhttpd's `/ubus`, exactly like every ubus login today (`99-droplet-edge-rpc:143-145`). ADR-035 §4 phase 0 (uhttpd HTTPS, SPKI pin recorded at pairing) follows and hardens this; the plugin does not change when it lands, the box's `UbusClient` scheme does.

## 3. Where the code disagreed with the decided design, and what this ADR does about it

1. **The box cannot read the `pairing=open` TXT the way D4 assumed.** `GET /fabric/members` browses umdns *through the router's ubus* (`main.py:3827-3850` calls `get_router()` first, and `umdns browse` needs an authenticated session), so in the AUTH state the box has no view of the TXT at all. The box also does not need discovery to find the router: `OPENWRT_HOST` is configured and, per ADR-057, fleet-constant. So the window state the box acts on comes from the unauthenticated `droplet.pair status` call (§2.2 step 1). The TXT key is kept as decided, for the inventory and for a box that has not been pointed at a router yet.
2. **"A second claim needs the paired fingerprint" is not a proof.** The SPKI fingerprint is public (any TLS client of the box sees the certificate; HQ holds it). If a matching fingerprint alone re-opened `claim`, any LAN host that learned it could set the `droplet-ai` password and take the write ACL (`acl.d/droplet-ai.json` writes `uci` on `firewall`, `network`, `dhcp`). ucode on the router has no ECDSA verify, so the box cannot prove possession there today. **This ADR narrows D4, and Romain confirmed the narrowing on 2026-10-05 (§8.1):** while `paired-box` exists, `claim` is refused regardless of fingerprint; a second pairing needs a short press of the reset button or `sysupgrade -n`. The fingerprint is recorded for the audit row and the status view only (including the `ROUTER_PAIRED_ELSEWHERE` state in §2.2). A proof-of-possession re-claim (challenge signed by the TPM key, the HQ `droplet-register:v1:<nonce>:<fp>` shape) is possible future work if the router image ever gains signature verification; it is not a commitment of this ADR.
3. **The AUTH state is observed by routing, but the write path runs through the device-bridge, not routing.** Routing is a container and cannot start a host unit; the bridge can but does not talk ubus. §2.2 therefore splits the work: routing claims and verifies (it owns the ubus client), the bridge persists (it owns the polkit grant). The password crosses one internal hop (routing → orchestrator → bridge) it would not cross if the bridge spoke ubus; accepted, because duplicating `UbusClient` in the bridge is worse.
4. **`SECURITY.md` says the `droplet-ai` ACL "grants no `file exec` at all"; the router ACL grants `file: exec` scoped to `/etc/init.d/dnsmasq restart`** (`acl.d/droplet-ai.json` write block). True of the switch, not the router. Not changed here; the docs fix is [WARP-3842](https://warp-lab.atlassian.net/browse/WARP-3842). Noted so nobody cites that sentence as a property of the router.

## 4. Alternatives rejected

- **(b) The box holds a router root or recovery SSH key** (ADR-035 §3 bootstrap). A standing root path from the AI side onto the network device is exactly what FOUNDATION forbids, and the baked key is break-glass for humans. Rejected by Romain, 2026-10-05.
- **(c) A password seeded at flash time.** The router is flashed before the box exists, and a per-site image breaks "the router is disposable" (ADR-057 D1: the image carries no site fact).
- **(d) Stay manual.** A non-IT business cannot SSH; WARP-3738 and WARP-3834 are what manual costs.
- **A code shown on the panel that the router accepts.** Needs a typed code path on a headless router and a second UI; the button already proves physical presence (ADR-035 §3 chose the button for the same reason).
- **Enrollment broker in the orchestrator with per-device escrow rows now** (ADR-035 §3 in full). Right direction, too much for the acceptance in front of us; §2.3 keeps the door open.

## 5. Threat model

- **Reachability.** `claim` is reachable only where uhttpd's `/ubus` is: the LAN zone. The guest zone has `input=REJECT`, `forward=REJECT` and forwards only to `wan` (`99-droplet-edge-net:205-214`, WARP-1778); WAN input is the stock reject plus the two stock wan→lan holes removed by name (`:238-259`). A claim from guest or WAN is structurally impossible, not policy-blocked.
- **Who can claim inside the window.** Any LAN host, during ≤ 24 h after a fresh flash or ≤ 30 min after a button press. The LAN is the Vault segment; a hostile LAN host already defeats the two-chip split. The window closes on the first claim and on timeout, and never re-opens without physical presence (§3.2).
- **First claim wins — and is visible.** If a LAN host other than the box claims inside the window, the router is paired to it and the box is locked out. That is not silent: routing raises `ROUTER_PAIRED_ELSEWHERE` with the foreign fingerprint, the dashboard names it and tells the owner to press the button, and an audit row records it (§2.2 step 1). The attacker gains the `droplet-ai` ACL on the router until the owner presses the button; it does not gain anything on the box.
- **Replay.** A `claim` carries a fresh random password each time; replaying one is refused because the window is closed and `paired-box` exists.
- **Cleartext.** The new password crosses the LAN once in clear on HTTP, as every ubus login does today; phase 0 of ADR-035 §4 closes that for both.
- **The box side.** The root unit writes one fixed path from a tmpfs spool it re-validates (32 hex), as the pool/NVR units do; the bridge's grant is start-only on one unit; the routing container gains no privilege. Nothing here reads a router root password or key.
- **Audit.** One confirmed row per attempt, success or failure, with the actor; the password is never in a log, a row, or a response body other than the one internal hop.

## 6. Consequences

**Easier:** after `sysupgrade -n`, the owner restores network control from the dashboard with one click, no SSH, no copied secret (the epic's acceptance). The same answer covers AP and switch. The recovery SSH key goes back to break-glass only.

**Harder:** two repos move together again (plugin + ACL + button handler + TXT in `droplet-edge-router`; routing + orchestrator + dashboard + bridge + host unit here); the router gains its first unauthenticated ubus surface, so the window semantics are load-bearing and get a `verify.sh` check; a `firstboot`-style reset of the router now needs the dashboard click within 24 h of boot *or* a person near the rack to press the button.

**Unchanged:** reads run automatically, writes ask, destructive actions are blocked. The manual copy via the baked key stays the documented path until slice B ships; `setup.sh --edge-router` (WARP-3835) keeps failing setup when routing cannot authenticate.

## 7. Implementation slices

Each is one ticket under WARP-3834 and lands behind the previous one.

**Slice A — router plugin, window, TXT (`droplet-edge-router`)**
`droplet-pair.uc`, `acl.d/droplet-pair.json` (`unauthenticated` → `droplet.pair: status, claim`), window open in `99-droplet-edge-rpc` on first boot without `paired-box` (after WARP-3837's conditional mint), `/etc/rc.button/reset` short-press → open window, `pairing=` TXT in `99-droplet-router-umdns`, `PAIR_FIRSTBOOT_WINDOW_SECONDS` (86400) and `PAIR_BUTTON_WINDOW_SECONDS` (1800) in both `droplet-edge.conf` files, `build/verify-rootfs.sh` asserts the four files, `scripts/verify.sh` checks the object exists and `claim` is refused when paired.
*Accept:* on a bench unit after `sysupgrade -n`, `ubus call droplet.pair status` with the null session returns `open` with `window_ends_at` 24 h out; a `claim` with a 32-hex password logs in as `droplet-ai` with it; a second `claim` is refused regardless of `box_fingerprint`; with the first-boot knob set to 60 s for the test, `status` is `closed` and `claim` refused after it elapses; a short button press re-opens for 30 min; the TXT flips `open→paired`; `/etc/droplet/paired-box` survives a config-keeping `sysupgrade`; the firstboot log never contains the password.

**Slice B — box flow for the router (this repo)**
Routing: `droplet.pair` null-session client in the SDK, `pairing` in `/health`, `POST /pairing/claim` (mint, claim, verify login, switch live session, return). Orchestrator: `POST /api/network/router/pair` (owner/admin, fingerprint from `device-identity-svc`, `CommandAuditLog` row, bridge dispatch). Bridge: `POST /host/router-pairing`, spool, start unit. Host: `droplet-pair-apply.service` + `droplet-pair-apply.sh` (write 0600, atomic, recreate routing), polkit fifth grant, `install-device-bridge.sh`, `MANIFEST`, `tests/droplet-host-units.test.sh`. Dashboard: the Pair / Not now card on the Network page and the "paired but not saved" retry state.
*Accept (epic's):* on the lab fabric, `sysupgrade -n` the router, wait for the AUTH card, click Pair: within 60 s the Network tab is live, `docker/secrets/openwrt_password` holds the new 32-hex value, one `CommandAuditLog` row exists without the password, and no one used SSH. With the bridge stopped, Pair still brings the tab live and shows the retry card; starting the bridge and clicking Retry persists it. With a second LAN host claiming first (a `curl` to `/ubus` inside the window), the box shows "paired to another device" with that fingerprint, `/health` reports `ROUTER_PAIRED_ELSEWHERE` and not `ROUTER_AUTH`, one audit row names the foreign fingerprint, and a button press followed by Pair recovers. `verify.sh` (WARP-3835) passes afterwards.

**Slice C — AP and switch reuse**
Ship slice A's files in `ap/files` and `switch/files` (switch: `rc.button` only if the GS1900 exposes one; otherwise first-boot window only). Box side: AP flow in the AP onboarding path, switch flow in `services/switch`, `target` in the bridge request, the two other secret files in `droplet-pair-apply.sh`.
*Accept:* reflash the AP and the switch; each shows its own Pair card; after Pair each secret file holds a 32-hex value and the device's dashboard panel is live.

**Docs, with slice B:** edge-router `docs/OPERATIONS.md` § "Connecting the dashboard" describes the dashboard path first and the manual copy as fallback; `.env.example` and `ADR-033` §5 point here.

## 8. Decided (Romain, 2026-10-05, on PR #2705)

These were the ADR's three open questions; the answers are folded into §2, §3, §5 and §7 above.

1. **Re-pair: button only.** While paired, `claim` is refused regardless of fingerprint. Re-pairing needs a short press of the reset button or `sysupgrade -n`. The fingerprint is kept for audit and status only; a TPM proof-of-possession re-claim is possible future work, not a commitment.
2. **Window:** opens at router first boot and closes on the first successful claim or after **24 h**, whichever comes first (the box's first boot can take up to 45 min after the router is up, so 30 min was too short). A button press re-opens it for **30 min**. Both are `droplet-edge.conf` knobs with those defaults (`PAIR_FIRSTBOOT_WINDOW_SECONDS`, `PAIR_BUTTON_WINDOW_SECONDS`).
3. **Who can pair: owner and admins.** Writes still ask for confirmation.

Added at the same time: the "first claim wins" consequence — a router paired to a fingerprint that is not this box's is a distinct, visible state (`ROUTER_PAIRED_ELSEWHERE`), with dashboard copy and an audit row (§2.2 step 1, §5, slice B acceptance).
