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
RUN mkdir -p /var/lock \
 && opkg update \
 && opkg install \
      hostapd-mbedtls hostapd-utils wireless-regdb iw-full \
      uhttpd uhttpd-mod-ubus rpcd rpcd-mod-rpcsys rpcd-mod-iwinfo rpcd-mod-file \
      umdns \
      wireguard-tools kmod-wireguard luci-proto-wireguard \
      ddns-scripts luci-app-ddns

# WARP-868 — bake the droplet rpcd ACL into the image. rpcd's `read '*'` in a
# login only expands over the acl.d groups that EXIST, so without this file
# even the root session is denied `file` reads (/dhcp/leases) and `umdns`
# browse (/aps/discovered) — the network tab and the wizard's DDNS step 500.
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
