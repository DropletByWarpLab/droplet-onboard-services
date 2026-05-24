# scripts/host/ — captured PoC box state (Phase 0)

This directory is a **read-only capture** of files that exist on the live
single-box PoC at `192.168.1.87` (`droplet-sys`) but are NOT yet declared
anywhere in this repo. Captured 2026-05-24 from the running box on branch
`feat/poc-single-box-rebuild`.

> **Phase 0 is CAPTURE ONLY.** Nothing here is wired into `setup.sh` or
> the compose stack yet — these are reference copies so a future
> rebuild-from-scratch doesn't strip away the PoC's hand-built integrations.
> Phase 1 will design how these get installed cleanly (`setup.sh` flag,
> profile, ADR on which parts belong in compose vs systemd).

## Why this exists

The PoC was bootstrapped over ~6 weeks of incremental SSH work — the team
landed pieces directly on the box as `docker-compose.override.yml`,
`/usr/local/sbin/*` scripts, and `/etc/systemd/system/*.service` units.
None of that lives in any repo today. A naive `factory-reset.sh + setup.sh`
would reset to a state that's strictly **less functional** than the box
because none of these layers exist in `setup.sh`.

Capturing them here gives Phase 1 a known-good baseline to design from.

## What's in here

```
scripts/host/
├── README.md                                        ← you are here
├── _box-snapshot-2026-05-24.md                      ← state of the box at capture
├── _uncommitted-on-box.md                           ← 2 working-tree files needing a call
├── docker-compose.poc.yml                           ← captured docker-compose.override.yml
├── usr-local-sbin/
│   ├── droplet-openwrt-attach                       ← 20 KB AP/OpenWrt bootstrap script (current)
│   ├── droplet-openwrt-attach.bak                   ← 13 KB previous version (kept on box)
│   └── droplet-poc-host-net                         ← br-lan DHCP + Lantronix route
├── etc-default/
│   ├── droplet-openwrt-attach.example               ← REDACTED env file (AP_PSK stripped)
│   └── droplet-poc-host-net                         ← no secrets, captured as-is
├── etc-systemd-system/
│   ├── droplet.service                              ← starts `docker compose up -d` on boot
│   ├── droplet-openwrt-attach.service               ← runs the attach script after docker
│   ├── droplet-openwrt-attach.service.d/
│   │   └── override.conf                            ← pulls EnvironmentFile=
│   └── droplet-poc-host-net.service                 ← host br-lan DHCP daemon
├── etc-droplet-poc-host-net/
│   └── lan-dhcp.conf                                ← dnsmasq config for br-lan
├── etc-dnsmasq.d/
│   ├── droplet-ap.conf                              ← legacy system-dnsmasq drop-in (current)
│   └── droplet-ap.conf.pre-bridge                   ← pre-bridge variant kept on box
├── etc-tmpfiles.d/
│   └── droplet.conf                                 ← /run/droplet tmpfiles spec
└── etc-avahi/
    └── services/
        └── droplet.service                          ← mDNS service advert (http + https)
```

## How files map back to the box

| Captured path | Real path on box | Owner |
|---|---|---|
| `docker-compose.poc.yml` | `/home/droplet/edge-platform/docker/docker-compose.override.yml` | git-ignored in repo; auto-loaded by `docker compose` when no `-f` flag is given |
| `usr-local-sbin/*` | `/usr/local/sbin/*` | `chmod +x`, owned by root |
| `etc-default/*` | `/etc/default/*` | sourced by systemd `EnvironmentFile=` |
| `etc-systemd-system/*` | `/etc/systemd/system/*` | enabled in `multi-user.target.wants/` |
| `etc-droplet-poc-host-net/lan-dhcp.conf` | `/etc/droplet-poc-host-net/lan-dhcp.conf` | referenced from `droplet-poc-host-net` script |
| `etc-dnsmasq.d/*` | `/etc/dnsmasq.d/*` | system dnsmasq (NOT used in current config — see snapshot) |
| `etc-tmpfiles.d/droplet.conf` | `/etc/tmpfiles.d/droplet.conf` | creates `/run/droplet` on boot |
| `etc-avahi/services/droplet.service` | `/etc/avahi/services/droplet.service` | mDNS advertisement |

## Important: the AP PSK in `etc-default/droplet-openwrt-attach.example`

The live box has `/etc/default/droplet-openwrt-attach` with
`DROPLET_AP_PSK=Droplet123!`. Per the architecture-guard rule on no
secrets in tracked files, the `.example` here strips that value to a
placeholder. The real PSK ships via the setup wizard (or operator-provided
env override). DO NOT replace the placeholder with the real value — if
you find yourself doing that, you're solving the wrong problem.

## Phase 1 design questions this capture enables

- Does `docker-compose.poc.yml` get merged into `docker/docker-compose.yml`
  under a `poc` compose profile? Or kept as a separate file loaded via
  `COMPOSE_FILE` env? (Probably the former — single source of truth.)
- Does `setup.sh` grow a `--poc` flag that installs the systemd units and
  scripts into the host? Or do we factor those into a separate
  `scripts/host/install.sh` callable from setup.sh? (Probably the latter —
  setup.sh stays slim, install.sh owns host-touching logic.)
- Do the `droplet-openwrt-attach.service` + `droplet-poc-host-net.service`
  patterns generalize beyond the PoC, or are they single-box-only? (TBD —
  the production multi-box uses a real OpenWrt router and a separate
  Jetson, so the AP-in-container and br-lan DHCP pieces become moot.)
- The legacy `etc-dnsmasq.d/droplet-ap.conf` files conflict with the
  newer `droplet-poc-host-net` design — should they be removed from the
  box? (Phase 1 cleanup.)

## What's intentionally NOT captured here

- `/home/droplet/edge-platform/.env` — device-unique secrets generated by
  `setup.sh`. Captured in `setup.sh` itself, not here.
- `/home/droplet/edge-platform/docker/secrets/*` — generated by setup.sh.
- `/var/lib/droplet-bridge/` — runtime state (rotation timestamps, key
  digests). Recreated by `droplet-device-bridge.service`.
- Docker volumes (`pgdata`, `nextcloud-data`, etc.) — see `_box-snapshot`
  for inventory of what's IN them and the strategy for migration.
