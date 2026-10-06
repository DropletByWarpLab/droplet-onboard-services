# WireGuard and internal DNS

The Remote Access page uses direct WireGuard connections and the unicast name
registered by `scripts/lib/local-dns.sh` (`DROPLET_LAN_HOSTNAME`, default
`droplet-ai.lan`). Local device creation does not require fleet TLS issuance,
`DROPLET_PUBLIC_FQDN`, or an HQ service. No Cloudflare Worker URL is seeded by
setup or OTA environment reconciliation.

The Cloudflare connector/profile, relay DNS/watchdog hooks, HQ connection
signaling, device enrollment/profile APIs, STUN probe, public-name setup APIs
and automatic fleet certificate issuer are removed. Onboarding, dashboard
links, discovery and gateway redirects use internal DNS. Historical ADRs remain
as records; this document supersedes their remote-access implementation.

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

Legacy `DROPLET_PUBLIC_FQDN`, `TUNNEL_TOKEN`, `REMOTE_ACCESS_MODE` and overlay
settings no longer activate access. Setup no longer installs relay helpers or
starts a connector. OTA explicitly removes the retired `droplet-cloudflared`
container; a full setup compose apply also removes it as an orphan. Recreate
affected containers after environment changes; a restart does not reload
`env_file`. Provision internal DNS and local TLS through the setup path.

Before clearing fleet settings, account for the private image registry and OTA
device-token flow, which also use `HQ_ISSUANCE_URL`. A release that uses that
registry still needs its image distribution path configured independently.

HTTPS must serve a certificate that covers the internal DNS name and is trusted
by the client. Setup preserves a matching certificate. A legacy leaf covering
only the fleet name is replaced with a local certificate around the existing
private key, so the served-key fingerprint remains stable. The configured
internal hostname is included in the new certificate SANs. Clients may need to
trust this local certificate; trusting a mismatched leaf does not fix its name.
Certificate status reads the installed leaf's expiry and internal hostname
coverage, so an old fleet record cannot keep displaying renewal failures.
The client trust helpers default to `droplet-ai.lan`. For a custom internal
hostname, pass it to `scripts/trust-droplet-cert.sh <hostname>` or use
`scripts/trust-droplet-cert.ps1 -HostName <hostname>` on Windows.

Verify on the appliance: resolve the internal name using the office resolver,
import a fresh home config, observe a WireGuard handshake, and open the
dashboard through the tunnel. For away access, repeat from cellular or another
network. Fleet enrollment is no longer available. Existing linked peers remain
visible for revocation; revoke legacy grants before clearing HQ credentials so
the signed fleet teardown can finish. Only failed legacy revocations are retried;
no new enrollment or connection polling occurs.

The optional fleet registry, release artifact mirror and device-authentication
CLI remain for image distribution and decommissioning. They are not a remote
access dependency. Ordinary configurable DNS resolver choices are also unchanged.
