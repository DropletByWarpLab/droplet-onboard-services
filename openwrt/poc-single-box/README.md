# poc/single-box host-side bring-up

These three files belong on the **host** (not in the openwrt container) of a
single-box POC deployment. They handle the parts that can't live in
docker-compose because they require host-level operations on the wireless PHY.

- `droplet-openwrt-attach` — the bring-up script (installed to `/usr/local/sbin/`)
- `droplet-openwrt-attach.service` — systemd one-shot, fires after docker (installed to `/etc/systemd/system/`)
- `droplet-openwrt-attach.env` — `EnvironmentFile=` template with SSID/PSK and DNS knobs (installed to `/etc/default/droplet-openwrt-attach`)

## What they do

`droplet-openwrt-attach.service` is a one-shot systemd unit that, on every
`docker start droplet-openwrt`, runs `droplet-openwrt-attach`:

1. Wait for the droplet-openwrt container to be running
2. Move the MT7921 (`phy1`) into the container's network namespace via
   `iw phy phy1 set netns <pid>`
3. Bootstrap the container's network: set the Docker-assigned eth0 IP,
   add default route, write `/etc/resolv.conf` to 8.8.8.8 + 1.1.1.1
4. Enable IPv4 forwarding + add `nftables` NAT for `192.168.20.0/24` ->
   `eth0` masquerade
5. Install the WiFi-AP packages via `opkg` if missing (`hostapd-mbedtls`,
   `hostapd-utils`, `wireless-regdb`, `iw-full`, `uhttpd`, `uhttpd-mod-ubus`,
   `rpcd`, `rpcd-mod-rpcsys`, `rpcd-mod-iwinfo`, `rpcd-mod-file`)
6. Resolve `droplet-pi-platform-gateway-1`'s docker IP and install DNAT
   rules in `ip nat prerouting` so AP-side `:80`/`:443` traffic to
   `192.168.20.1` lands on the dashboard gateway container (Phase K).
