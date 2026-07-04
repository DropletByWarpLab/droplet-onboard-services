# egress-audit — runtime egress auditor (WARP-268)

Host-side collector that traces **every** outbound network flow from any
container on the single-box and logs it with
`(source service, destination, port, bytes, timestamp, allowed-policy)`. DNS
queries are logged with their query names. Flows that do not match the static
allowlist (`docs/security/allowed-egress.yaml`, owned by WARP-269) are flagged
as anomalies into the signed activity log (WARP-456/181/246), so they surface
on `/admin/audit`. This is the runtime half of the "telemetry-free" invariant
(THREAT_MODEL.md T6.8).

## Why it lives under `services/` but is NOT a compose service

The collector needs the **host** network namespace and root capabilities:

- it subscribes to the host's conntrack event stream (`conntrack -E`), which
  sees every masqueraded container-outbound flow with the pre-NAT container
  source IP preserved — the single interposition point for attribution;
- it captures port-53 traffic (`tcpdump -i any`) for DNS query names;
- it shells out to `docker network inspect` + `ip -j addr` to map source IPs
  to compose services.

None of that is possible from inside a container without punching holes in the
isolation model, so it runs as a systemd unit (`droplet-egress-audit.service`)
installed by `scripts/lib/single-box.sh`. Precedent: `services/automount/` is
host-side too.

## Install / runtime

Installed by `scripts/lib/single-box.sh` during `./scripts/setup.sh`:

- collector `*.py` → `/usr/local/lib/droplet-egress-audit/`
- launcher → `/usr/local/sbin/droplet-egress-audit`
- unit → `/etc/systemd/system/droplet-egress-audit.service`
- knobs → `/etc/default/droplet-egress-audit`

Runtime deps (best-effort apt, restic-pattern): `conntrack`, `tcpdump`,
`python3-yaml`. Runtime interpreter is the **host** `python3` (Debian 12,
≥3.11) with **stdlib only** except `PyYAML` from `python3-yaml`. Never pip on
the host.

## Records

NDJSON, one file per UTC day, under
`/var/lib/droplet/egress-audit/egress-YYYYMMDD.ndjson` (30-day retention).
Anomalies additionally POST to the orchestrator's
`/api/security/egress-anomaly`. Full record schema, the expected
`allowed-egress.yaml` schema, and operations are documented in
[`docs/security/egress-audit.md`](../../docs/security/egress-audit.md).

## Tests

All parser/attribution/allowlist/matching/sink logic is unit-tested on a dev
Mac with recorded fixtures (no shelling out to docker/conntrack/tcpdump). Run
via the ai-gateway venv (repo convention, see
`memory/droplet-onboard-services-test-env`):

```bash
cd services/egress-audit && ../ai-gateway/.venv/bin/python3 -m pytest
```

One-time venv prep:

```bash
../ai-gateway/.venv/bin/python3 -m pip install --only-binary=:all: PyYAML==6.0.3
```
