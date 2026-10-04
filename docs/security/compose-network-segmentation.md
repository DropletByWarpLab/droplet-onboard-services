# Compose network segmentation: edge, app, data, untrusted (WARP-3623)

Status: design only, nothing implemented. Decision needed (see "Open decisions").

All first-party containers except one share a single compose bridge
(`droplet_default`). This note describes how to split it into purpose networks
without changing any service name or port, one network and one service group at
a time. Compose cannot prove service discovery still works after a split, so
every step ends with a box test and a one-line rollback. Nothing here is safe to
ship by reading alone.

## Current state

Verified by reading `docker/docker-compose.yml` (service blocks located by name,
not line, because several open changes edit the file):

- One top-level network exists: `droplet-internal` with `internal: true`
  (WARP-2895). Members: `sandbox` (only that network) and `orchestrator` (both
  `default` and `droplet-internal`). Extension containers added by an OTA override
  join exactly `[droplet-internal]` (`apps/orchestrator/src/services/update-agent/extension-fragment.ts`
  lines 75, 125, 500). `scripts/test-security.sh` Tests 14b and 14c pin the sandbox
  posture and reserve the `ext-*` name space.
- Every other bridge service has no `networks:` key, so it is on the implicit
  `default` network (project name `droplet`, so `droplet_default`).
- Seven services use `network_mode: host`: `routing`, `matter-controller`, `switch`,
  `camera-discovery`, `oled-display`, `samba`, `cloudflared`. They are reached from
  bridge containers through `host.docker.internal` (`extra_hosts: host-gateway`) on the
  orchestrator, mcp-server, ai-gateway and rag-eval blocks.
- Host ports: `gateway` 80/443 (the only public listener); loopback-only publishes for
  `broker` (8883), `frigate` (5000), `ops-console` (8089), `ollama`, `dmr`, `dmr-cuda`,
  `openwrt` (8181).
- `dmr-cuda` already declares `networks: default: aliases: [dmr]`.
- Host tooling names the network explicitly and must keep working:
  `scripts/lib/single-box.sh` (`bridge_net="droplet_default"`, resolves its gateway IP),
  `scripts/host/usr-local-sbin/droplet-egress-audit` (`DROPLET_EGRESS_NETWORK=droplet_default`),
  `scripts/host/usr-local-sbin/droplet-openwrt-attach` (fixed `172.18.0.10/16`, gateway
  `172.18.0.1` on the bridge), and the internal-CA SANs that include the bridge-gateway IP
  (`scripts/lib/internal-ca.sh`). `RATE_LIMIT_TRUSTED_PROXIES` on `ai-gateway` is documented
  as "nginx's IP or subnet", so a subnet change affects it.

Caller to callee map (from `environment:` entries, code defaults and
`docker/nginx/nginx.conf` upstream variables; not exhaustive for optional profiles):

| Caller | Callees (service:port) |
|---|---|
| gateway (nginx) | orchestrator:3000, ai-gateway:8000, web-dashboard:3001, nextcloud:80, docserver:9980 |
| orchestrator | db:5432, cache:6380, broker:8883, ai-gateway:8000, nextcloud:80, frigate:5000, sandbox:8030, inference-manager:8002, rag-eval:8090, file-indexer:8090, web-fetch:8010, doc-render:8020, mcp-bridge:9096, email-indexer:8086, voice-io:8086, erp-sql-bridge:9095, host services via host.docker.internal (routing 8080, switch 8081, display 8082, camera 8085, matter 8083) |
| mcp-server | db, cache, orchestrator:3000, host services |
| ai-gateway | cache:6380, orchestrator:3000 (off-LAN gate reads), inference-manager:8002, model runtime (`ollama`/`dmr`, or host) |
| file-indexer | db:5432, broker:8883, ai-gateway:50051 |
| email-indexer | db:5432, orchestrator:3000, internet (IMAP) |
| rag-eval | orchestrator:3000, db (extraction canary), model runtime |
| voice-io | orchestrator:3000, wyoming-faster-whisper:10300, wyoming-piper:10200 |
| nextcloud | db:5432, cache:6380, docserver (WOPI callback target) |
| docserver | nextcloud:80 |
| ops-console | orchestrator:3000, ai-gateway:8000, voice-io:8086, frigate:5000, web-dashboard:3001, docker socket |
| inference-manager | dmr:12434 |
| host-network services | broker via `127.0.0.1:8883`, orchestrator via the bridge gateway |
| sandbox, extension containers | orchestrator only (over `droplet-internal`) |

## Target state

Add networks; keep `default` as the app network. Renaming or removing `default`
would break the host tooling listed above, the fixed OpenWrt address and the internal-CA
SANs, so it is out of scope.

| Network | Members | Properties |
|---|---|---|
| `edge` (new) | gateway, web-dashboard, orchestrator, ai-gateway, nextcloud, docserver | the only network the gateway joins besides none; the gateway no longer shares a segment with data stores or sidecars |
| `default` (existing, the app network) | every first-party service that is not data or untrusted | unchanged name, subnet and egress |
| `data` (new, `internal: true`) | db, cache, broker, plus each client that connects to them (orchestrator, mcp-server, ai-gateway, file-indexer, email-indexer, rag-eval, nextcloud) | no route off the host; stores cannot be reached from sidecars that do not need them |
| `droplet-internal` (existing, the untrusted network) | sandbox, extension containers, orchestrator | unchanged; kept under its current name because the extension serializer pins it |

Notes on the design:

- A service attached to several networks is reachable by name from each; Docker does not route between
  networks. A service with a `networks:` key joins only those listed, so `default` must be listed
  explicitly everywhere (already called out in the orchestrator block).
