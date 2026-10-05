# Fresh deployment behind an external edge router (RB5009)

Runbook from a blank MikroTik RB5009 and a blank box to a verified system
(epic WARP-3834, WARP-3842). Router-side details live in the
[droplet-edge-router](https://github.com/DropletByWarpLab/droplet-edge-router)
repo and are linked, not copied. The `--edge-router` flag itself is described in
[`SINGLE_BOX.md`](SINGLE_BOX.md#external-edge-router-warp-3835).

Placeholders: `ROUTER=192.168.9.1`, `BOX=192.168.9.10` (the box image hostname is
`droplet-sys`; the router pins it to `.10`, WARP-3840), `KEY=~/.ssh/droplet-pi`.
Checkout on the box: `/home/droplet/edge-platform`.

| Step | Who / where / user | Verified by |
|---|---|---|
| R0a router build | operator, build host, any | `out/*rb5009*sysupgrade.bin` + `.sha256` exist |
| R0b box image | operator, Linux build host with Docker, any | `droplet-image flash` checks the image before writing |
| R1 router flash | operator, laptop on router p2 | `/etc/droplet-build`; router `scripts/verify.sh` |
| R2 cabling | operator, physical | router LAN port link up |
| R3 box first boot | unattended, box, `droplet-firstboot.service` | `systemctl status droplet-firstboot.service` |
| R4 pair | operator, from a machine that can reach both | `setup.sh` exits 0 (exit 1 names the failure) |
| R5 end-to-end | operator, box as `droplet` + router | checks listed below |
| R6 later deploys | operator, box as `droplet` | `systemctl start droplet-deploy.service` exit 0 |
| R7 router upgrades | operator | re-pair (R4) when the password changed |

## R0a. Build the router image

```bash
# droplet-edge-router checkout, build host
AUTHORIZED_KEY=~/.ssh/droplet-pi.pub ./build/build.sh --device rb5009
```

Requires droplet-edge-router #39 (WARP-3836): after it, a build without
`AUTHORIZED_KEY` is refused instead of producing a keyless image. Until it merges
a keyless build still succeeds, so always pass the key.

## R0b. Build and flash the box image

```bash
./scripts/droplet-image build --version <X.Y.Z>
./scripts/droplet-image flash --image output/droplet-single-box-<X.Y.Z>.iso \
    --device /dev/sdX --confirm "ERASE /dev/sdX"
```

Full contract: [`IMAGE_PIPELINE.md`](IMAGE_PIPELINE.md). No per-device secret is
baked into the image.

## R1. Flash the router

Follow droplet-edge-router
[`docs/FLASH-RB5009.md`](https://github.com/DropletByWarpLab/droplet-edge-router/blob/main/docs/FLASH-RB5009.md).
First boot mints `/etc/droplet/root-password` and `/etc/droplet/droplet-ai-password`
(both 0600). Then, from the operator machine:

```bash
ssh -i $KEY root@192.168.9.1 'sh -s' < scripts/verify.sh   # in the router checkout; exits non-zero on any FAIL
```

## R2. Cabling

Router LAN port to the box NIC; router WAN to the upstream network. The box takes
`192.168.9.10` from the router's DHCP pin on hostname `droplet-sys`.

## R3. Box first boot

Boot the flashed box. `droplet-firstboot.service` clones the repo to
`/home/droplet/edge-platform` and runs `setup.sh --single-box --systemd`
unattended (see [`SINGLE_BOX.md`](SINGLE_BOX.md)). With no router password yet,
`setup.sh` warns and routing cannot authenticate; that is expected until R4.
Check: `ssh droplet@192.168.9.10 systemctl status droplet-firstboot.service`.

## R4. Pair the box with the router (today: manual)

Copy the router's `droplet-ai` password straight into the secret file. It never
goes on argv, in `.env`, or in shell history:

```bash
ssh -i $KEY root@192.168.9.1 'tr -d "\n" < /etc/droplet/droplet-ai-password' \
  | ssh droplet@192.168.9.10 'cat > /home/droplet/edge-platform/docker/secrets/openwrt_password'

# on the box, as droplet
cd /home/droplet/edge-platform
./scripts/setup.sh --edge-router 192.168.9.1 --skip-docker --skip-drivers
```

`setup.sh` writes `OPENWRT_HOST`/`OPENWRT_PORT`/`OPENWRT_USERNAME=droplet-ai`,
keeps a non-empty secret file (WARP-3738; an empty one is never seeded with a
box-generated value, setup warns instead), then runs `verify.sh`. It **exits 1
and names the failure** unless routing authenticated to the router over the
deployment's mTLS; the install-mode SSH window stays open on failure. Success
prints `Setup Complete`, or `Setup Complete with N warnings`.

## R4'. Pair (future)

The dashboard Pair button, ADR-071 ([`ADR-071-box-router-pairing.md`](ADR-071-box-router-pairing.md)),
is not built: WARP-3869, WARP-3870, WARP-3871.

## R5. End-to-end check

```bash
# box, as droplet
cd /home/droplet/edge-platform && ./scripts/verify.sh         # "Routing -> router auth" must pass
sudo droplet-host-units audit                                  # exit 0
systemctl --failed                                             # no droplet-* units
cat /var/lib/droplet/watchdog/status.json                      # router_auth: ok
nslookup <box-fqdn> 192.168.9.1                                # resolves to the box
# router (see R1)
ssh -i $KEY root@192.168.9.1 'sh -s' < scripts/verify.sh
```

Then open the dashboard Network tab: it must show the router, not "Credentials rejected".

## R6. Later deploys

```bash
# box, as droplet (no sudo)
cd /home/droplet/edge-platform
git fetch origin && git checkout <sha>
systemctl start droplet-deploy.service       # blocks; exit 1 = failed
journalctl -u droplet-deploy.service -n 80
```

Backs up, runs `setup.sh --skip-docker --skip-drivers` as `droplet`, starts
`droplet-host-units.service`, then gates on `droplet-host-units audit` and the
required units. No automatic rollback. Details: [`../scripts/host/README.md`](../scripts/host/README.md#deploying-warp-3841).

## R7. Router upgrades

Follow droplet-edge-router `docs/OPERATIONS.md` (sysupgrade).

- Without `-n`: `/etc/droplet` survives and the password is kept (requires
  droplet-edge-router #40, WARP-3837). No re-pair needed.
- With `-n`: first boot mints a new password. Re-pair (R4).
- Leaked password: on the router `sh /rom/etc/uci-defaults/99-droplet-edge-rpc --rotate`
  (requires #40), then re-pair (R4).

## Troubleshooting

| Symptom | Meaning / fix |
|---|---|
| verify: `routing is not connected to the router: ... ROUTER_AUTH` | Router rejected the `droplet-ai` password. Re-copy it (R4), re-run `setup.sh --edge-router`. |
| verify: `Docker secret: openwrt_password` fails, "paste the router's droplet-ai password" | Secret file is empty or missing. Do R4. |
| verify: `no /health response from ...` or unreachable error | Routing is down or cannot reach the router. Check cabling, `OPENWRT_HOST` in `.env`, router `scripts/verify.sh`. |
| watchdog `router_auth` = `heal_failed` | Same as ROUTER_AUTH; detect-only, a human must re-pair. `not_applicable` = routing unreachable or `ROUTING_MODE` is not `real`. |
| deploy: `user droplet is not in the docker group` | WARP-2888 trust assumption broken; the unit refuses to run. |
| deploy: `/data is not mounted` | Relocated (encrypted) box with `/data` unmounted; mount it first. |
| deploy: `checkout ... is dirty` | Commit or discard changes in the checkout, as `droplet`. |
| deploy: `secrets tar failed: a file ... is not readable by droplet` | A root-owned file under `data/secrets` etc.; `chown` it to `droplet`. |
| Where are backups? | `/var/lib/droplet/deploy-backups/<UTC ts>/`, or `/data/droplet/deploy-backups/` on a relocated box. Last 3 kept; restore commands are in the journal on failure. |
