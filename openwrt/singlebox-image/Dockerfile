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
