---
# YAML front-matter. Machine-readable registry of FIPS allowlist entries.
# `scripts/test-fips.sh` parses this block and accepts an inline
# `fips:allowed: <id>` comment ONLY if `<id>` appears here.
#
# Schema for each entry:
#   id:          stable kebab-case identifier; referenced from source
#   algorithm:   the FIPS-forbidden primitive being used
#   protocol:    free-form citation of the RFC / spec that mandates the use
#   files:       list of source paths that contain the allowed call site
#   rationale:   one-line summary
#   review:      cadence (annual, quarterly, ad-hoc)
#   owner:       team/contact responsible for re-review
#   remove_by:   ticket id when this exception can be retired (null if perpetual)
exceptions:
  - id: rtsp-digest-rfc2617
    algorithm: md5
    protocol: RFC 2617 (HTTP Digest Authentication, original Digest spec — `auth` and `auth-int` qop)
    files:
      - services/camera-discovery/rtsp_prober.py
    rationale: >-
      RTSP DESCRIBE handshake with cameras uses HTTP Digest auth (RFC 2617
      with MD5 as the only mandated digest in the legacy form). Every IP
      camera we support — Hikvision, Hanwha, Axis, Reolink, generic ONVIF
      Profile S — accepts only the MD5 form on the RTSP port. Replacing MD5
      requires the camera vendors to publish RFC 7616-conformant firmware
      (SHA-256 digest support), which none has done as of 2026-05-10.
    review: annual
    owner: droplet-onboard-services / camera-discovery
    remove_by: null

  - id: wireguard-x25519
    algorithm: X25519 (Curve25519 ECDH)
    protocol: RFC 7748 (Elliptic Curves for Security) — WireGuard mandates X25519
    files:
      - services/routing/droplet_openwrt_sdk.py
      - services/routing/mock_router.py
    rationale: >-
      WireGuard's wire protocol mandates X25519 for handshake key agreement
      (and ChaCha20-Poly1305 for session encryption). Both are NIST-approved
      as of FIPS 186-5 / SP 800-186 but are not yet activated in the OpenSSL
      3.0 FIPS provider build that ships with Debian Bookworm. Tunnel scope
      is the WAN edge only — not intra-service traffic — so the practical
      exposure is bounded by the operator's WireGuard peer key management,
      which itself sits on top of TPM-sealed material (WARP-230).
    review: annual
    owner: droplet-onboard-services / routing
    remove_by: null

  - id: fips-selftest-negative-probe
    algorithm: md5
    protocol: internal — FIPS provider enforcement self-test
    files:
      - packages/fips-selftest/src/index.ts
      - services/_shared/fips_selftest.py
    rationale: >-
      The FIPS boot self-test deliberately attempts an MD5 digest and
      asserts the call raises a FIPS-disabled error. If MD5 succeeds the
      helper fails closed (FIPS provider loaded but not enforcing). This
      is the only call site in the codebase that's *supposed* to invoke
      the forbidden algorithm; everywhere else is an actual cryptographic
      use. The two self-test files are also added to the lint scan
      exclusion list as a belt-and-braces — this allowlist entry exists
      so the rationale is part of the auditor-facing registry.
    review: annual
    owner: droplet-onboard-services / fips-selftest
    remove_by: null
---

# FIPS 140-3 — Exceptions Registry

This file is the **single source of truth** for protocol-mandated uses of non-FIPS-approved cryptographic primitives in the Droplet codebase. Every entry has:

1. A stable `id` referenced from the source via a `fips:allowed: <id>` comment within ±2 lines of the call site.
2. The protocol or RFC that mandates the non-FIPS use.
3. The list of source files where the call appears.
4. A rationale.
5. A review cadence.

The static lint (`scripts/test-fips.sh`) parses the YAML front-matter at the top of this file and fails CI on any `fips:allowed: <id>` comment whose `<id>` is not registered here. Dead allowlists fail the build.

---

## Entries

### `rtsp-digest-rfc2617`

**Algorithm:** MD5
**Protocol:** RFC 2617 — HTTP Digest Authentication (legacy form)
**Status:** active, perpetual (no `remove_by`)
**Review:** annual (next review: 2027-05-10)
**Owner:** droplet-onboard-services / camera-discovery

RTSP cameras require legacy RFC 2617 Digest auth on the RTSP control connection (port 554). The handshake is:

