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

- **Servers** — every first-party listener (orchestrator HTTPS :3000, the
  FastAPI/uvicorn services, ai-gateway gRPC :50051, matter-controller :8083,
  Mosquitto :8883) requires and verifies a CA-signed client cert on every
  connection. All are wired as of WARP-1061 (flag-gated except Mosquitto,
  which is live/scheme-gated) — see the enforcement matrix.
- **Clients** (undici fetch, httpx, paho, mqtt.js, grpc, nginx `proxy_ssl_*`,
  and the host-side urllib/curl callers) present their own bundle and pin
  trust to the internal CA. All first-party hops are wired (flag-gated).
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
   posture: nextcloud/docserver (nginx-fronted user plane), the inference runtime (dmr :12434 by default, ollama :11434 when opted in)
   (bridge-internal, ai-gateway-only caller), wyoming whisper/piper (raw Wyoming
   TCP, no TLS support), frigate HTTP :5000 (loopback-published). frigate DOES
   get an MQTT client cert (its MQTT config supports client certs). mcp-server's
   inbound :9090 stays JWT-gated (off-stack consumers); it becomes an mTLS
   *client* toward the orchestrator. web-dashboard inbound stays plain HTML to
   nginx (holds no service secrets; the browser is the real client).
5. WARP-235 removes the password listener entirely (single mTLS listener :8883).
   The dev compose stack keeps its own anonymous 1883 broker — untouched.

## Enforcement matrix (implemented — WARP-1061)

Every row below is wired end-to-end (client presents its bundle AND the
server requires a CA-signed client cert) and gated on `DROPLET_INTERNAL_TLS`
(default `0` = plaintext, byte-identical to the pre-mTLS posture). "impl."
notes which ticket landed the last missing half.

| # | Client → Server | Transport | Flag off | Flag on | impl. |
|---|---|---|---|---|---|
| 1 | nginx gateway → orchestrator :3000 (`/api/`, `/api/ws/`) | `proxy_pass` | plain | mTLS (gateway client cert, `proxy_ssl_verify` CA-pinned) | 1061 |
| 2 | nginx gateway → ai-gateway :8000 (`/ai/`) | `proxy_pass` | plain | mTLS (gateway client cert) | 1061 |
| 4 | orchestrator → ai-gateway :8000 | undici fetch | bearer | mTLS + bearer | 236/1061 |
| 5 | mcp-server → orchestrator :3000 | undici fetch | bearer | mTLS + bearer | 236 |
| 6 | voice-io → orchestrator :3000 | httpx | bearer | mTLS + bearer | 236 |
| 7 | email-indexer → orchestrator :3000 | httpx | bearer | mTLS + bearer | 236 |
| 8 | rag-eval → orchestrator :3000 (ragas runner) | urllib | admin route | mTLS | 1061 |
| 9 | orchestrator → rag-eval :8090 | undici fetch | none | mTLS | 236/1061 |
| 10 | orchestrator → voice-io :8086 | undici fetch | none | mTLS | 236/1061 |
| 11 | orchestrator → routing :8080 / switch :8081 / oled :8082 / matter :8083 | undici fetch | bearers | mTLS + bearer | 236/1061 |
| 12 | mcp-server → routing :8080, switch :8081, camera-discovery :8085 | undici fetch | bearers | mTLS + bearer | 236/1061 |
| 13 | switch → routing; camera-discovery → routing | httpx | token | mTLS + token | 1061 |
| 14 | routing → orchestrator :3000 (throughput sampler + off-LAN egress meter + DNS-block meter) | httpx | bearer | mTLS + bearer | 236/1061 |
| 15 | ops-console → mesh probes (orchestrator, ai-gateway, voice-io, routing, switch, file-indexer, camera-discovery) | httpx | URLs | mTLS | 236/1061 |
| 16 | file-indexer → ai-gateway :50051 (gRPC embed) | grpc | insecure | gRPC mTLS (`require_client_auth`) | 1061 |
| 17 | orchestrator → file-indexer :8090 (health + admin reindex) | undici fetch | none | mTLS | 1061 |
| 18 | orchestrator → camera-discovery :8085 (scan, drivers) | undici fetch | device secret | mTLS + bearer | 1061 |
| 19 | ai-gateway → orchestrator :3000 (off-LAN posture read) | httpx | bearer | mTLS + bearer | 1061 |
| 20 | egress-audit collector (host) → orchestrator :3000 | urllib | bearer | mTLS + bearer (host `egress-audit` identity) | 1061 |
| 21 | device-bridge (host) → orchestrator `/api/health` | urllib | none | mTLS (host `device-bridge` identity) | 1061 |
| 22 | droplet-shutdown-screen.sh (host) → oled-display :8082 | curl | bearer | mTLS + bearer (`device-bridge` identity) | 1061 |
| 23 | operator CLIs — `droplet-admin device-identity`, `scripts/verify.sh` mesh probes | curl | bearer/none | mTLS (host `host-admin` identity) | 1061 |

**Container healthchecks** follow the same contract: the orchestrator's
compose healthcheck runs the cert-presenting `dist/healthcheck.js`
(WARP-236 client, wired by WARP-1061), and the voice-io / rag-eval image
HEALTHCHECKs run the shared cert-presenting client
(`services/_shared/healthcheck.py`). Every healthcheck is plain HTTP when the
flag is off.

### Documented exemptions (stay plaintext with the flag on)

