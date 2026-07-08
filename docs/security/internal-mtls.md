# Internal service-to-service mTLS (WARP-236) + MQTT mTLS (WARP-235)

Every first-party internal HTTP/gRPC hop and the MQTT broker authenticate peers
with X.509 client certificates issued by a compose-network-scoped internal CA.
The single shared MQTT password is retired; MQTT identity is the client-cert CN.

## Design summary

A file-based internal CA lives at `data/secrets/internal-ca/` (minted once by
`scripts/lib/internal-ca.sh` from `materialize_artifacts()` in
`scripts/lib/secrets.sh`). It issues one 90-day server+client bundle per service
into `data/secrets/service-tls/<service>/{cert.pem,key.pem,ca.pem}`. Each
container bind-mounts only its own bundle read-only at `/data/service-tls`.

- **Servers** (orchestrator HTTPS :3000, FastAPI/uvicorn services, ai-gateway
  gRPC :50051, Mosquitto :8883, matter-controller :8083) require and verify a
  CA-signed client cert on every connection.
- **Clients** (undici fetch, httpx, paho, mqtt.js, grpc, nginx `proxy_ssl_*`)
  present their own bundle and pin trust to the internal CA.
- **Mosquitto** maps the peer CN to the MQTT username
  (`use_identity_as_username true`) and a static ACL file scopes each CN to
  exactly the topics it uses.

### Chosen CA approach (flagged for ratification)

**Setup-time internal CA (plain `openssl` in `scripts/lib/internal-ca.sh`)** —
NOT the step-ca `internal-ca` service the ticket names, and NOT
device-identity-svc issuance. Rationale:

1. This is a single-box Docker Compose appliance (~6 GB RAM budget). A step-ca
   container adds an always-on service plus a bootstrap-token distribution
   problem; "SPIFFE-style attestation" buys no real security on one Docker host
   (any workload that can read a compose-network bootstrap token can impersonate
   any other), so boot-time CSR flows add complexity without a threat-model win
   over setup-time issuance with per-container read-only bundle mounts.
2. device-identity-svc cannot issue certs today: its gRPC surface is
   `Sign`/`GetCert`/`GetStatus`/`Reseal` only, and the real TPM signer is a
   placeholder. X.509 CA issuance on it would mean new proto RPCs plus finishing
   the TPM path — a much larger lift.
3. An openssl script is implementable and unit-testable on a dev Mac today and
   reuses the exact `materialize_artifacts()` pattern setup.sh already has.

**Deviations from the tickets as filed (require ratification):**

1. No step-ca container, no boot-time SPIFFE attestation — setup-time issuance +
   read-only bundle mounts instead.
2. 90-day certs + `scripts/rotate-internal-certs.sh` (cron-able) instead of
   hourly auto-rotation; rotation does a rolling `docker compose restart` of
   affected services (seconds of blip) instead of zero-restart in-process
   reload. Node https/mqtt.js and uvicorn all cache key material at process
   start; true hot-reload is a per-runtime project with poor ROI on a box we
   control end-to-end.
3. Emergency revocation = re-mint the CA + reissue all bundles + rolling restart
   (no CRL/OCSP distribution in a single-box CA).
4. mTLS scope = first-party service plane. Third-party containers keep their
   posture: nextcloud/docserver (nginx-fronted user plane), ollama
   (bridge-internal, ai-gateway-only caller), wyoming whisper/piper (raw Wyoming
   TCP, no TLS support), frigate HTTP :5000 (loopback-published). frigate DOES
   get an MQTT client cert (its MQTT config supports client certs). mcp-server's
   inbound :9090 stays JWT-gated (off-stack consumers); it becomes an mTLS
   *client* toward the orchestrator. web-dashboard inbound stays plain HTML to
   nginx (holds no service secrets; the browser is the real client).
5. WARP-235 removes the password listener entirely (single mTLS listener :8883).
   The dev compose stack keeps its own anonymous 1883 broker — untouched.

## Enforcement matrix (first-party hops secured)

