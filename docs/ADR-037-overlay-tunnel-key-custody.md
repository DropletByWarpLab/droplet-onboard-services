# ADR-037: Overlay tunnel key custody — where a client's WireGuard private key is born and lives

- **Status:** Accepted (2026-08-05)
- **Epic:** [WARP-1382](https://warp-lab.atlassian.net/browse/WARP-1382) · this doc: [WARP-1596](https://warp-lab.atlassian.net/browse/WARP-1596)
- **Builds on:** ADR-031 (own WireGuard overlay), ADR-023 (per-device public-CA TLS, split-horizon), [WARP-1757](https://warp-lab.atlassian.net/browse/WARP-1757) (profile issuance), WARP-894 (DPAPI secure store on Windows)
- **Forces a decision on:** [WARP-1591](https://warp-lab.atlassian.net/browse/WARP-1591) (iOS discards its enrolled key), [WARP-359](https://warp-lab.atlassian.net/browse/WARP-359) / [WARP-1388](https://warp-lab.atlassian.net/browse/WARP-1388) (Windows tunnel client)

## Context

The overlay's QR enrollment flow has each client generate its **own** WireGuard
keypair and submit only the public half. The box never sees a client private
key — that is the invariant that makes the tunnel genuinely end-to-end, and it
is why [WARP-1757](https://warp-lab.atlassian.net/browse/WARP-1757) issues a
*profile* rather than a rendered `.conf`: rendering a conf server-side would
imply a private key we must never hold.

That invariant is settled. What was never decided is the other end: **on the
client, where is that private key born, and what is allowed to read it?** Three
platforms answered differently, and two of the three answers are wrong:

- **Android** generates in-app and hands the key to `GoBackend`, which runs
  in-process. Coherent.
- **iOS** generates the keypair at enrollment and *discards the private half*
  (`OverlayEnrollStore.swift:101`), on the reasonable-sounding principle that
  enrollment is not connection. But the box persists the submitted public key
  and, on approval, mints a real overlay device against a cap of 20. So every
  iOS enrollment permanently consumes one of 20 slots with a peer whose private
  key does not exist anywhere in the world. A household that enrolled twenty
  times is wedged until someone prunes by hand
  ([WARP-1591](https://warp-lab.atlassian.net/browse/WARP-1591)).
- **Windows** hard-gates key generation entirely (`OverlayDeviceIdentity::provision()`
  returns `Err(Gated)`). The recorded reason — "there is no non-plaintext sink
  for the WG / ECDSA private keys" — is factually wrong; `secure_store.rs` has
  been the DPAPI sink since WARP-894. The gate is still the right call, but for
  a different and sharper reason, and that reason is the whole subject of this
  ADR.

The sharp constraint on Windows: a tunnel needs a privileged component (a TUN
adapter and route table writes are not user-mode operations), and **DPAPI
user-scope ciphertext is not readable by a SYSTEM-level service.** Storing it
machine-scope instead, or in any file the user-mode app can write, walks
straight into the standing hard rule that *no droplet-writable file may feed a
privileged unit* — that pattern is a local privilege-escalation vector. So on
Windows the naive shape ("app generates key, app stores it, service reads it")
is not merely inelegant; it is the thing we have already banned.

## Decision

**The WireGuard private key is born inside whatever component owns the tunnel,
and never leaves it. The user-mode app never sees the private half.**

Concretely, per platform:

| Platform | Tunnel owner | Key born in | Storage | App's access |
|---|---|---|---|---|
| **Windows** | `droplet-vpnd`, a Windows service | the service | service-scope secret, written and read only by the service account | public key only, over IPC |
| **iOS** | `NEPacketTunnelProvider` extension | the extension | Keychain, `WhenUnlockedThisDeviceOnly`, shared via App Group with the extension as sole writer | public key only |
| **Android** | `GoBackend`, in-process | the app process | Keystore-backed credential store | holds both — same trust domain |

Android is listed for completeness: there is no privilege boundary to cross, so
"born in the tunnel owner" and "born in the app" are the same place. The rule is
not "hide the key from the app" for its own sake; it is "never move a private
key across a privilege boundary."

### Consequences for enrollment

This forces the resolution of [WARP-1591](https://warp-lab.atlassian.net/browse/WARP-1591),
and it picks **option 2** from that ticket: **do not register a WireGuard public
key until the component that owns the tunnel exists and has generated one.**

Enrollment stages *identity* — the ECDSA-P256 sign key that proves possession of
the pending enrollment. The WG public key is submitted when the tunnel owner has
minted it. This preserves the "enrollment ≠ connection" principle iOS was
reaching for, while removing the failure it actually caused: no enrollment can
ever burn a capped overlay slot with a peer nobody can connect as.

Option 1 (persist the key at enrollment) is rejected: it puts a long-lived
tunnel private key on the device before any tunnel exists to use it, and on
Windows it cannot be done at all without crossing the privilege boundary this
ADR exists to forbid.

### The Windows shape, specifically

Split-privilege, as WARP-359 always described, and as Tailscale and WireGuard's
own Windows client both do it:

- **`droplet-vpnd`** — a Windows service. Contains the userspace WireGuard
  implementation (`boringtun`) and the TUN adapter (`wintun`). Owns the tunnel,
  the private key, and the route table writes. Installed by the MSI with a
  one-time admin prompt; after that, connect and disconnect are silent.
- **The Tauri shell** — user-mode UI. Talks to the service over a named pipe,
  loopback-only, token-authenticated. It can ask for `connect`, `disconnect`,
  `status`; it receives the public key to submit during enrollment. It cannot
  read the private key because the private key is never marshalled across the
  pipe.
- The pipe's ACL must admit only the installing user, and the token must not
  live in a file the service reads — the same LPE rule applies to the IPC
  credential as to the tunnel key.

macOS, when it lands, is the same shape with a `launchd` LaunchDaemon and
`utun`.

### Rogue-QR binding (the other half of WARP-1596)

Independently of custody: `parse_overlay_enroll_link` accepts **any** https
host, and `enroll_by_token` never consults the paired base URL — unlike
`get_home_peer_config`, which does. Once real keys are minted, scanning a
hostile QR would enroll the desktop into an attacker's overlay and disclose the
WG public key, the ECDSA identity SPKI, and `COMPUTERNAME` to an
attacker-controlled host, with no consent step anywhere in the Rust layer. The
Android review found the same missing allowlist independently.

**Therefore:** a client MUST bind `link.server` to the box it is already paired
with, or — when there is no pairing yet — show an explicit consent step naming
the destination host, plus a suffix check against the known Droplet domain.
This is a class fix across all three clients, not three separate nits.

## Consequences

**Positive**

- The private key never crosses a privilege boundary on any platform, so the
  droplet-writable-file-feeds-privileged-unit LPE pattern cannot appear here.
- No enrollment can burn a capped overlay slot with an unusable peer; the
  20-device cap starts meaning what it says.
- "Enrollment ≠ connection" survives, and is now enforced by the shape of the
  flow rather than by a comment.
- The desktop key custody question that blocked WARP-359 has an answer, so the
  provisioning code can be written.

**Negative / owned**

- Enrollment becomes two-phase on the clients that defer their WG key: identity
  first, WG public key when the tunnel owner exists. That is a wire change on
  `POST /vpn/overlay/devices/by-token` (WG key becomes optional) plus a new
  authenticated call to attach it. It has to land coordinated across box, iOS
  and Windows.
- Windows gains a service to install, sign, upgrade and uninstall — real surface
  area, and the MSI now needs an admin prompt it did not need before.
- Existing iOS enrollments that already burned slots need a one-time prune.
  There are no customer boxes in this state; the lab box may need it.

**Not decided here**

- The IPC wire format and the service's upgrade/rollback story — WARP-359.
- Whether the desktop app becomes the *primary* laptop path (a positioning
  question flagged on WARP-359, for Romain).
- Relay fallback for boxes with no dial-able candidate —
  [WARP-1390](https://warp-lab.atlassian.net/browse/WARP-1390).
