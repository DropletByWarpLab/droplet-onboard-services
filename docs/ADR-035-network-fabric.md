# ADR-035: The network fabric — one identity, one enrollment, one topology graph, one intent

**Status:** Proposed (pending review — human gate)
**Date:** 2026-08-04
**Deciders:** Stefan (founder directive 2026-08-04) + Engineering to execute
**Source:** Founder directive, verbatim: *"i dont want this built the easy way i want the networking to be seamless and all interconnected, this ap, router and switch all needs to be integrated with droplet and for the devices to natively recognize each other"* and *"the AP should fall into the extender part of the devices tab and be controllable, not just another device on the network it should be a part of the network."* Successor to ADR-033 (edge-router shape): closes its open items 7 and 8 and adds the layer no ADR owns — device-to-device awareness. Builds on ADR-005 (AP onboarding), ADR-018 (network unification, as amended), ADR-023 (public-CA device certs — explicitly **not** reused here, see §4), ADR-024 (multi-backend AP onboarding), FOUNDATION.md (Vault ‖ WAN-Edge two-subsystem split).

Grounded in a four-angle research pass executed live against the lab fabric on 2026-08-04 (current control surface, identity/trust, topology, convergence). Everything cited as "verified live" below was probed on the running devices, not inferred from code.

## Context — what is actually true today

The fabric is ~70% built and the missing 30% was blockers, not architecture:

