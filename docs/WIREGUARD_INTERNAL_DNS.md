# WireGuard and internal DNS

The Remote Access page uses direct WireGuard connections and the unicast name
registered by `scripts/lib/local-dns.sh` (`DROPLET_LAN_HOSTNAME`, default
`droplet-ai.lan`). Local device creation does not require fleet TLS issuance,
`DROPLET_PUBLIC_FQDN`, or an HQ service. No Cloudflare Worker URL is seeded by
setup or OTA environment reconciliation.

## Office connections

Add device defaults to **Office network**. The endpoint comes from the existing
router discovery, or `WIREGUARD_HOME_ENDPOINT_HOST` when explicitly configured.
The config uses the router's LAN DNS and routes the office and VPN subnets.
The QR instructions show `https://<DROPLET_LAN_HOSTNAME>`.

Use a unicast name such as `.lan`; `.local` uses multicast discovery and does
not cross a WireGuard tunnel. Verify the router's DNS entry points at the
dashboard host and its address is included in the client's routed subnets.

## Away connections

Set `WIREGUARD_ENDPOINT_HOST` to a bare host or IP reachable from the client
network. Allow UDP `WIREGUARD_LISTEN_PORT` (default 51820) to the WireGuard
router. An upstream NAT may need a UDP port forward; a private or CGNAT address
alone does not supply internet reachability.

The page offers **Away from the office** only when a non-LAN endpoint is
configured. This is a configuration check, not a successful handshake probe.
Away configs use that endpoint, and continue using the office DNS over the
tunnel. A fleet web name or legacy `REMOTE_ACCESS_MODE=relay` flag cannot
substitute for a direct UDP endpoint. Home configs report `offLanReachable=false`
even when the box also has an away endpoint.

## Existing appliance cutover

Environment reconciliation preserves existing values, including old HQ URLs.
For a deployment intended to have no fleet/Cloudflare dependency, explicitly
clear `HQ_ISSUANCE_URL`, `DROPLET_PUBLIC_FQDN`, and `TUNNEL_TOKEN`, disable
`OVERLAY_CONNECT_ENABLED`, and remove the `relay` compose profile. Recreate
affected containers after environment changes; a restart does not reload
`env_file`. Provision internal DNS through the existing setup path.

Before clearing fleet settings, account for the private image registry and OTA
device-token flow, which also use `HQ_ISSUANCE_URL`. A release that uses that
registry still needs its image distribution path configured independently.

HTTPS must serve a certificate that covers the internal DNS name and is trusted
by the client. A previously installed public certificate may cover only the old
fleet name; setup deliberately preserves it. Switching such a box requires a
controlled local-certificate cutover, not simply trusting a mismatched leaf.
The default bootstrap certificate covers `droplet-ai.lan`; a custom internal
hostname requires matching certificate SANs.

Verify on the appliance: resolve the internal name using the office resolver,
import a fresh home config, observe a WireGuard handshake, and open the
dashboard through the tunnel. For away access, repeat from cellular or another
network. The fleet enrollment button and queue are hidden when HQ is unset;
existing linked peers remain visible for management.
