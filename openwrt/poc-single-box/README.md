# poc/single-box host-side bring-up

These two files belong on the **host** (not in the openwrt container) of a
single-box POC deployment. They handle the parts that can't live in
docker-compose because they require host-level operations on the wireless PHY.

## What they do

`droplet-openwrt-attach.service` is a one-shot systemd unit that, on every
`docker start droplet-openwrt`, runs `droplet-openwrt-attach`:

1. Wait for the droplet-openwrt container to be running
2. Move the MT7921 (`phy1`) into the container's network namespace via
   `iw phy phy1 set netns <pid>`
3. Bootstrap the container's network: set the Docker-assigned eth0 IP,
   add default route, write `/etc/resolv.conf` to 8.8.8.8 + 1.1.1.1
4. Enable IPv4 forwarding + add `nftables` NAT for `192.168.20.0/24` ?
   `eth0` masquerade
5. Install the WiFi-AP packages via `opkg` if missing (`hostapd-mbedtls`,
   `hostapd-utils`, `wireless-regdb`, `iw-full`, `uhttpd`, `uhttpd-mod-ubus`,
   `rpcd`, `rpcd-mod-rpcsys`, `rpcd-mod-iwinfo`, `rpcd-mod-file`)
6. Stop OpenWrt's procd-managed `dnsmasq` (claims 192.168.20.1:53)
7. Write `/etc/hostapd.conf` + `/etc/dnsmasq-ap.conf` if missing
8. Bring up `wlp7s0` at `192.168.20.1/24`
9. Start `hostapd -B` and `dnsmasq -C /etc/dnsmasq-ap.conf`

Idempotent throughout ? re-running it does no harm.

## Install on a fresh box

```bash
sudo cp openwrt/poc-single-box/droplet-openwrt-attach.service /etc/systemd/system/
sudo cp openwrt/poc-single-box/droplet-openwrt-attach /usr/local/sbin/
sudo chmod +x /usr/local/sbin/droplet-openwrt-attach
sudo systemctl daemon-reload
sudo systemctl enable --now droplet-openwrt-attach.service
```

## Why this can't be in the container

- Moving a wireless PHY across netns requires `iw phy ... set netns`, which
  must run on the host (the source netns owns the PHY before transfer).
- Privileged operations like `ip route add default via <gateway>` after the
  container's procd has torn down Docker's pre-assigned IP need a context that
  can re-exec into the container.

## Path forward (better than this)

This is a POC scaffold. The right long-term shape is:

1. A custom `droplet-openwrt` Docker image (Dockerfile FROM `openwrt/rootfs`)
   that pre-installs the opkg packages ? avoids re-install on every recreate.
2. uci-driven hostapd + dnsmasq via OpenWrt's standard `/etc/config/wireless`
   and `/etc/config/dhcp` (already written; needs the `wifi` command which is
   in the `wireless-tools` package not yet on this image).
3. PHY netns move via a Docker network plugin or a smaller host-side hook
   that doesn't need a full systemd unit.