- **Discovery never worked, and the reason was one decode call.** `umdns browse` serialises TXT records as *repeated* `"txt"` JSON keys (legal blobmsg, hostile JSON); Python's default decoder keeps only the last, destroying the `mac=` record before any parser ran. The `ApDevice` table had zero rows against a healthy announcing AP. Fixed and deployed as **WARP-1720** (2026-08-04); the lab AP entered the ADR-005 state machine — `AWAITING_APPROVAL` — for the first time on real hardware. Every conclusion below post-dates that fix.
- **The AP credential had a 100% manual-miss rate.** `docker/secrets/ap_openwrt_password` was 0 bytes on the live box; the router and switch credentials were enrolled by hand and work. The transport is sound; the *enrollment step* is the weak link, exactly as ADR-033 §5 predicted.
- **Approval was unsafe until the gate landed.** `_router_has_ap_radios` (renamed `_router_side_staging_allowed` by the fix) failed open on the real Pi (`network.wireless status` returns a non-empty envelope with zero interfaces), so approving the AP would have staged a router-side `wifi-iface` and put an on-box AP on the air — violating the codified founder rule. **WARP-1721** landed 2026-08-04 (#1407, merge `ce5667bc`): the gate fails closed on the edge-router shape and the administrative approval freeze is lifted.
- **The control plane is plaintext.** All three devices speak ubus over HTTP :80; nothing listens on 443 (uhttpd's https listener is configured but silently dropped for want of a cert package). The per-unit `droplet-ai` password crosses the LAN in clear on every login — and the AP bridges Wi-Fi clients onto that same L2 (its own overlay comment says a management VLAN is the only real fix).
- **Nothing sees the topology.** The switch's FDB already maps every port correctly (verified live: lan1=Pi uplink, lan2=AP drawing 6 W PoE, lan6=laptop, lan8=box) but no ubus object exposes it and the ACL grants no `file exec`. LLDP runs on zero devices (installed-but-dead on the AP only). The Pi's own FDB collapses everything to one port. There is no Switch model, no port entity, no edge table anywhere in Prisma.
- **Identity is genuinely hard on this hardware.** The AP presents four MACs; the 2.4 GHz radio reports a *different* MAC from hostapd (`80:ea:0b:39:ae:23`, = eth0) than from the kernel netdev (`00:03:7f:12:a4:a4`, the raw PHY address, plausibly fleet-constant); `/etc/board.json`'s macaddr fields are corrupted with kernel-cmdline text (a `_aladdin`-unlock side effect); dnsmasq held two leases for the AP's one MAC under two DUIDs; the serial is empty (MRD erased). Anything keyed on BSSID, client-ID, IP, hostname, or serial mis-identifies this device today.
- **Config has no intent layer.** Every setting is a synchronous RPC to one device; an offline device at write time loses the write; on-device drift silently becomes truth on the next read; "the Wi-Fi name" has two live write paths (router uci vs AP-direct) and the MCP chat tool aims at the wrong one (a radio that is not on the air). The switch write path has no rollback arm at all while router and AP both use `safe_apply`.
- **Device-side self-healing exists and is invisible.** The AP's management deadman and the Pi's dhcp-guard both work (both battle-tested this week) and neither is represented anywhere in the control plane — a device that self-healed looks identical to one that never had a problem.

What is *not* re-litigated here: the ADR-018 §5 / ADR-024 tension (reconciled by ADR-033 §6 with an inline amendment), the choice of dawn for steering (ADR-005), and the two-subsystem foundation split.

## Decision

### 1. Fabric charter and the one principle

The **fabric** is the set of enrolled network devices (edge router, switch, APs — and the box's own network-facing services) treated as one system with one identity model, one enrollment path, one topology graph, and one intent store. Two principles, one inherited and one new:

- **Observed state:** *the device owns the truth, the box reads it live* (ADR-005 §"AP owns its radios", now fabric-wide). No cached mirrors of device state for display.
- **Intended state (new):** for the config domains the fabric owns (§7), intent lives in **one box-side record**, devices converge to it, and drift is repaired *visibly*, never silently.

These are not in tension: observation answers "what is", intent answers "what should be", and the dashboard renders both plus the delta.

### 2. Identity: anchor MAC + identity ledger

- **Primary identity anchor** for every fabric node is its **anchor MAC**: the wired management interface's MAC (eth0/br-lan). Verified live as the one value every observer agrees on (mDNS TXT, DHCP, both FDBs, ARP, and the 2.4 GHz beacon).
- Three new Prisma entities, following the ApOnboardBackend explicit-discriminator discipline:
  - `NetworkNode` — the union of router | switch | ap | box | client, keyed by node id (not MAC).
  - `NodeIdentity` — one row per observed identifier (MAC/BSSID/PHY/DUID), with `kind` and `source` enums, pointing at a node. Every MAC the device presents becomes a ledger row, not a guess.
  - `TopologyEdge` — from-node, to-node, `kind` (uplink | switchport | wireless-assoc | poe-feed), port, `observedAt`, `source`, `confidence`.
  - `ApDevice` and `NetworkDevice` are **not** replaced; they gain a `nodeId` reference. ApDevice stays the AP lifecycle machine; NetworkDevice stays client supervision.
- **Identity resolution precedence** (in `topology-identity.service.ts`, a peer of the ap-discovery-multiplexer — one reconcile pass, one canonical write): (a) **self-report** over the authenticated ubus session wins (`iwinfo devices`, `hostapd.* get_status.bssid`, `rrm_nr_get_own`, `/sys/class/net/*/address`); (b) **locally-administered derivation** (anchor with LA bit flipped ⇒ same node); (c) **co-observation** (a BSSID dawn reports `local=true` on an authenticated node); (d) everything else stays an **orphan**, rendered as unknown — never silently merged.
- **Never key on:** DHCP client-ID, IP, hostname, serial, or PHY MAC. Each one was observed failing on the lab unit this week.
- **Fix identity at the source** (droplet-edge-router, AP image): derive every `macaddr_base` deterministically from the U-Boot `ethaddr` (2.4 GHz = eth0+2, 5 GHz = eth0+3) so no radio ever inherits the untrusted PHY address; bypass the corrupted `board.json` extraction; pin the DHCP client-ID to the eth0 MAC so the double-lease cannot recur.

### 3. Enrollment: one handshake replaces three manual hops (closes ADR-033 item 8)

- The enrollment service lives **in the orchestrator** (it owns the DB, the approval gate, the escrow, and the internal CA). The QR tunnel-enroll substrate (WARP-1474) is lifted **semantically verbatim**: hash-only token storage, short TTL, single-use state enums with an atomic approver claim, domain-prefixed PoP, owner approval in the dashboard, per-box device cap.
- **Bootstrap for already-flashed devices** (all three current units): the baked **recovery SSH key** — a build requirement since caf50b9, asserted into the rootfs, preserved by keep.d — is used *once* per device to read `/etc/droplet/droplet-ai-password` and register the member, followed by **immediate credential rotation** so the recovery key returns to break-glass status. This makes re-enrollment after a reflash automatic on next discovery instead of a stranded credential.
- **Enrollment for future images:** the device advertises unenrolled state in its existing mDNS TXT (role, anchor mac, plus a boot-scoped nonce); the dashboard shows it as an unenrolled fabric device; the operator proves **physical presence from the device side** (bounded button-press window — the AP's reset path exists and stays enabled per WARP-1709); the box mints and escrows the credential.
- **Escrow is per-device rows, not three singleton secrets.** `ap_openwrt_password`-style one-per-role files are retired; a second AP becomes another row, which is the structural difference between "an AP is a device on the network" and "an AP is part of the network."
- Device-side: the uci-defaults credential mint becomes **conditional on an existing enrolled credential** (today it re-mints on every reflash — the routine event that strands the box's copy), and `/etc/droplet` joins the sysupgrade keep list on **all** devices (the AP has this; the Pi verifiably does not).
- `setup.sh` learns the `edge-router` shape (ADR-033 item 7) as a **hard prerequisite** — devices cannot be auto-enrolled into a shape the installer does not know exists. The live box still runs `single-box` profiles with hand-edited env.

### 4. Transport: pinned TLS now, internal-CA client certs later, management VLAN as the real boundary

- **Phase 0 (stop the bleeding, config-only):** give uhttpd a cert (px5g or equivalent per image), move the three services to `https:443`, and pin each device's self-signed **SPKI fingerprint** box-side, recorded at enrollment. One-line SDK change (`UbusClient` scheme); removes the cleartext-credential-on-the-LAN finding without waiting for anything.
- **Phase 2 (end state):** per-device **client certificates issued by the box's own internal CA** (`scripts/lib/internal-ca.sh`, WARP-236 — EC P-256, 90-day leaves, rotation already built), terminated by a TLS proxy in front of ubus on each device — because uhttpd on these builds has **no client-cert verification at all** (verified live: only `-C/-K/-P`). Revocation = stop renewing + terminator CRL; escrow = the box holds what it minted; the signing root stays pluggable for the TPM RealBackend when it lands.
- **ADR-023 certs are explicitly the wrong tool here** — they are internet-dependent, HQ-mediated, browser-facing serving certs. Fabric identity is issued by the box's own CA, offline. Conflating the two PKIs is a category error this ADR exists partly to prevent.
- **Phase 1 (the real boundary, delivered through §7): the management VLAN** is the real fix for the Wi-Fi-clients-on-the-management-L2 exposure (WARP-1709's unfixable-at-the-firewall finding). It is deliberately not transport work — it rides the same VLAN capability §7 makes fabric-owned; until it lands, phase 0 is mitigation, not remedy.

### 5. Discovery: symmetric, consumed, and demoted to second place behind enrollment

- **Contract:** per-role service types stay (`_droplet-ap._tcp`, `_droplet-switch._tcp` — both shipped; add **`_droplet-router._tcp`** on the Pi, which today advertises nothing). The `role=` TXT key stays as metadata. ADR-005's stale `role=extender` / Pi-device-tree-model language is retired.
- **One consumer:** a fabric discovery source behind the existing `DiscoverySource` seam browses all three types into the node registry. The switch's rich advertisement (role/mac/model/version/poe_ports/poe_budget — live, currently consumed by nothing) stops advertising into a void.
- **Addressing:** discovered-first, static-env as *fallback* — the reverse of today, where every device is reached by hardcoded env and the routing default is still the stale `192.168.50.1`. At enrollment the fabric mints a **DHCP reservation** on the router for the member's anchor MAC, so addresses become properties of the model rather than races (the AP has already held three).
- Discovery is **never trust**: an mDNS answer can direct a probe but can never cause a credential to be sent anywhere a pinned identity does not match (§4 pinning closes the mDNS-spoof credential-disclosure seam).

### 6. Topology: close the port↔device edge, then make recognition mutual

- **The one unblock:** the switch gains a read-only **`bridge.fdb` rpcd ucode plugin** + ACL grant — *not* a `file exec` grant, preserving the switch's tested zero-exec posture. Deliverable remotely (overlay file + rpcd restart over the existing management plane; no reflash). `SwitchDriver` gains an abstract `get_fdb()` — the contract gap WARP-1717's ACL framing missed. This single edge closes four missing graph edges in one move (AP-on-port, box-on-port, wired-client-on-port, PoE-port→named-device).
- **LLDP everywhere, second:** lldpd on Pi + switch package lists, fix the AP's dead daemon, advertise role + anchor MAC in the system description, expose neighbours over ubus. This is peer-*asserted* adjacency — the literal "devices natively recognize each other" — and LLDP-MED gives the PoE relationship a protocol-native second source. Switch package additions ride the next planned reflash; the fabric must not *depend* on LLDP before then (FDB is the load-bearing source).
- **Power dependency is a first-class edge:** `poe-feed` edges join FDB→NodeIdentity. `set_port_poe(off)` against a port feeding an enrolled member becomes a **hard refusal** when combined with any switch network change in the same transaction — that specific combination is the one with no remote recovery.
- **Radio-layer recognition (last):** grant `dawn` + `hostapd.*.rrm_nr_*` in the AP ACL and reconcile every approved AP's `rrm_nr_get_own` into every other AP via `rrm_nr_set`. With a second AP this is 802.11k neighbour awareness — devices recognizing each other on the air, not just in a database.
- **Observation shape: hybrid.** Devices **push** best-effort events for the six edge-changing transitions (link, PoE, assoc, LLDP neighbour, DHCP grant, boot) via the hotplug objects they already emit; the box **polls** an authoritative 60 s topology snapshot per device as the resync and sole post-gap truth. Every edge carries `observedAt + source + confidence`; stale edges dim, never silently vanish; a BOOT event invalidates that device's prior edges; pushed events enqueue *observations* the identity service judges — a device can claim, never write, topology.

### 7. Convergence: one intent, explicit ownership, power-last commits

- **`NetworkIntent`** (key, value, generation, writtenBy) + **`DeviceIntentState`** (nodeId, key, appliedGeneration, lastVerifiedAt, driftDetectedAt). The converger runs on the existing cron-runtime/advisory-lock shape. A write bumps the generation and returns — it no longer requires the device to be online, which deletes the lost-write failure mode outright.
- **Domain ownership, decided:**
  - **Fabric-owned** (intent wins, drift auto-repaired, always visibly): SSID + passphrase (one fact, fanned to every AP; the AP-side applier keeps deriving radio1), band steering (fabric-scoped so a second AP cannot disagree), VLANs (the domain that *proves* the fabric — router, switch and AP must agree on one VID set), DHCP ranges + reservations, onboard-radio-enable (**pinned off** per the founder rule — a fabric fact, not a device default), and the management-plane firewall rules (per-device edits here are the WARP-1709 lockout class).
  - **Fabric-proposes, device-disposes:** channels/htmode — policy from the fabric (auto vs pinned, DFS allowed), final say from the radio's regdb/ACS.
  - **Device-local, exposed and guarded, never converged:** PoE per port (a reconciler re-asserting PoE would fight deliberate maintenance), per-unit credentials/recovery keys, radio calibration and board-derived paths.
- **The duplicate SSID path dies:** `POST /network/wifi/ssid` (router uci) is **deleted on the edge-router shape** and the MCP `set_wifi_ssid` tool repoints at the intent write. Today that tool renames a radio that is not on the air and returns 200.
- **Commit protocol across devices:** per-device `uci apply(rollback)` → probe → confirm stays the transport guard, and the **switch is raised to `safe_apply` parity** (today it has *no* rollback arm — a stranding write is permanent; its ACL already grants everything needed). Above that, a fabric push enters **PENDING_SOAK** and marks CONVERGED only after verified read-back on every participant, auto-re-pushing the previous generation on failure. Ordering is **power-last and power-non-transactional**: every non-power change on every participant confirms first; a de-powered device cannot confirm anything.
- **Self-healing becomes fabric-visible:** the AP deadman's `confirm` verb is granted to the fabric explicitly — a passive dashboard poll must stop silently promoting an unjudged config to known-good (verified failure mode: any poll within the probation window snapshots whatever is running). Deadman rollbacks and dhcp-guard refusals surface as first-class device health states; both already write durable logs and `file read` is already granted everywhere, so this costs zero device-side changes.

### 8. Ratifications and scope honesty

- **ADR-024's dangling sign-off is ratified as Option B:** the UniFi Network controller is customer-supplied, never bundled. The code already says it; no ADR recorded it; this one does.
- **"Seamless" is scoped to post-flash.** The NWA50BE `_aladdin` unlock requires a human at a vendor portal and erases the MRD (serial gone forever, warranty void, dual-image fallback destroyed) — zero-touch flashing of this SKU is impossible upstream of us. The fabric makes everything *after* first boot automatic: credential, address, membership, topology, config. The flash step is a factory/depot operation. (Whether this SKU is shippable at all is a separate sourcing decision, tracked outside this ADR.)
- **What would change this design:** a fleet permanently capped at exactly three factory-flashed devices would make §3 over-engineering (per-device escrow alone would do); uhttpd HTTPS proving unstable on the TIP AP build would collapse phase 0 into the phase-2 terminator work; the PHY MAC `00:03:7f:12:a4:a4` proving fleet-constant (needs a second unit to confirm) upgrades the §2 source-fix from hygiene to shipping blocker.

## Consequences

**Better:** a second AP becomes a row, not a rearchitecture. Reflash stops stranding credentials. The dashboard can draw the rack as it physically is — box on lan8, AP on lan2 drawing 6 W, uplink on lan1 — instead of a list of IPs. Wi-Fi settings survive device offline windows and repair their own drift, visibly. The founder rule (onboard radios never APs) becomes a pinned fabric fact with a converger enforcing it instead of a comment. The credential stops crossing the LAN in clear.

**Harder:** cross-repo coupling deepens (every new device capability = ACL change in droplet-edge-router + consumer in onboard-services + fallback). The intent layer introduces a second source of truth that must *never* leak into display paths (the §1 split is the guard). The enrollment broker makes the recovery key briefly load-bearing — rotation-after-enrollment is not optional. TLS terminators are per-device image work on three different build systems.

**Explicitly deferred:** WireGuard-as-transport (installed on zero devices; presupposes enrollment anyway), bundling any third-party controller, TPM-rooted fabric CA (pluggable slot reserved), and any change requiring a switch reflash before the next planned rack visit.

## Sequencing (each stage remote, independently valuable, revertible)

1. **Fix-first (landed / open):** WARP-1720 discovery decode ✅ deployed; AP credential enrolled + `.env` source-of-truth ✅; WARP-1721 approval gate ✅ merged (`ce5667bc`, fails closed on this shape — freeze lifted); switch `safe_apply` parity; AP identity source-fixes (macaddr_base, board.json, client-ID); Pi keep.d `/etc/droplet`.
2. **Pin identity:** DHCP reservations + `_droplet-router._tcp` + consume the switch advertisement into the node registry.
3. **Topology:** `bridge.fdb` rpcd plugin + `get_fdb()` contract + PoE dependency edges + hard PoE refusal.
4. **Intent for one fact:** NetworkIntent for SSID+passphrase, converger, delete the router-side write path, repoint the MCP tool. Prove offline-write and drift-repush on one fact before generalising.
5. **Enrollment:** orchestrator broker, recovery-key bootstrap + rotation, per-device escrow rows, conditional credential mint, shape detection in `setup.sh`.
6. **Transport:** phase-0 pinned HTTPS; then internal-CA client certs behind terminators; management VLAN rides the VLAN intent domain.
7. **Recognition:** LLDP everywhere (switch additions batched with the next reflash); dawn/rrm ACL grants; cross-AP neighbour reconcile.

## Action items

- [x] WARP-1720 — umdns duplicate-key decode fix (merged `149500ba`, deployed to lab box, AP discovered)
- [x] AP credential enrolled on lab box + `AP_OPENWRT_PASSWORD` in both `.env` files (deploy fix, 2026-08-04)
- [x] WARP-1721 — approval gate fails closed on the edge-router shape (merged `ce5667bc`, #1407; `_router_has_ap_radios` → `_router_side_staging_allowed`; approval freeze lifted)
- [x] WARP-1730 — switch driver `safe_apply` parity + PYNET-005 staged-revert (merged `1003493f`, #1408; verified live on the lab switch against an unused PoE port: apply→probe→confirm, zero staged leftovers)
- [x] WARP-1729 — AP identity fixes: macaddr_base derived from the eth0 anchor, board.json bypassed, DHCP client-ID pinned (merged `14b4c6e`; kernel and hostapd now agree on both radios, one lease)
- [x] WARP-1728 — Pi keep.d `/etc/droplet`, DHCP reservation for the AP, switch domain record, and `_droplet-router._tcp` (merged `c7de8a9`; router advert confirmed visible from the AP)
- [x] WARP-1734 — `bridge.fdb` rpcd ucode plugin + ACL grant (edge-router `b3b0c18`, #15) and `SwitchDriver.get_fdb()` + `port_powers()` + the hard PoE refusal (`15f8d010`, #1411). Supersedes the ACL-only framing of WARP-1717. Verified on the rack: cutting lan2 is refused by name; lan5 still toggles.
- [x] WARP-1731 — `FabricApi.browse_members()` + `GET /fabric/members` (merged `bce6ed6f`, #1409; all three members returned live, router synthesized when its own advert is absent from its own browse)
- [ ] WARP-1732 — FabricMember persistence: orchestrator table + reconciler + read API (in progress)
- [ ] NetworkNode / NodeIdentity / TopologyEdge migration + topology-identity service (ticket needed — WARP-1732 is its first increment)
- [ ] NetworkIntent + converger for `wifi.primary`; delete router-side SSID path on this shape (ticket needed)
- [ ] Enrollment broker (ADR-033 item 8; extends WARP-1474 substrate) + `setup.sh` shape detection (ADR-033 item 7)
- [ ] Phase-0 pinned HTTPS across all three devices (ticket needed)

### Progress note (2026-08-05)

**Stage 1 (fix-first) and stage 2 (pin identity) are complete**, and every item
was verified against the live rack rather than accepted from a test suite. The
fabric now discovers all three devices, addresses them by reservation and
stable name, cannot strand the switch on a bad write, and refuses to cut power
to a device it can see. Stages 3–7 (topology graph persistence, intent
convergence, enrollment, transport, mutual recognition) remain.

Two findings from this work belong in the record because they constrain later
stages:

- **Wi-Fi 7 is not reachable on the NWA50BE** (WARP-1736). `mlo_capable=0` is
  not a tunable we are declining — with it the driver advertises zero EHT
  capability, and enabling MLO panics the kernel. The 1.6 firmware that would
  support it was tested on hardware and does not exist for this board's
  1-Pebble topology. Nothing customer-facing may claim 802.11be for this SKU
  until that is resolved, and it should be decided alongside the `_aladdin`
  sourcing question.
- **A userspace self-heal guard cannot cover a kernel panic.** The AP's
  management deadman runs from `rc.local` and is therefore blind to the entire
  class of failure that firmware and driver changes produce. Any stage that
  touches either must be treated as console-required, or guarded at U-Boot.