```
client → camera : DESCRIBE rtsp://camera/...
camera → client : 401 Unauthorized, WWW-Authenticate: Digest realm="...", nonce="..."
client → camera : DESCRIBE ... Authorization: Digest username="...", response=md5(md5(user:realm:pw):nonce:md5(method:uri))
```

The MD5 nesting is mandated by the spec; the camera firmware computes the expected response with MD5 and compares. The only realistic mitigation is RFC 7616 (SHA-256 digest), which exactly zero of the cameras we support implement on the RTSP port as of 2026-05-10.

**Risk acceptance:** the digest is only used to authenticate the RTSP control session to the camera. The session encryption is irrelevant to FIPS scope — RTSP control is plaintext over TCP; the camera's video feed is encrypted at the network layer by the IP-camera VLAN isolation (camera subnet `192.168.100.0/24`, no egress).

**Reviewed by:** TBD (annual). **Retire when:** a future camera-discovery refactor replaces RTSP DESCRIBE with ONVIF GetStreamUri (which can use HTTP/HTTPS basic auth instead, and on TLS).

---

### `wireguard-x25519`

**Algorithm:** X25519 (Curve25519 ECDH)
**Protocol:** RFC 7748 / RFC 8439 (ChaCha20-Poly1305) — WireGuard
**Status:** active, perpetual (no `remove_by`)
**Review:** annual (next review: 2027-05-10)
**Owner:** droplet-onboard-services / routing

The routing service generates WireGuard keypairs for VPN configuration. WireGuard's wire protocol mandates X25519 for the Noise IK handshake; replacing it would require running a different VPN protocol (IPsec, OpenVPN) — out of scope for the on-device router.

NIST published FIPS 186-5 in 2023 approving Curve25519 (X25519/Ed25519) for federal use. The OpenSSL 3.0 FIPS provider build that ships with Debian Bookworm does not yet activate it. We expect this exception to be retire-able when we rebase onto an OpenSSL 3.1+ FIPS provider build that includes Curve25519 activation; that depends on the upstream Debian package, which we don't control.

**Risk acceptance:** WireGuard is only used at the WAN edge for operator remote-administration tunnels. Intra-cluster traffic uses mTLS with FIPS-approved cipher suites (WARP-236). No PHI/PII transits over WireGuard.

---

### `fips-selftest-negative-probe`

**Algorithm:** MD5
**Protocol:** internal — proof that the FIPS provider is enforcing
**Status:** active, perpetual (no `remove_by`)
**Review:** annual (next review: 2027-05-10)
**Owner:** droplet-onboard-services / fips-selftest

The boot self-test helpers (`packages/fips-selftest/`, `services/_shared/fips_selftest.py`) deliberately call MD5 at startup and assert the call raises a FIPS-disabled error. If MD5 succeeds the helper fails closed — the provider is loaded but not actually enforcing.

These files are also added to the lint scan's exclusion list (their entire purpose is to negative-probe forbidden primitives), but this registry entry exists so an auditor reading `fips-exceptions.md` cold has the rationale documented in the same place as everything else.

---

## Schema reference

The YAML front-matter is parsed by `scripts/test-fips.sh`. Required fields per entry:

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | Stable kebab-case. Referenced from source as `fips:allowed: <id>`. |
| `algorithm` | string | yes | The FIPS-forbidden primitive in use. |
| `protocol` | string | yes | Free-form citation of the spec / RFC mandating it. |
| `files` | list[string] | yes | Source paths where the call site appears. |
| `rationale` | string | yes | One paragraph of plain-English justification. |
| `review` | enum: annual \| quarterly \| ad-hoc | yes | Cadence for owner-review. |
| `owner` | string | yes | Team / contact responsible for re-review. |
| `remove_by` | ticket id or `null` | yes | If a retirement plan exists, the ticket that retires it. `null` = perpetual. |

### Adding a new exception

1. Open a PR with the source change.
2. Add an entry to the YAML front-matter at the top of this file.
3. Append a section to the body of this file with the same `id`.
4. Verify `scripts/test-fips.sh` passes locally.
5. Code review must include sign-off on the rationale + risk acceptance.

### Retiring an exception

1. Set `remove_by:` to the retirement ticket id.
2. When the ticket merges, delete the YAML entry, the body section, and the `fips:allowed: <id>` comment in source. The lint will then catch any leftover references.

---

*Living document. Update protocol: see "Adding a new exception" above. Last updated 2026-05-10 (WARP-229 initial publication).*