| # | Client → Server | Transport | Was | Now (DROPLET_INTERNAL_TLS=1) |
|---|---|---|---|---|
| 1 | nginx gateway → orchestrator :3000 | `proxy_pass` | plain | mTLS (gateway client cert) |
| 2 | nginx gateway → ai-gateway :8000 | `proxy_pass` | plain | mTLS (gateway client cert) |
| 4 | orchestrator → ai-gateway :8000 | undici fetch | bearer | mTLS + bearer |
| 5 | mcp-server → orchestrator :3000 | fetch | bearer | mTLS + bearer |
| 6 | voice-io → orchestrator :3000 | httpx | bearer | mTLS + bearer |
| 7 | email-indexer → orchestrator :3000 | httpx | bearer | mTLS + bearer |
| 8 | rag-eval → orchestrator :3000 | httpx | admin | mTLS |
| 9 | orchestrator → rag-eval :8090 | fetch | none | mTLS |
| 10 | orchestrator → voice-io :8086 | fetch | none | mTLS |
| 11 | orchestrator → routing/switch/oled/matter | fetch | bearers | mTLS + bearer |
| 12 | mcp-server → routing :8080, switch :8081 | fetch | bearers | mTLS + bearer |
| 13 | switch → routing; camera-discovery → routing | httpx | token | mTLS + token |
| 14 | routing → orchestrator :3000 (sampler) | httpx | bearer | mTLS + bearer |
| 15 | ops-console → orchestrator/ai-gateway/voice-io probes | httpx | URLs | mTLS |
| 16 | file-indexer → ai-gateway :50051 (gRPC) | grpc | insecure | gRPC mTLS |

**Out of mTLS scope (documented exclusions):** nginx → web-dashboard / nextcloud
/ docserver (user plane); orchestrator → nextcloud WebDAV / frigate :5000
(third-party servers); orchestrator → device-identity-svc (Unix socket,
filesystem-scoped); ai-gateway → ollama, voice-io → wyoming (third-party, no/raw
TLS). `ORCHESTRATOR_URL` on the ai-gateway container is dead config (no reader).

## Env contract

Identical keys in the TS helper (`apps/orchestrator/src/lib/internal-tls.ts`),
the Python helper (`services/_shared/internal_tls.py`), and the bash issuer:

| Env var | Default | Meaning |
|---|---|---|
| `DROPLET_INTERNAL_TLS` | `0` | `1` enables HTTP/gRPC mTLS enforcement |
| `DROPLET_TLS_CERT` | `/data/service-tls/cert.pem` | service cert (server + client) |
| `DROPLET_TLS_KEY` | `/data/service-tls/key.pem` | service private key |
| `DROPLET_TLS_CA` | `/data/service-tls/ca.pem` | internal CA cert (trust anchor) |

MQTT TLS is keyed off the broker URL scheme (`mqtts://`), NOT off
`DROPLET_INTERNAL_TLS`, so the MQTT migration (WARP-235) stands alone.

## Issuance API (bash, sourced)

- `internal_ca_ensure` — mint CA iff absent (idempotent).
- `internal_ca_issue <service> [extra-sans]` — issue/renew a bundle. Always
  includes `DNS:<service>,DNS:localhost,IP:127.0.0.1`; `extra-sans` is a
  comma-separated list of additional `DNS:`/`IP:` entries. Renews when missing or
  expiring within 30 days; `--force` via `INTERNAL_CA_FORCE=1`.
- `internal_ca_issue_all [gateway_ip]` — issues the canonical service list;
  host-net services add `DNS:host.docker.internal` (+ single-box bridge-gateway
  IP). The Postgres/Redis workstream extends `INTERNAL_CA_SERVICES` / calls
  `internal_ca_issue db`, `internal_ca_issue cache`.

## MQTT broker (WARP-235)

Single mosquitto listener on **:8883** with `require_certificate true` +
`use_identity_as_username true` — the TLS-verified certificate CN **is** the
MQTT username. There is no password file and no plaintext listener; the shared
`MQTT_PASSWORD` is retired (stale keys in old `.env`s are unread). The broker
publishes **127.0.0.1:8883** on the host so host-network services
(camera-discovery) can connect; it is never bound on LAN interfaces.

`docker/mosquitto.conf` and `docker/mosquitto.acl` are tracked in git AND
regenerated byte-identically by `scripts/lib/secrets.sh`
(`_write_mosquitto_conf` / `_write_mosquitto_acl`) so an on-box
`--sync-secrets` never dirties the checkout — parity is pinned by
`tests/mosquitto-conf.test.sh`.

### Per-CN topic grants (deny-by-default)