7. Stop OpenWrt's procd-managed `dnsmasq` (claims 192.168.20.1:53)
8. Write `/etc/hostapd.conf` + `/etc/dnsmasq-ap.conf` (regenerated every
   run so env-driven changes propagate). The dnsmasq config pushes
   `192.168.20.1` as DHCP DNS server so phones resolve customer-facing
   names via the box's own dnsmasq, with static mappings for `$AP_DOMAIN`
   and `$AP_HOSTNAME` pointing back at `192.168.20.1` (DNAT'd to dashboard).
9. Bring up `wlp7s0` at `192.168.20.1/24`
10. Start `hostapd -B` and `dnsmasq -C /etc/dnsmasq-ap.conf` (kill+restart
    only when config actually changed, otherwise leave running).

Idempotent throughout - re-running it does no harm.

### Phase K: LAN bridge via DNAT + DNS

Before Phase K, AP clients had internet but no way to reach the dashboard:
the dnsmasq config handed phones `8.8.8.8` as DNS, so customer-facing names
never resolved. Phase K closes that gap with one design choice: phones hit
the **openwrt router** (`192.168.20.1`, which they already use as default
gateway), and openwrt DNATs the connection to the dashboard container.
Phones never need to know about the docker network IP space.

End-to-end flow when a phone opens `https://droplet.local/`:

```
phone (192.168.20.X) --DNS--> 192.168.20.1   (openwrt dnsmasq)
                          <-- 192.168.20.1   (static address= mapping)
phone (192.168.20.X) --TCP--> 192.168.20.1:443
                              [nft prerouting DNAT -> 172.18.0.2:443]
                              [nft postrouting masq src -> 172.18.0.15]
                              gateway container 172.18.0.2:443
                              (conntrack un-DNATs + un-masqs on return)
```

The mechanism does NOT depend on:
- mDNS / avahi running on the phone or the box
- cross-subnet TCP routing through the docker bridge
- the phone's own DNS resolver settings (we override via DHCP)
- a static gateway-container IP (resolved at attach time, refreshed on
  every container recreate)

### Phase L: routing service can drive OpenWrt + WireGuard works end-to-end

The attach script now also:

1. **Installs WireGuard packages** (`wireguard-tools`, `kmod-wireguard`,
   `luci-proto-wireguard`) alongside the AP packages, then restarts netifd
   so it loads the new protocol handler (re-bootstrapping eth0 afterwards,
   since netifd restart wipes Docker's pre-assigned IP).
2. **Sets the OpenWrt root password** from
   `docker/secrets/openwrt_password` so the routing service can
   authenticate against `rpcd`. Idempotent: only resets when the current
   password fails a probe login.
3. **Drops a `wg-sync` helper** at `/usr/local/sbin/wg-sync` that reads
   UCI peers and applies them to the running `wg0` kernel interface via
   `wg syncconf`. A 2-second poll loop (`wg-sync-loop`, started via
   `start-stop-daemon`) detects UCI changes and runs the sync — netifd's
   `ubus call network reload` path is unreliable in this container, so we
   bypass it.

On the compose side, [`docker-compose.override.yml`](../../docker/docker-compose.override.yml)
adds `127.0.0.1:8081:80` to OpenWrt's port map and overrides the routing
service env so `OPENWRT_HOST=127.0.0.1`, `OPENWRT_PORT=8081`,
`OPENWRT_USERNAME=root` — keeping `network_mode: host` for the routing
service while still letting it reach the in-container OpenWrt.

End-to-end peer lifecycle (verified):

```
POST /vpn/setup     -> wg0 in UCI, server keypair generated
                    -> netifd brings up wg0 (kernel interface live)
POST /vpn/peers     -> UCI gets [Peer] entry, private_key returned once
  ~2s later         -> wg-sync notices the UCI hash change, runs
                       wg syncconf -> peer appears in `wg show`
DELETE /vpn/peers   -> UCI entry removed
  ~2s later         -> wg-sync removes the peer from kernel state
```

### Customer branding (env overrides)

```
DROPLET_AP_SSID            (default Droplet-POC)
DROPLET_AP_PSK             (default droplet-poc-password, min 8 chars)
DROPLET_AP_DOMAIN          (default droplet.local — resolves to 192.168.20.1)
DROPLET_AP_HOSTNAME        (default droplet         — resolves to 192.168.20.1)
DROPLET_GATEWAY_CONTAINER  (default droplet-pi-platform-gateway-1)
```

Set in `/etc/default/droplet-openwrt-attach` (the systemd unit loads it
via `EnvironmentFile=-/etc/default/droplet-openwrt-attach`, leading `-`
making it optional) or by exporting before invoking the script manually.
Re-running the attach script picks up any change; config files in the
container are diff'd against the new render and daemons restart only when
the rendered file actually changed.

The shipped `droplet-openwrt-attach.env` template defaults to
`DROPLET_AP_SSID=Droplet` / `DROPLET_AP_PSK=Droplet123!`. Edit
`/etc/default/droplet-openwrt-attach` after `scripts/setup.sh` runs to
override per-deployment (e.g. customer-branded SSID).

## Install on a fresh box

`scripts/setup.sh` does this automatically. To install by hand:

```bash
sudo cp openwrt/poc-single-box/droplet-openwrt-attach.service /etc/systemd/system/
sudo cp openwrt/poc-single-box/droplet-openwrt-attach /usr/local/sbin/
sudo chmod +x /usr/local/sbin/droplet-openwrt-attach
sudo install -m 0644 openwrt/poc-single-box/droplet-openwrt-attach.env \
  /etc/default/droplet-openwrt-attach     # safe to skip; defaults are baked into the script
sudo systemctl daemon-reload
sudo systemctl enable --now droplet-openwrt-attach.service
```

## Why this can't be in the container

- Moving a wireless PHY across netns requires `iw phy ... set netns`, which
  must run on the host (the source netns owns the PHY before transfer).
- Privileged operations like `ip route add default via <gateway>` after the
  container's procd has torn down Docker's pre-assigned IP need a context
  that can re-exec into the container.

## Path forward (better than this)

This is a POC scaffold. The right long-term shape is:

1. A custom `droplet-openwrt` Docker image (Dockerfile FROM `openwrt/rootfs`)
   that pre-installs the opkg packages -- avoids re-install on every recreate.
2. uci-driven hostapd + dnsmasq via OpenWrt's standard `/etc/config/wireless`
   and `/etc/config/dhcp` (already written; needs the `wifi` command which is
   in the `wireless-tools` package not yet on this image).
3. PHY netns move via a Docker network plugin or a smaller host-side hook
   that doesn't need a full systemd unit.