- `broker` also publishes `127.0.0.1:8883` for host-network clients; that path is host loopback and does
  not depend on bridge membership.
- Egress is not part of this split. `default` keeps NAT egress for the services that need the internet
  (web-fetch, mcp-bridge, email-indexer, ai-gateway cloud providers, fleet-agent, orchestrator for
  issuance and OTA). Restricting egress per service is a follow-up that builds on the network list and on
  `docs/security/allowed-egress.yaml`.
- Overlap with WARP-3454 (guest Wi-Fi reaching container addresses) is partial: segmentation limits
  container-to-container reach; reaching the bridge from the LAN or guest side is a host firewall
  question tracked there.

## Migration (one network, one service group at a time)

Each change is an additive `networks:` list on named services. Rolling out one group means
editing only that group's blocks; rolling back means reverting those blocks and recreating them.
Never `docker network rm` as part of a step (a leftover network is harmless).

### Step 0. Inventory on a running box (no change)

- `docker network inspect droplet_default` (service-to-IP list) and, for 24 h, connection logs per
  service (`ss -tn` inside each container, or the gateway and ai-gateway logs), to confirm the table above
  against real traffic. Add any edge the table missed (for example a service reading a URL from `.env`).
- Test on box: the observed pairs are a subset of the table, or the table is updated before step 1.

### Step 1. Declare the new networks (no service attached)

- Add top-level `edge` and `data` (the latter `internal: true`) and nothing else.
- Test on box: `docker compose config` renders; `docker compose up -d` creates the networks and recreates no
  container (`docker compose ps` start times unchanged); the host tooling still finds `droplet_default`.
- Breaks: only a compose syntax error, which fails `config` before anything changes. Roll back: revert the hunk.

### Step 2. Data network, one store at a time: cache, then broker, then db

- Attach `cache` to `[default, data]` and add `data` to each of its clients (orchestrator, mcp-server,
  ai-gateway, nextcloud), keeping `default`. At this point both networks reach it; nothing is removed.
- Test on box: every client healthy after a recreate; Redis ACL identities still authenticate (login as a
  member, a chat turn, a file upload); `docker exec <client> getent hosts cache` resolves on both networks.
- Repeat for `broker` (file-indexer, orchestrator) and `db` (orchestrator, mcp-server, file-indexer,
  email-indexer, rag-eval, nextcloud). Treat `db` last: its clients start and migrate at boot.
- Breaks: a client missing from the list cannot resolve the store and crash-loops or reports degraded health.
  Roll back: revert that service's `networks:` and recreate it.

### Step 3. Remove stores from `default`

- After step 2 has run for one full release on stage, change each store from `[default, data]` to `[data]`.
  This is the step that actually isolates it; do one store per release.
- Test on box: from a sidecar that must not reach the store (for example `web-fetch`),
  `getent hosts db` fails and a connect attempt times out; all intended clients stay healthy;
  an OTA apply (which recreates services in a defined order, `docker/ota/apply-update.sh`) completes and rolls
  back cleanly, because the rollback walk recreates services one at a time.
- Breaks: an unlisted client; a host-network service that was resolving `db` through the bridge gateway
  (verify none does); `docker exec ... psql` from the host is unaffected (unix socket). Roll back: re-add `default`.

### Step 4. Edge network

- Attach gateway to `edge` only (plus `default` until verified), and `edge` to its five upstreams
  (orchestrator, ai-gateway, web-dashboard, nextcloud, docserver). The nginx upstreams are resolved at request time
  through Docker DNS (`docker/nginx/nginx.conf` header comment), so no nginx change is needed.
- Test on box: dashboard loads over HTTPS, login, WebSocket features, file upload and download through
  `/nextcloud/`, document edit through `/docs/`, `/ai/` streaming chat; then remove `default` from the gateway and repeat.
- Breaks: the gateway returns 502 for the missed upstream; certificate reload or the canonical-host logic is
  unaffected. Roll back: put `default` back on the gateway.
- Side effect to check: `RATE_LIMIT_TRUSTED_PROXIES` for ai-gateway must name the gateway's address on whichever network
  reaches it; if it is unset today this is a no-op, if set, update it in the same change.

### Step 5. Guard rails

- Add a `scripts/test-security.sh` test that parses the compose file and asserts: `db`, `cache`, `broker` are on `data` only (and
  `data` is `internal: true`); the sandbox stays on `droplet-internal` only; no service other than the allowlisted clients is on `data`;
  `gateway` has no `data` membership. Mutation check as in Tests 14b and 22.

## Open decisions for Romain

1. Accept keeping the name `default` (and subnet) for the app network, with `edge` and `data` additive? Renaming is a large
   host-tooling change (single-box.sh, egress audit, OpenWrt attach) with no security gain.
2. Should `data` be `internal: true`? It blocks any store from initiating outbound traffic (Postgres and Redis do not need it);
   the cost is that a future image pull hook or extension inside `db` cannot reach the internet.
3. Stage soak length per step: one full stage release each (proposed) or batched?
4. Should the untrusted network later also host web-fetch and doc-render (parsers of untrusted content), or stay on `default`
   with per-service egress rules?

## Related

WARP-3623 (this), WARP-3454 (guest Wi-Fi reaches compose addresses), WARP-1375 (network exposure of internal services),
WARP-2565 (internal TLS default), WARP-3588 (per-service environment), WARP-3656 (container hardening baseline),
WARP-3578 (orchestrator socket removal), WARP-2895 (internal sandbox network), WARP-3590 (database roles).
