# Threat model — the privileged single-box OpenWrt container (WARP-585)

**Status:** documented boundary + staged (hardware-verify-gated) cap reduction.
**Scope:** the `openwrt` compose service (`docker/docker-compose.yml`), which
runs **only** on the `single-box` deployment shape (`COMPOSE_PROFILES=single-box`).
On `multi-box` the router is a separate bare-metal OpenWrt host and this
container does not exist.
**Companion:** [`../LAUNCH_READINESS_AUDIT.md`](../LAUNCH_READINESS_AUDIT.md)
(ops/sec nice-to-have: "Threat-model + harden the privileged single-box
OpenWrt container").

> **Why this container is the riskiest cell in the compose file.** It is the
> only service that combines `privileged: true` with a **customer-facing UDP
> listener** (WireGuard `:51820/udp`). Every other privileged-ish surface in the
> stack is either scoped (`routing` uses `cap_add: [NET_ADMIN]` only;
> `oled-display` uses `device_cgroup_rules` + `no-new-privileges`) or not
> internet-reachable (`ops-console` mounts `docker.sock` but binds
> `127.0.0.1` behind a bearer token). This container is both maximally
> privileged **and** exposed to an unauthenticated remote protocol.

---

## 1. What the container is and does

On the single-box shape the appliance host owns a Wi-Fi radio. The host script
[`scripts/host/usr-local-sbin/droplet-openwrt-attach`](../../scripts/host/usr-local-sbin/droplet-openwrt-attach)
moves the host PHY into this container's network namespace, then the container
runs a full OpenWrt userland under `procd` (PID 1 = `/sbin/init`):

- **`hostapd`** — the Wi-Fi AP (home SSID + optional guest BSS).
- **`netifd`** — interface/bridge/route management.
- **`fw4` / nftables** — firewall zones, NAT/masquerade, the DNAT that routes
  AP + VPN clients to the dashboard gateway container.
- **`dnsmasq`** — DHCP + DNS for AP clients (192.168.20.0/24).
- **WireGuard (`wg0`)** — the remote-access VPN endpoint, listening on
  `:51820/udp`. Peers are minted by the orchestrator's `vpn.service.ts` via the
  routing service.
- **`uhttpd` + `rpcd` (ubus JSON-RPC)** — the control surface the routing
  service drives.

### Image / package provenance

Built from [`openwrt/singlebox-image/Dockerfile`](../../openwrt/singlebox-image/Dockerfile),
`FROM openwrt/rootfs:x86_64-24.10.2`. The AP/router packages (hostapd, iw, wpad,
umdns, wireguard-tools, kmod-wireguard, uhttpd/rpcd, miniupnpd) are baked into
the image (WARP-826) so a fresh container never depends on a first-boot
`opkg install`. `droplet-openwrt-attach` re-installs-if-missing at runtime as a
safety net.

---

## 2. Trust boundary

```
                         ┌─────────────────────── appliance host (Ubuntu 24.04) ───────────────────────┐
                         │                                                                              │
   WAN / customer LAN    │   host customer-facing iface                                                 │
   ─────────────────►    │   :51820/udp  ──docker-proxy DNAT──►  ┌───────────────────────────────────┐  │
   (WireGuard peers,     │                                       │  openwrt container                │  │
    untrusted internet)  │                                       │  procd / netifd / hostapd /       │  │
                         │                                       │  fw4 / dnsmasq / wg0 / uhttpd      │  │
   Wi-Fi clients ───────►│   moved PHY (in container netns)  ───►│  privileged:true + NET_ADMIN,     │  │
   (AP + guest BSS,      │                                       │  SYS_ADMIN                        │  │
    semi-trusted)        │                                       │                                   │  │
                         │                                       │  eth0 = docker bridge veth        │  │
                         │   127.0.0.1:8181 ──host-only──────────┤  (default compose bridge, DEFAULT │  │
   routing service ─────►│   (ubus JSON-RPC, bearer-gated)       │   network — shared w/ orchestrator│  │
   (network_mode: host,  │                                       │   postgres, redis, gateway, ...)  │  │
    the AI control path) │                                       └───────────────────────────────────┘  │
                         └──────────────────────────────────────────────────────────────────────────────┘
```

### What can reach the container (attack surface, most-to-least hostile)

| Ingress | Source | Trust | Auth |
|---|---|---|---|
| `:51820/udp` WireGuard | The open internet, via the host's customer-facing iface + docker-proxy DNAT | **Untrusted** | Cryptographic (Noise/Curve25519 peer keys). No handshake without a configured peer public key. |
| Wi-Fi association | AP + guest BSS clients (moved PHY in the container netns) | **Semi-trusted** (household + guests) | WPA2-PSK per-box PSK (WARP-819). Guest BSS is client-isolated + LAN-isolated by a default-deny fw4 zone. |
| `127.0.0.1:8181` ubus JSON-RPC | The `routing` service (`network_mode: host`) — the AI-side control path | **Trusted** (on-box) | Host-only bind (never published on the customer iface). rpcd session login (root pw from the `openwrt_password` docker secret) + the `droplet-ai` ACL. The routing service itself is bearer-gated (`ROUTING_SERVICE_TOKEN`, fail-closed). |
| Compose default bridge (typically 172.18.0.0/16 — Compose auto-assigns the subnet, `ipam: {}`) | Any container on the default network | **Trusted-ish** (co-tenant) | None at the network layer — see §4 lateral movement. |

### What the container can touch (blast radius)

- **The host network stack** — `NET_ADMIN` + the moved PHY let it configure
  interfaces, bridges, routes, nftables, and the Wi-Fi radio. This is the
  intended job.
- **All host devices + all capabilities + unconfined seccomp/AppArmor** — via
  `privileged: true`. This is the over-grant (see §3).
- **The compose default network** — `eth0` is a docker bridge veth on the
  default compose bridge (typically 172.18.0.0/16; Compose auto-assigns the
  subnet), the **same network** as `orchestrator:3000`, `postgres:5432`,
  `redis`, the dashboard `gateway`, etc. (The `routing`, `matter-controller`,
  and other `network_mode: host` services are reachable on host localhost, not
  this bridge.) A process that escapes the OpenWrt userland into the container
  root can open TCP to every co-tenant service (see §4).
- **`openwrt-config` + `openwrt-overlay` named volumes** — persistent UCI config
  and the overlay upperdir. Tampering here persists across restarts.

---

## 3. What `privileged: true` actually grants (and why it's used today)

`privileged: true` is **not** "the two caps in `cap_add` plus a bit more." Per
the [Docker runtime-privilege docs](https://docs.docker.com/engine/containers/run/#runtime-privilege-and-linux-capabilities),
it grants a container **nearly the same access to the host as a process running
outside the container**:

1. **All Linux capabilities** — not just `NET_ADMIN` + `SYS_ADMIN`. The
   container also gets `SYS_MODULE` (load/unload host kernel modules),
   `SYS_RAWIO` (raw port/memory I/O), `SYS_PTRACE`, `DAC_READ_SEARCH`,
   `SYS_BOOT`, `MKNOD` for arbitrary devices, and every other capability.
   The two explicit `cap_add` entries are redundant while `privileged` is set.
2. **Access to every host device** — the device cgroup allows-all, and Docker
   populates `/dev`. The container can `open()` any host block/char device
   (disks, TPM, other GPUs).
3. **No seccomp filter** — the default Docker seccomp profile (which blocks
   ~44 dangerous syscalls) is disabled; all syscalls are permitted.
4. **No AppArmor/SELinux confinement** — the `docker-default` AppArmor profile
   is not applied.
5. **Read-write `/proc` and `/sys`, unmasked** — masked/hidden kernel paths are
   exposed writable.

**Why it's currently used:** OpenWrt is a full OS image, not a single daemon.
`procd` (PID 1) performs early-init mount operations and `netifd` does extensive
interface manipulation; the community consensus is that
`openwrt/rootfs` "uses multiple active services… not really suited as a
container" and needs broad privileges to boot cleanly
([openwrt/docker README](https://github.com/openwrt/docker)). The Droplet
compose comment attributes it to "procd does a lot of network interface
manipulation that requires real capabilities." That reasoning justifies
**`NET_ADMIN` (+ likely `SYS_ADMIN` for procd's mounts)** — it does **not**
justify `SYS_MODULE`, `SYS_RAWIO`, all-device access, or the disabled
seccomp/AppArmor profiles. `privileged: true` was almost certainly reached for
as the fast path to "it boots," not because the full grant is required.

Note the tension: `openwrt/docker` issues [#94](https://github.com/openwrt/docker/issues/94)
and [#72](https://github.com/openwrt/docker/issues/72) report that adding
`NET_ADMIN` **on its own** can break `/sbin/init`'s network bring-up in some
configurations. That is exactly why the reduced cap set below is a
**hardware-verify-gated** proposal, not an applied change (§6).

---

## 4. Attack scenarios

### S1 — WireGuard vuln → compromise (kernel path vs userspace path)
`:51820/udp` is the only cryptographically-authenticated remote surface, but it
faces the open internet. The two failure paths have **very different** blast
radii and the cap reduction only helps one of them — keep them separate:

- **S1a — kernel WireGuard path (cap reduction does NOT help).** The datapath
  (`kmod-wireguard`, the Curve25519 handshake, the netlink config surface) runs
  **in the host kernel**, not in the container's userland. A memory-safety bug
  reached there executes with **host-kernel privilege regardless of the
  container's caps, seccomp, or AppArmor** — those confine userspace processes,
  not the kernel a syscall lands in. So this is a **host compromise**, full
  stop, and no amount of container hardening changes that. The real mitigation
  story for S1a is **keeping the host kernel patched** and leaning on
  WireGuard's deliberately small, audited codebase (a few thousand lines, no
  pre-handshake attack surface for unknown peers) — an architectural property,
  not something this ticket's compose changes touch.
- **S1b — userspace surfaces (cap reduction genuinely bites).** The processes
  that parse config and manage the interface — `wg`, `netifd`, `hostapd`,
  `dnsmasq` — run **in the container**. A bug reached there executes with the
  container's privileges. Today that means **all capabilities, all host
  devices, and no seccomp/AppArmor**, so container→host escape is close to
  trivial (`SYS_MODULE` alone — load a malicious kernel module — is game over
  for the host). **Reducing the cap set + restoring the seccomp + AppArmor
  profiles (the latter come back from removing `privileged`, not from
  `no-new-privileges`) turns a userspace RCE from a full host compromise into,
  at worst, a compromised network namespace.** This is the single
  highest-value mitigation in this ticket — and it applies to S1b, not S1a.

### S2 — Lateral movement across the compose network
The container's `eth0` sits on the **default compose bridge** alongside
`orchestrator`, `postgres`, `redis`, and the dashboard `gateway`. None of those
enforce network-layer origin checks — Postgres trusts the network, Redis has
only a password. A foothold inside the OpenWrt container (even without a host
escape) can scan the default bridge subnet (typically 172.18.0.0/16) and hit
`postgres:5432` / `redis:6379` directly. **Mitigation direction (out of scope for this ticket, flagged for
follow-up):** move `openwrt` onto a dedicated `internal: true` compose network
that carries only the host-published ubus path, so it cannot reach the data
tier. Noted in §6/Follow-up.

### S3 — Config-overlay tampering (persistence)
`openwrt-config` (`/etc/config`) and `openwrt-overlay` (`/overlay`) are
persistent named volumes. An attacker who reaches container root can rewrite UCI
firewall zones (e.g. open the guest zone to the LAN, add a DNAT to exfiltrate,
weaken the AP PSK) and the change **survives container restart** — it is not
reset by a compose recreate, only by `factory-reset.sh`. `no-new-privileges` +
a reduced cap set shrink the odds of reaching container root in the first place;
overlay integrity itself is a separate hardening axis (not in scope here).

### S4 — ubus/routing path abuse (in-scope for defense-in-depth, already mitigated)
The `127.0.0.1:8181` ubus surface is **not** internet-facing and is gated by the
`droplet-ai` rpcd ACL + the routing service's fail-closed bearer token. This is
the Foundation's "the AI sees/manages the network but is never exposed to it"
invariant realized: the AI reaches the router only through the bearer-gated,
host-only routing service, never over the customer network. No change proposed;
documented here so the boundary is explicit.

---

## 5. Alignment with the Foundation (WAN/Edge vs Vault)

The Droplet founding thesis is **two physically separate subsystems**: a trusted
**Vault** (the LAN, the data, the local AI) and an untrusted **WAN/Edge** little
computer, sharing *no CPU, drive, container host, or network*. Everything
crossing the boundary is screened both ways; the VPN runs on a separate network.

The **single-box shape collapses that separation into one host.** The OpenWrt
container is the WAN/Edge subsystem (it terminates WireGuard from the internet
and fronts the customer LAN), but it runs on the **same container host** as the
Vault-side services (orchestrator, Postgres, the AI). The physical air-gap the
Foundation calls for is, on this shape, **only a container boundary** — which is
exactly why that boundary must be as strong as we can make it. `privileged: true`
+ customer-facing UDP **weakens the one boundary that stands in for the two-box
separation** on the shipping single-box shape. Hardening it (dropping to a scoped
cap set, restoring seccomp/AppArmor, and — as a follow-up — isolating it onto its
own compose network) is the software approximation of the hardware air-gap. The
multi-box shape and the Foundation's dedicated-hardware SKUs (Full Rack + Mini
Rack) restore the physical separation; the single-box shape leans entirely on
this container cell, so it carries the most risk and deserves the most
confinement.

---

## 6. Hardening: applied now vs staged for hardware verification

### Applied in this ticket (verifiable-without-hardware / provably inert)
- **This threat-model document** and a cross-reference from
  `LAUNCH_READINESS_AUDIT.md`.
- **Inline documentation** in the `openwrt` compose block: an explicit note that
  `privileged: true` is the over-grant, that the two `cap_add` entries are
  redundant while it is set, and a pointer to this doc + the staged block.
- **A commented-out, ready-to-test hardened service definition** staged directly
  in the compose file (below), gated behind a "hardware-verify before enabling"
  note. It changes nothing until a human uncomments it on a real single-box.

### NOT applied — requires hardware verification (the "no behavior-risking compose change ships unverified" rule)
The `openwrt` service is `single-box`-profile-gated and **cannot run on macOS or
in CI** (Linux-only; needs a real Wi-Fi PHY, the host netns move, and the host
kernel WireGuard module). We therefore cannot confirm at build/test time that a
reduced cap set keeps procd/netifd/hostapd/WireGuard functional. The staged
block below is the **precise, ready-to-test end state**; a follow-up ticket
(§Follow-up) verifies it on a real box.

#### Why `no-new-privileges` is staged, not applied
`security_opt: no-new-privileges:true` is a strong candidate — `oled-display`
and `ops-console` already use it. But per the
[kernel `no_new_privs` semantics](https://docs.kernel.org/userspace-api/no_new_privs.html)
it blocks **setuid/setgid and file-capability elevation across `execve()`**, and
this container's boot path exercises exactly that: `droplet-openwrt-attach` runs
`passwd root` (setuid-root), and `dnsmasq` drops to an unprivileged user after
binding. Because procd (PID 1) already runs as **root**, a root→setuid-root exec
is a no-op elevation and *should* be unaffected — but "should" over an
unverifiable-here boot path is not "authoritative evidence of compatibility,"
which is the bar this ticket set for a live change. So it goes in the staged
block, to be confirmed on hardware alongside the cap reduction.

#### Staged hardened definition (the exact change to test)
The following is committed as a **commented block** in `docker-compose.yml`
immediately after the live `openwrt` service. Rationale per line:

```yaml
    # cap_drop ALL + explicit add-back. Removes SYS_MODULE, SYS_RAWIO,
    # SYS_PTRACE, DAC_READ_SEARCH, MKNOD-any-device, etc. that privileged grants.
    cap_drop:
      - ALL
    cap_add:
      - NET_ADMIN          # netifd, hostapd (nl80211), fw4/nftables, wg config, ip link/addr/route
      - NET_RAW            # hostapd + dnsmasq raw sockets (DHCP)
      - NET_BIND_SERVICE   # uhttpd :80, dnsmasq :53/:67 under cap_drop ALL
      - SYS_ADMIN          # procd early-init mount ops (tmpfs, /proc remount). CONFIRM droppable on hardware.
      - CHOWN              # passwd root / procd service files
      - DAC_OVERRIDE       # procd + uci writes under /etc, /overlay
      - FOWNER             # ditto
      - SETUID             # passwd (setuid-root), dnsmasq drop-to-user
      - SETGID             # dnsmasq/hostapd group drop
      - KILL               # procd service supervision (SIGTERM/SIGHUP)
    # no-new-privileges ONLY blocks privilege elevation across execve (setuid /
    # setgid / file-caps). The seccomp + docker-default AppArmor profiles come
    # back from REMOVING `privileged: true`, not from this opt.
    security_opt:
      - no-new-privileges:true
    # ip_forward is namespaced; set it explicitly instead of relying on the
    # privileged container's rw /proc write from droplet-openwrt-attach.
    sysctls:
      - net.ipv4.ip_forward=1
      - net.ipv4.conf.all.forwarding=1
```

Notes on what is *not* in the list:
- **`cap_drop: ALL` also drops the 14 Docker-default caps** (MKNOD, SETPCAP,
  SYS_CHROOT, AUDIT_WRITE, FSETID, SETFCAP, and the ones re-added above). This
  is **intentional** — least-privilege means adding back only what OpenWrt is
  observed to need, not inheriting Docker's default bag. The add-back list is a
  best-evidence starting point; the hardware test (WARP-1016) is where any
  missing default gets identified by an observed boot/runtime failure and
  re-added with a one-line reason.
- **No `devices:` / `device_cgroup_rules:`** — the Wi-Fi PHY is a netdev moved
  into the container netns **host-side** by `droplet-openwrt-attach`
  (`iw phy … set netns <pid>`), not a `/dev` node the container opens. WireGuard
  is a kernel netdev (no `/dev/net/tun`). So no device grant is needed; verify
  the AP still binds after the drop.
- **`SYS_ADMIN` and `MKNOD` are the two most-likely re-adds** if the reduced set
  is too tight. `SYS_ADMIN`: procd's container init does mount operations (the
  compose already provides `tmpfs` for `/tmp` and `/run`, which *may* mean procd
  no longer needs to mount them itself — try dropping it and watch for a
  procd/mount failure at boot). `MKNOD`: procd + hotplug create device nodes at
  init; a `cap_drop: ALL` container that needs to `mknod` a `/dev` entry will
  fail without it. Confirm both on hardware before finalizing.
- **Expect benign sysctl `Read-only file system` (EROFS) warnings — do NOT chase
  them as a cap problem.** Removing `privileged: true` re-applies Docker's
  default **read-only `/proc/sys`** mount. The `sysctls:` block above covers
  ip_forward + `conf.all.forwarding`, but other runtime sysctl writers are
  *not* expressible as compose `sysctls` and will hit the read-only mount:
  `netifd` per-interface knobs (e.g. `net.ipv6.conf.<if>.*`), `fw4`'s
  `net.netfilter.*` tunables, and `procd` applying `/etc/sysctl.d`. These log
  benign EROFS lines and do not break the AP/router datapath. The WARP-1016
  engineer should treat an EROFS log line as **expected**, not as the procd boot
  failure — only genuine **mount/device** errors indicate a missing capability
  (SYS_ADMIN / MKNOD per the two bullets above).

### Follow-up ticket — WARP-1016
Tracked in **WARP-1016** (hardware verification): **stage the cap reduction on a
real single-box, verify AP + WireGuard + ubus + DHCP + reboot persistence, then
flip the live service to the hardened definition; and, separately, move
`openwrt` onto a dedicated `internal:`-scoped compose network to close the S2
lateral-movement path.**

---

## 7. Residual risk after the (future) hardening lands

Even with the reduced cap set + seccomp/AppArmor restored, the container still
holds `NET_ADMIN` (+ likely `SYS_ADMIN`) and terminates an internet-facing UDP
listener. Two residuals remain, and the cap reduction does not close either:

- A **kernel-level** WireGuard/netlink 0-day (S1a) executes in the host kernel,
  so it is a **full host compromise** — container caps/seccomp/AppArmor are
  irrelevant to it. The only mitigation is a patched host kernel + WireGuard's
  small audited surface.
- Residual **userspace** risk (S1b) is bounded to a compromised network
  namespace once the cap set is reduced — a large improvement over today's
  host-escape posture, but non-zero while `NET_ADMIN`/`SYS_ADMIN` remain.

The deeper residual mitigations are architectural and belong to the
multi-box shape and the Foundation's dedicated-hardware SKUs (Full Rack + Mini
Rack, physical WAN/Edge separation) — the single-box shape accepts a higher
residual risk in exchange for one-box economics, and this document is the
record of that accepted trade-off.