| Surface | Why exempt |
|---|---|
| ops-console inbound :8087 | loopback-published for the operator's tunneled BROWSER, which cannot present internal client certs; bearer token + 127.0.0.1 bind + reverse tunnel are the gate. It IS an mTLS *client* for its mesh probes (row 15) — the probe rewrite is scoped to the mesh registry names so exempt targets are never probed over TLS. |
| mcp-server inbound :9090 | JWT-gated surface for OFF-stack consumers (droplet-local-LLM, Claude Desktop) that hold no internal identity. It is an mTLS *client* toward the orchestrator/routing/switch (rows 5, 12). |
| nginx → web-dashboard :3001 / nextcloud / docserver | user plane; holds no service secrets — the browser is the real client and the gateway terminates the public TLS. |
| device-bridge inbound :9090 (host) | loopback-bound host listener (BRIDGE_BIND=127.0.0.1) with its own bearer; a host python stdlib server with no TLS listener support worth adding. Orchestrator → bridge calls stay plain http on the host-gateway leg. Loopback-only ⇒ acceptable per the WARP-1061 host-caller policy. |
| orchestrator → frigate :5000, device-bridge :9090, nextcloud WebDAV, HQ issuance | third-party / host / WAN surfaces outside the compose mesh (frigate is loopback-published; HQ is public TLS). |
| ai-gateway → the inference runtime (dmr :12434 default / ollama :11434 opt-in), ollama-manager; voice-io → wyoming STT/TTS | third-party engines: bridge-internal or raw-TCP protocols with no/immaterial TLS support. |
| orchestrator → device-identity-svc | Unix socket, filesystem-scoped — no network hop to encrypt. |
| db :5432 / cache :6380 / broker :8883 | already TLS under their own workstreams (WARP-233/234/235); not keyed on this flag (MQTT is scheme-gated). |

### Host-caller decisions (WARP-1061 stage 3)

Host-side (non-compose) callers get real client certs — none of them is
LAN-crossing, but every one of them dials a listener that REQUIRES a client
cert once the flag is on, so a "loopback plaintext exemption" was only
possible for *listeners* (see the exemptions table), never for callers of
the mesh. Three host identities are issued by `internal_ca_issue_all` into
`data/secrets/service-tls/<name>/`:

| Identity | Consumers | Delivery |
|---|---|---|
| `egress-audit` | droplet-egress-audit.service anomaly POSTs | `/usr/local/sbin/droplet-egress-audit` greps `DROPLET_INTERNAL_TLS` from the repo `.env` and exports the `DROPLET_TLS_*` contract pointing at the bundle |
| `device-bridge` | device-bridge.py `/api/health` read; droplet-shutdown-screen.sh → oled :8082 | `install-device-bridge.sh` mirrors the knob (unconditionally — flips must propagate) + seeds the bundle paths into `/etc/droplet/device-bridge.env` |
| `host-admin` | `droplet-admin device-identity {status,reseal}`, `scripts/verify.sh` direct mesh probes | read straight from the repo tree (`REPO_ROOT/data/secrets/service-tls/host-admin`); flag from env or the repo `.env` |

### Wiring status (WARP-1061 — end-to-end, dormant by default)

- **Live everywhere:** the internal CA + per-service bundle
  issuance/rotation, Postgres TLS (WARP-233), Redis TLS (WARP-234), MQTT
  mTLS :8883 (WARP-235, scheme-gated, always on).
- **Wired and flag-gated (everything in the matrix):** flipping
  `DROPLET_INTERNAL_TLS=1` + recreating the stack turns every row on
  together. `scripts/setup.sh` writes the knob (default `0`) into fresh
  `.env`s and backfills it on upgrades; nothing ships with it on.
- The harness check `transit.mesh.plain-http-refused` (WARP-966) tracks the
  observable posture on a live box and passes only where an operator has
  enabled the flag. Live-box enablement validation (real hardware, full
  profile set) is the remaining follow-up — the wiring itself is complete.

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

### Enabling internal mTLS on a box (WARP-1061)

Default posture is OFF — a box that never touches the knob keeps today's
plaintext mesh byte-for-byte. To enable:

```
./scripts/setup.sh --skip-build --skip-docker   # issue/refresh ALL bundles,
                                                # incl. the host identities
# set DROPLET_INTERNAL_TLS=1 in .env (keep the file chmod 600)
docker compose -f docker/docker-compose.yml --env-file .env build
docker compose -f docker/docker-compose.yml --env-file .env up -d --force-recreate
sudo ./scripts/install-device-bridge.sh          # mirror the knob + bridge certs
sudo systemctl restart droplet-egress-audit.service droplet-device-bridge.service
./scripts/verify.sh                              # probes present certs when on
```

The image rebuild matters once per upgrade to WARP-1061 images (the Python
services' CMD moved to the TLS-aware launcher); after that a flag flip only
needs the `up -d --force-recreate` so every container re-reads the knob.
Roll back by setting the knob to `0` and recreating — no certs are removed.

Spot-check a hop (certless peer must be refused):

```
docker compose exec gateway curl -s --cacert /etc/nginx/service-tls/ca.pem \
  --cert /etc/nginx/service-tls/cert.pem --key /etc/nginx/service-tls/key.pem \
  https://orchestrator:3000/api/orchestrator/health          # 200
docker compose exec gateway curl -sk https://orchestrator:3000/api/orchestrator/health
                                                             # TLS alert — no client cert
```

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
