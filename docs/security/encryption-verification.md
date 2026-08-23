# On-box encryption verification (WARP-966)

**Ticket:** WARP-966 · **Epic:** WARP-957 (GA security cut-line) · **Due:** 2026-08-01

A single command on the appliance probes data-at-rest (LUKS2) and every
in-transit hop (Postgres, Redis, MQTT, internal service mesh, nginx edge) and
emits a **signed, timestamped, hash-chained evidence bundle**:

```bash
sudo bash scripts/host/droplet-verify-encryption.sh
```

## What this proves

The WARP-966 acceptance criteria:

> Documented evidence that data-at-rest (LUKS2) and each in-transit hop
> (Postgres/Redis/MQTT/service-mesh) is encrypted; any plaintext path filed as a
> release blocker; evidence linked from the epic.

Threat-model mapping (`docs/THREAT_MODEL.md`):

- **T5.8 / accepted-risk R4** — plaintext data-at-rest. Covered by the `rest.*`
  checks (LUKS2 header, Argon2id KDF, TPM-sealed keyslot, raw-partition entropy,
  mount coverage across the WARP-232 surfaces — `/data/docker` docker data-root,
  `/data/droplet/env/.env`, `/data/droplet/secrets` — plus USB automounts, plus
  the WARP-2102 `rest.docker.store-root` probe that resolves where the RUNNING
  docker/containerd daemons really keep the image store via their `/proc/<pid>/fd`
  bolt-db handles — Docker ≥ 28's containerd image store ignores `data-root`).
- **T1.2** — edge terminator protocol floor. Covered by `transit.pg.tls13` and
  `transit.edge.tls-policy`.
- **T2.8 / T5.x** — internal service-to-service plaintext. Covered by
  `transit.mesh.plain-http-refused`.

Each check records `maps_to` (the owning WARP ticket) and `threat_ids`, so the
bundle reads directly against the threat model's §10 register.

## Prereqs

- **root on the box** (`sudo`) — LUKS header dumps, raw device reads, and the
  bridge-interface pcap need it.
- **the stack up** (`docker compose -p droplet ... up`) — the transit probes exec
  into the running `db` / `cache` / `broker` / `orchestrator` containers.
- **`tcpdump`** for the passive cross-hop capture (`transit.pcap.canary`). It is
  the one tool that may not already be present:

  ```bash
  sudo apt-get install -y tcpdump
  ```

  If it is missing, that one check reports `SKIP` with a reason — everything
  else still runs.

Everything else (`cryptsetup`, `lsblk`, `findmnt`, `dd`, `openssl`, `python3`,
`psql`/`redis-cli`/`mosquitto_pub` inside their containers) is already on the box.

## Run it

```bash
# Full pass (all 17 checks):
sudo bash scripts/host/droplet-verify-encryption.sh

# A subset (comma-separated check ids):
sudo bash scripts/host/droplet-verify-encryption.sh --checks transit.edge.tls-policy,transit.pg.tls13

# Shorten the passive-capture window (default 60s):
sudo bash scripts/host/droplet-verify-encryption.sh --pcap-seconds 30

# List the check registry without running anything:
bash scripts/host/droplet-verify-encryption.sh --list
```

The bundle is written to `/var/lib/droplet/verify/<UTC-timestamp>/`:

```
report.json          machine-readable (schema droplet-encryption-evidence/v1)
report.md            human-readable acceptance evidence
evidence/<check>/…   raw captures (luksDump excerpts, psql stderr, s_client, pcap)
manifest.sha256      sha256 of every bundle file (sorted, stable)
manifest.sig         ECDSA-P256-SHA256 over manifest.sha256 (from the TPM sidecar)
device-id-cert.pem   verifier cert (copied from /var/lib/droplet/tpm/)
```

## Reading the report

Every registered check ALWAYS appears with exactly one status — the same
explicit-enum contract as `droplet-watchdog.sh`:

- **PASS** — the encryption property holds.
- **FAIL** — a plaintext path. Per the AC, **each FAIL is a release blocker**.
- **SKIP** — the subsystem is absent (no LUKS device yet, TLS port not
  listening, `tcpdump` not installed, container not running). Always carries a
  reason; never inferred from silence.

**Exit codes:** `0` = no FAIL (SKIPs allowed and listed); `1` = one or more FAIL
(the bundle is still fully produced — this is the AC's "plaintext path is a
release blocker" surface); `2` = harness error (could not even produce a bundle).

### Current-posture expectation (main)

All five encryption tickets have merged to main: WARP-232 (LUKS2 at-rest),
WARP-233 (Postgres TLS), WARP-234 (Redis TLS), WARP-235 (MQTT mTLS), and
WARP-236 (internal-CA issuance + mTLS *code*). The one caveat is the WARP-236
HTTP/gRPC mesh: the code is flag-gated behind `DROPLET_INTERNAL_TLS` and
**nothing sets that flag to `1` today** (neither `scripts/setup.sh` nor
compose), and several server-side listeners are not yet wired — see
`docs/security/internal-mtls.md` "Wiring status". Until the enablement work
lands, the two mesh-sensitive checks are **expected to FAIL** — those FAILs
are the *documented plaintext paths* the AC requires filing as blockers, not
harness bugs.

| Check | Expected today | Why |
|---|---|---|
| `rest.luks.device` / `rest.luks.header` / `rest.luks.tpm-token` / `rest.entropy` / `rest.mount-coverage` (R-01..R-05) | PASS | WARP-232 landed: `droplet-data` LUKS2/Argon2id LV with TPM2 keyslot, provisioned at first boot; `/data/docker`, `/data/droplet/env/.env`, `/data/droplet/secrets` all sit on the encrypted LV. FAILs here mean the box predates WARP-232 provisioning |
| `rest.usb-luks` (R-06) | SKIP | no USB mounts on the bench box by default |
| `rest.docker.store-root` (R-07) | PASS | WARP-2102: `daemon.json` pins `containerd-snapshotter: false` so `data-root` governs the whole image store. The probe reads the RUNNING daemons' `/proc/<pid>/fd` bolt-db handles (never `containerd config dump` — a config render proves nothing about the live daemon) and FAILs when the active store resolves off `/data` — the Docker-29 containerd-store regression that filled the bench box's 63G root LV to 92% |
| `transit.pg.plaintext-rejected` (T-01) | PASS | WARP-233: `hostssl`-only `docker/postgres/pg_hba.conf` — plaintext TCP hits the terminal reject. On a FIPS-mode box (`DROPLET_FIPS_MODE=1`) the probe records SKIP: `pg_hba.fips.conf` deliberately tolerates plaintext+SCRAM on the private container bridge (P1011 decision A, WARP-318) |
| `transit.pg.tls13` (T-02) | PASS | WARP-233: `ssl=on` + `ssl_min_protocol_version=TLSv1.3` with the WARP-236 internal-CA `db` bundle as the server cert |
| `transit.pg.scram` (T-03) | PASS | WARP-233 pins `password_encryption=scram-sha-256` as an explicit server flag (was the PG16 default) |
| `transit.redis.plaintext-refused` (T-04) | PASS | WARP-234: the plaintext listener is gone (`--port 0`) — 6379 refuses connections |
| `transit.redis.tls` (T-05) | PASS | WARP-234: TLS 1.3-only listener on 6380 (WARP-236 internal-CA `cache` leaf), authenticated PING as the ping-only `default` ACL user |
| `transit.mqtt.plaintext-closed` (T-06) | PASS | WARP-235 landed: no 1883 listener — `docker/mosquitto.conf` is a single mTLS listener on :8883 |
| `transit.mqtt.mtls-required` (T-07) | PASS | WARP-235 landed: `require_certificate true` — a certless publish is refused at the TLS handshake |
| `transit.mesh.plain-http-refused` (T-08) | FAIL (flag off) / PASS (flag on) | probes `orchestrator:3000` + `ai-gateway:8000` — the WARP-236 mesh hops. WARP-1061 wired both listeners end-to-end behind `DROPLET_INTERNAL_TLS`; the default posture is still `0` (plaintext), so a box whose operator hasn't flipped the knob keeps FAILing this check honestly. Enable per docs/security/internal-mtls.md → Runbook and the probe flips to PASS. (`mcp-server:9090` and `web-dashboard:3001` are deliberately NOT probed: they are by-design plain — JWT-gated / nginx user plane) |
| `transit.edge.tls-policy` (T-09) | PASS | `docker/nginx/nginx.conf` — TLSv1.2/1.3 only, HIGH ciphers |
| `transit.pcap.canary` (T-10) | FAIL (flag off) / PASS (flag on) | canary visible on the wire in the mesh HTTP hops — pg/redis/MQTT are all TLS (WARP-233/234/235); the mesh hops encrypt once `DROPLET_INTERNAL_TLS=1` is enabled (WARP-1061, see T-08) |

A **fully stopped stack reads SKIP** (`container-not-running:<service>`) on
every exec-based transit probe — never PASS. Start the stack before a
verification pass you intend to file as evidence.

## Filing blockers

For every **FAIL** row:

1. Comment on the owning ticket named in the check's `maps_to`
   (WARP-232 / WARP-233 / WARP-234 / WARP-235 / WARP-236), quoting the FAIL
   detail, and apply the `ga-cutline` label.
2. If no owning ticket covers the finding, file a **new release blocker** linked
   to epic **WARP-957**.

## Linking evidence (the AC's third bullet)

Attach to **WARP-966**: `report.md`, `report.json`, `manifest.sha256`,
`manifest.sig`, `device-id-cert.pem`. Add a comment on epic **WARP-957** linking
the attachment and quoting the summary block.

The **pcap stays on-box** unless a specific finding needs it — it is the largest
artifact and lives on the encrypted volume. `report.json` records only secret
variable *names* and match counts, never values.

## Signing and verifying a bundle

The manifest is signed by the device-identity sidecar (WARP-230) — `rpc Sign`,
ECDSA-P256 over SHA-256, using a non-extractable TPM-sealed key on
`unix:///var/run/droplet/device-identity.sock`. If the sidecar is absent or
unprovisioned, the bundle is produced **unsigned** with `signing.status =
"skipped"` and a reason (degrade, don't die).

The orchestrator's symmetric audit HMAC was considered and rejected: it gives no
third-party verifiability, and reusing that key for a second purpose would weaken
WARP-456's key-custody story.

Verify a bundle later — offline, no sidecar needed:

```bash
sudo bash scripts/host/droplet-verify-encryption.sh --verify-bundle /var/lib/droplet/verify/<ts>
```

Or the raw openssl one-liner:

```bash
openssl dgst -sha256 \
  -verify <(openssl x509 -in device-id-cert.pem -pubkey -noout) \
  -signature manifest.sig manifest.sha256
```

Runs form a **tamper-evident chain**: `report.json` records the previous run's
`prev_manifest_sha256` (`"genesis"` on the first run), so the progression from
all-FAIL to all-PASS as the encryption tickets land is itself acceptance evidence.

## Tests

The harness ships with a full unit suite (no root / hardware / Docker daemon):

```bash
npm run test:verify-encryption      # or: bash tests/verify-encryption.test.sh
```
