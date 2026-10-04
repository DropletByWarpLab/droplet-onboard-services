# Host input firewall (WARP-3574) - proposal, disabled

Status: **proposal only**. Nothing in `setup.sh` or any unit loads it. The rule
set is `scripts/host/proposed/droplet-host-input.nft.proposed`; the guard is in
`tests/droplet-host-net-unit.test.sh`.

## Why a firewall and not a bind address

The control-plane services run with `network_mode: host` (routing :8080,
switch :8081, display :8082, matter-controller :8083, camera-discovery :8085)
and the device bridge binds `0.0.0.0:9090`. Each has host-side callers on
`127.0.0.1` (for example camera-discovery and switch call routing on
`localhost:8080`; the panel dead-man, automount and wifi-rotate call the
bridge on `127.0.0.1:9090`) **and** container callers through the
`droplet_default` gateway IP (the orchestrator, via `host.docker.internal`).
A listener can bind one address; serving both callers needs `0.0.0.0`.
Re-binding to the gateway IP alone breaks the host callers, and re-binding to
loopback alone breaks the orchestrator, so no bind change is safe on its own.
The exposure is therefore closed at the input chain, with a bearer token still
required on every authenticated route.

## Rollout (needs a console or a second admin path; never first on a customer box)

1. **Inventory.** On the target box run `ss -lntupH` and compare with the
   `host-listener:` lines in the proposal. Every listener must be `lan` (an
   accept rule exists) or `internal` (no accept rule). Resolve the items under
   "NOT YET VERIFIED" in the proposal file first.
2. **Syntax.** `sudo nft -c -f scripts/host/proposed/droplet-host-input.nft.proposed`.
3. **Observe mode (24 h).** Load with `policy accept` so nothing is dropped
   and the final rule logs what would be:
   `sed 's/policy drop;/policy accept;/' <file> | sudo nft -f -`.
   Read `journalctl -k | grep droplet-input-drop` after exercising every
   client: dashboard, iOS and Mac app, Windows and macOS file share, cameras,
   Matter devices, Wi-Fi clients, VPN, SSH toggle on and off.
4. **Enforce with a dead-man switch.** Arm a rollback first, then load:
   `sudo systemd-run --on-active=300 nft delete table inet droplet_host_input`
   then `sudo nft -f <file>`. Confirm the dashboard and the SSH toggle from a
   LAN client, then cancel the rollback
   (`systemctl stop run-*.timer` for the unit `systemd-run` printed).
5. **Persist.** Only after a soak on a stage box: install the file as a root
   unit owned by `setup.sh` (new `host-artefacts` MANIFEST row, a unit test, and
   this proposal renamed to drop `.proposed`), enabled by a `DROPLET_HOST_FIREWALL=1`
   switch that defaults to off for one release.

## Rollback

`sudo nft delete table inet droplet_host_input` removes every rule at once;
nothing else on the box depends on it.

## Related

- `docs/security/internal-mtls.md`: internal TLS ships off (WARP-2565); the
  firewall does not replace it.
- camera-discovery authenticates with `DEVICE_SECRET` rather than its own
  service token, and `DROPLET_INTERNAL_TLS` defaulting on for host-network
  services are both still open under WARP-3574 / WARP-2565.
