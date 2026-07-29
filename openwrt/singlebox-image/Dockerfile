# Single-box OpenWrt container image (WARP-826).
#
# Bakes the AP + router packages into the image so a fresh container or a
# post-factory-reset box never depends on a first-boot `opkg install` over the
# network — the race that left hostapd (and iw) uninstalled and the default
# "Droplet" AP silently dead until droplet-openwrt-attach could reach the feed
# (root-caused live on the .87 box, 2026-06-06).
#
# Two build details, both load-bearing (found the hard way building on the box):
#   * `mkdir -p /var/lock` BEFORE opkg — the stock openwrt/rootfs has no
#     /var/lock until procd/init runs at container start, so in a bare
#     `docker build` opkg cannot create opkg.lock and dies with
#     "opkg_conf_load: Could not create lock file /var/lock/opkg.lock".
#   * the build needs host networking (compose `build.network: host`, see
#     docker-compose.yml) so opkg can resolve + reach downloads.openwrt.org via
#     the host's resolv.conf; the rootfs ships none of its own at build time.
#
# The package set mirrors droplet-openwrt-attach's runtime install list. That
# script still installs-if-missing at runtime as a safety net (e.g. an older
# pulled image, or a future package the bake predates), so the two are
# complementary — the bake makes the common path fast + offline-safe, the
# attach retry covers the rest.
FROM openwrt/rootfs:x86_64-24.10.2

# WARP-1639 — stop procd opening the HOST's consoles.
#
# This container runs `command: /sbin/init` (procd) with `privileged: true`, so
# it gets the host's real device nodes. Stock openwrt/rootfs ships an
# /etc/inittab containing:
#     ttyS0::askfirst:/usr/libexec/login.sh
#     hvc0::askfirst:/usr/libexec/login.sh
#     tty1::askfirst:/usr/libexec/login.sh
# procd therefore spawns BusyBox login shells on the host's real console,
# racing getty@tty1. Verified live on the mini-rack box: the container held an
# fd on the host's /dev/tty1, and the physical console showed the Ubuntu
# `droplet-sys login:` prompt interleaved with OpenWrt preinit spam
# ("Press the [f] key... failsafe mode", "kmodloader: no module folders").
#
# The tell that you are looking at this and not a broken password: at that
# prompt the PASSWORD ECHOES IN PLAINTEXT, because it is not a getty at all.
# Also note `fuser -v /dev/tty1` LIES here (PID namespace) — prove it by
# scanning /proc/*/fd as root instead.
#
# This matters beyond the rack panel: the same grab will take the Pi's console
# when the networking containers move there, so it is fixed in the image rather
# than papered over at runtime (a `docker exec ... sed` lives in the writable
# layer and dies on the next recreate).
#
# Deliberately NOT fixed by dropping `privileged: true` — the compose has a
# staged hardening block right below that service marked "do NOT enable until
# it passes on a real single-box".
RUN sed -i '/^tty[0-9]*::/d; /^ttyS[0-9]*::/d; /^tts\/[0-9]*::/d; /^hvc[0-9]*::/d; /^console::/d' /etc/inittab

RUN mkdir -p /var/lock \
 && opkg update \
 && opkg install \
      hostapd-mbedtls hostapd-utils wireless-regdb iw-full \
      uhttpd uhttpd-mod-ubus rpcd rpcd-mod-rpcsys rpcd-mod-iwinfo rpcd-mod-file \
      umdns \
      wireguard-tools kmod-wireguard luci-proto-wireguard \
      miniupnpd

# WARP-868 — bake the droplet rpcd ACL into the image. rpcd's `read '*'` in a
# login only expands over the acl.d groups that EXIST, so without this file
# even the root session is denied `file` reads (/dhcp/leases) and `umdns`
# browse (/aps/discovered) — the network tab 500s.
# It used to arrive only via a silenced best-effort `docker cp` in
# droplet-openwrt-attach, which failed on the 2026-06-11 reflash and left the
# box degraded with zero log signal. The COPY source is the CANONICAL file
# shared with the multi-box image overlay (openwrt/files/...) — the compose
# build context is openwrt/ for exactly this reason; attach keeps its copy as
# a safety net for containers created from pre-bake images.
COPY files/usr/share/rpcd/acl.d/droplet-ai.json /usr/share/rpcd/acl.d/droplet-ai.json

# WARP-868 — stock uhttpd caps concurrent ubus JSON-RPC invocations at
# max_requests=3. The orchestrator's network-summary fan-out (leases + aps +
# wireless + firewall + health in parallel) exceeds that, so the slowest rpcd
# scripts get their connections reset under load. uci-defaults scripts run
# once on first boot of a fresh container; droplet-openwrt-attach enforces the
# same value at attach time for containers that predate this image.
COPY singlebox-image/uci-defaults/60-droplet-uhttpd-limits /etc/uci-defaults/60-droplet-uhttpd-limits

# KAN-9 — miniupnpd now ships in the opkg install list above, which is what
# lights up the dashboard's UPnP / NAT-PMP card: the routing SDK's
# upnp_status() degrades a MISSING /etc/config/upnpd to available:false, so the
# card stays a read-only "Not available" line until the config exists. The
# stock package ships enable_upnp/enable_natpmp='1', but a privacy appliance
# must never auto-open ports before the owner asks. This uci-default seeds the
# upnpd config DISABLED (available:true, enabled:false) on first boot; the owner
# turns it on via the Tier-2 set_upnp path. uci-defaults scripts run once on
# first boot of a fresh container, then procd deletes them.
COPY singlebox-image/uci-defaults/61-droplet-upnp-default /etc/uci-defaults/61-droplet-upnp-default