| CN (identity) | Grants | Why (real topics on main) |
|---|---|---|
| `orchestrator` | `readwrite droplet/#`, `read frigate/#`, `read email/#` | publishes `droplet/files/<user>/*`, `droplet/devices/<user>/*`, `droplet/notifications/<user>`, `droplet/chat/<user>/*`, `droplet/device/state`, `droplet/transcription/run-one`; subscribes the same trees plus `frigate/events`, `frigate/+/status`, `droplet/cameras/discovered`, `droplet/index/+/*`; `email/#` is pre-granted for the dashboard email-refresh bridge |
| `file-indexer` | `write droplet/index/+/{indexed,deleted}`, `write droplet/files/+/brain/indexed`, `write droplet/context-stats/invalidate`, `read droplet/files/brain/uploaded`, `read droplet/transcription/run-one` | watcher + brain-ingest + transcription pipelines |
| `email-indexer` | `write email/+/new` | one publish per ingested mail |
| `camera-discovery` | `write droplet/cameras/discovered` | discovery events over the loopback listener |
| `frigate` | `readwrite frigate/#` | events, per-camera status, LWT `frigate/available`, `frigate/<cam>/<control>/set` command topics |

A publish outside a CN's grant is dropped server-side (QoS-0 publishers get no
error — verify delivery, not exit codes). `droplet/audit/*` is never granted:
the audit log is HTTP + HMAC-chained rows, not MQTT.

### Adding a new MQTT client

1. Add the CN to `INTERNAL_CA_SERVICES` in `scripts/lib/internal-ca.sh`.
2. Grant its topics in **both** `docker/mosquitto.acl` and the
   `_write_mosquitto_acl` heredoc in `scripts/lib/secrets.sh` (byte-identical).
3. Mount its bundle in `docker-compose.yml`:
   `- ../data/secrets/service-tls/<service>:/data/service-tls:ro`.
4. Point the client at `mqtts://broker:8883` (scheme-gated helpers:
   `mqttConnectOptions` in TS, `paho_configure` in Python).
5. Run `./scripts/setup.sh --sync-secrets`.

### MQTT rotation / revocation

```
./scripts/rotate-internal-certs.sh --service broker \
  --service orchestrator --service file-indexer --service email-indexer \
  --service camera-discovery --service frigate --deploy
```

The broker restart drops all live MQTT sessions; clients auto-reconnect with
fresh material (the orchestrator/file-indexer re-subscribe on connect — the
IDX-06 replay path). Emergency revocation is the same CA rebuild as HTTP
(`--rebuild-ca --deploy`): old certs stop validating when the broker restarts
with the new `ca.pem` — proven by the rogue-CA and cert-removal probes in
`tests/mqtt-mtls.integration.test.sh`.

**Broker key permissions (WARP-185 lineage):** mosquitto runs as uid 1883, so
`internal_ca_issue broker` chowns `key.pem` to 1883 or falls back to 0644
inside the 0700 `data/secrets` tree — the same readability constraint that
shaped the old passwd-file handling.

## Runbook

### Routine rotation (quarterly or on demand)

```
./scripts/rotate-internal-certs.sh --all --deploy
```

On single-box, add the bridge-gateway IP so host-net service SANs stay valid:

```
./scripts/rotate-internal-certs.sh --all --deploy \
  --gateway-ip "$(docker network inspect droplet_default \
    -f '{{(index .IPAM.Config 0).Gateway}}')"
```

Certs are 90-day. `setup.sh --sync-secrets` also auto-renews anything inside the
30-day window on every run.

### Single-service rotation

```
./scripts/rotate-internal-certs.sh --service ai-gateway --deploy
```

### Emergency revocation (compromised service key)

There is no CRL in a single-box CA — revocation is key rollover:

```
./scripts/rotate-internal-certs.sh --rebuild-ca --deploy
```

This deletes and re-mints the CA, reissues every bundle, and rolling-restarts the
services. Old certs stop validating the moment each server process restarts with
the new `ca.pem`. Existing MQTT sessions die on broker restart.

### Verify a handshake

```
openssl s_client -connect localhost:8883 \
  -CAfile data/secrets/internal-ca/ca.pem \
  -cert data/secrets/service-tls/orchestrator/cert.pem \
  -key  data/secrets/service-tls/orchestrator/key.pem
```

handshakes; the same command WITHOUT `-cert/-key` must fail (certless peer
rejected). Substitute any first-party server port to spot-check that hop.
