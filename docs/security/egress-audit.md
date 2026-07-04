# Runtime egress audit (WARP-268)

Every outbound network flow from any container on the single-box is traced and
logged with `(source service, destination, port, bytes, timestamp,
allowed-policy)`. DNS queries are logged with their query names. Flows that do
not match the static allowlist (`docs/security/allowed-egress.yaml`, owned by
the parallel **WARP-269** CI-gate workstream) are flagged as **anomalies** into
the signed activity log (WARP-456/181/246 chain) and are therefore visible on
`/admin/audit`.

This is the **runtime half** of the "telemetry-free" invariant.
`THREAT_MODEL.md` T6.8 names WARP-268 as "the one egress class not yet
audited" (cloud-LLM/BYOK egress); T6.4 (telemetry exfiltration) is mitigated by
the same allowlist consumed here plus WARP-269's CI gate. Enforcement stays
with WARP-269 (CI gate) and the ADR-012 firewall work — **this ticket is audit,
not enforcement.**

The collector is a host-side systemd unit (`droplet-egress-audit.service`), not
a compose service. Source: [`services/egress-audit/`](../../services/egress-audit/).

## Why this datapath ("host owns the WAN")

`docs/SINGLE_BOX.md` (§ near line 236): the containerized OpenWrt "has no `wan`
logical interface (the host owns the WAN)". Container egress does **not** route
through the OpenWrt container — all compose services sit on the default bridge
network of the pinned project name `droplet` (Docker network `droplet_default`,
typically `172.18.0.0/16`) and are masqueraded out the host's WAN interface.

The host's **conntrack table therefore sees every container-outbound flow**,
and the **pre-NAT origin tuple preserves the container source IP**. That is the
single interposition point we need, with **zero datapath changes** — no new
nftables/iptables rules, nothing in Docker's firewall path.

```
┌─ host (Debian) ────────────────────────────────────────────────────────────┐
│  droplet-egress-audit.service (systemd, root, hardened)                     │
│    /usr/local/sbin/droplet-egress-audit (launcher: sysctl acct=1, env)      │
│    /usr/local/lib/droplet-egress-audit/*.py  ← services/egress-audit/       │
│      conntrack -E -e NEW,DESTROY -o timestamp ──► conntrack_parse ─┐        │
│      tcpdump -i any -U -w - udp port 53 ──► dns_wire (pcap+DNS) ───┤        │
│      docker network inspect droplet_default + ip -j addr ─► attribution     │
│      docs/security/allowed-egress.yaml (WARP-269) ─► allowlist      │        │
│                                                    ▼                        │
│      Pipeline ─► NDJSON /var/lib/droplet/egress-audit/egress-YYYYMMDD.ndjson│
│               └► anomalies ─► POST http://127.0.0.1:3000                    │
│                               /api/security/egress-anomaly                  │
│                               (Bearer SERVICE_TOKEN_EGRESS_AUDIT)           │
└─────────────────────────────────────────────────────────────────────────────┘
   orchestrator: routes/egress-audit.ts ─► recordActivity(kind "network",
   severity "warn") ─► signed ActivityRow chain ─► /admin/audit (kind filter
   "network" — dashboard shows it with zero UI changes)
```

The collector's only kernel-facing surface is two spawned standard Debian tools
(`conntrack` from `conntrack-tools`, `tcpdump`); everything we own is pure
parsing + matching over their outputs (conntrack line format, pcap stream, DNS
wire format, docker JSON), which makes the entire logic unit-testable on a dev
Mac with recorded fixtures.

### Why not the alternatives

| Option | Why not |
|---|---|
| **nftables NFLOG (+ ulogd2 / custom reader)** | Logs packets not flows (byte totals still need conntrack accounting); ulogd2 is a second config surface and can't extract DNS QNAMEs; custom NFLOG rules fight Docker's iptables-nft management; a Python NFLOG reader needs unmaintained cffi bindings. |
| **conntrack polling (`conntrack -L` on a timer)** | Misses short-lived flows (a telemetry POST can open+close within one tick). The event stream (`-E -e NEW,DESTROY`) sees every start and end; DESTROY carries the byte counters. Strictly better, same tool. |
| **Per-container egress proxy** | Strongest *enforcement*, but changes every service's datapath (proxy env vars honored inconsistently; breaks non-HTTP protocols). This ticket is audit, not enforcement. |
| **eBPF (bcc/libbpf, Tetragon, Tracee)** | Per-*process* visibility we don't need (per-container suffices; the bridge IP already provides it), at the cost of heavy toolchains (BTF/kernel headers, LLVM, or a >100 MB agent) on a RAM-budgeted appliance (ADR-021). Cilium is Kubernetes-native — N/A. |

## Record schema (NDJSON, v1)

One JSON object per line, keys sorted, under
`/var/lib/droplet/egress-audit/egress-YYYYMMDD.ndjson` (one file per **UTC**
day, **30-day** retention, pruned on day-roll). NDJSON is the primary record of
truth — **every** flow lands here regardless of allowlist state or orchestrator
reachability.

| Field | Type | Present on | Meaning |
|---|---|---|---|
| `v` | int | all | Record schema version (`1`). |
| `event` | string | all | `flow_start` \| `flow_end` \| `dns_query`. |
| `ts` | float | all | Epoch seconds (conntrack `-o timestamp`, or DNS packet time). |
| `service` | string | all | Attributed compose service, or `host` (host-netns aggregate), or `unknown-container`. |
| `src` | string | all | Container/host source IP (pre-NAT origin tuple). |
| `dst` | string | all | Destination IP. |
| `dst_name` | string | flow_* when a DNS answer was observed | Hostname the IP resolved to (from the IP→name cache). |
| `proto` | string | all | `tcp` \| `udp` \| … |
| `port` | int | all | Destination port. |
| `bytes_out` | int | `flow_end` (with `nf_conntrack_acct=1`) | Origin-direction bytes. |
| `bytes_in` | int | `flow_end` | Reply-direction bytes. |
| `allowed` | bool | flow_* when allowlist available | `true` matched a rule, `false` unlisted. **Omitted** when allowlist unavailable. |
| `policy` | string | flow_* | Matched `AllowRule.key`, or `allowlist-unavailable`. Omitted when `false`/no match. |
| `qname` | string | `dns_query` | Queried name (lowercased, no trailing dot). |

`flow_start` is emitted on conntrack `NEW`, `flow_end` on `DESTROY` (which
carries the byte counters). For long-lived flows, byte totals are only known at
flow end — a documented v1 limitation (see below).

## Expected `allowed-egress.yaml` schema — **SYNC NOTE TO WARP-269**

This collector **consumes** `docs/security/allowed-egress.yaml`. **That file is
owned and created by WARP-269** (telemetry-free-invariant CI gate); this PR does
**not** create it (only a test fixture,
`services/egress-audit/tests/fixtures/allowed-egress.sample.yaml`, mirrors the
schema). The schema below **must stay in sync** with the WARP-269 CI-gate spec —
reconciled by the orchestrating session. On any schema mismatch the collector
**fails soft** (tags records `allowlist-unavailable` + emits one
`allowlist_unavailable` anomaly), never crashes.

```yaml
schema_version: 1
entries:
  - service: ai-gateway            # compose service name, or "host" (host-netns aggregate)
    destination: api.anthropic.com # hostname | "*.suffix" wildcard | IP | CIDR
    port: 443                      # 1-65535 | "any"
    protocol: tcp                  # tcp | udp | any
    purpose: BYOK cloud LLM calls (user-initiated)   # required, human-readable
    ticket: WARP-268               # required, provenance
```

Matching semantics:

- `service` — exact match (no wildcard service in v1).
- `destination` as CIDR/IP ⇒ `dst_ip ∈ network`; as `*.suffix` ⇒ any
  DNS-observed name for `dst_ip` ends with `.suffix` (the leading dot enforces
  the label boundary, so `evilopenai.com` does **not** match `*.openai.com`); as
  a bare hostname ⇒ exact match against DNS-observed names.
- Hostname matching depends on the collector having seen the DNS **answer**
  (IP→name cache, TTL-bounded, floor 300 s). A hostname-allowlisted destination
  reached **without** an observable DNS resolution (hardcoded IP, DoH) **will
  flag** — that is a feature, not a bug: DoH/hardcoded-IP egress *should* be
  reviewed and CIDR-allowlisted explicitly.

## Anomalies

| Kind | Trigger | Where it lands |
|---|---|---|
| `unlisted_destination` | A traced flow does not match any allowlist rule. | `/admin/audit`, kind `network`, severity `warn`, `sub = unlisted_destination`, `what = "Egress anomaly: <service> → <dst>:<port>"`, full anomaly payload in `refs`. |
| `allowlist_unavailable` | Allowlist file missing / unparseable / unsupported `schema_version`. | Same, `what = "Egress audit: allowed-egress.yaml unavailable — flows unclassified"`. |

Anomalies POST to the orchestrator's `POST /api/security/egress-anomaly`
(service-principal bearer). The orchestrator records each via `recordActivity`
into the **signed activity log** — no new table, no dashboard change; the
existing `/admin/audit` "network" kind filter renders them, and
`GET /api/activity/verify` continues to pass (chain integrity preserved).

To keep the signed chain from repeat-flow spam, the collector **dedups
client-side** (`AnomalyGate`, **1 h cooldown** per `(kind, service, dst, port,
proto)` tuple) before POSTing. The NDJSON keeps every record regardless.

**Fail-soft shipping:** orchestrator down ⇒ warn-once, keep logging locally,
suppress repeat warnings until recovery; a missing `SERVICE_TOKEN_EGRESS_AUDIT`
⇒ anomalies stay local-only (NDJSON unaffected).

## Known v1 limitations

1. **Host-netns services attribute as `host` (aggregate).** Services running
   `network_mode: host` (routing, matter-controller, switch, camera-discovery,
   oled-display, cloudflared) egress from the host's IPs → labelled `host`.
   Notably **cloudflared's tunnel egress shows as `host`.** Per-process split is
   a follow-up ticket.
2. **QNAME visibility is host-aggregate.** Bridge containers resolve via
   Docker's embedded DNS (`127.0.0.11`); dockerd forwards upstream from the host
   netns, so per-container QNAME attribution is structurally impossible without
   changing the DNS datapath. Upstream queries give box-wide QNAME visibility
   (attributed `host`). A container talking **directly** to an external resolver
   (DNS bypass) *is* per-container attributable and surfaces as an
   `unlisted_destination` anomaly unless allowlisted.
3. **DNS parse is UDP-only in v1.** The stub resolvers and dockerd's forwarder
   use UDP; DNS-over-TCP fallback is rare enough to defer.
4. **Bytes only at flow end for long-lived flows** — the conntrack DESTROY
   event carries the counters.
5. **Hostname allowlist rules require an observed DNS answer** (see matching
   semantics) — hardcoded-IP / DoH egress to an allowlisted name flags by
   design.

## Operations

- **Status / logs:** `systemctl status droplet-egress-audit --no-pager`,
  `journalctl -u droplet-egress-audit`.
- **NDJSON:** `/var/lib/droplet/egress-audit/egress-YYYYMMDD.ndjson`.
- **Rotate the token:** change `SERVICE_TOKEN_EGRESS_AUDIT` in `.env`, then
  restart the orchestrator **and** `droplet-egress-audit.service`.
- **Knobs:** `/etc/default/droplet-egress-audit`
  (`DROPLET_EGRESS_ORCHESTRATOR_URL`, `DROPLET_EGRESS_LOG_DIR`,
  `DROPLET_EGRESS_NETWORK`, `DROPLET_EGRESS_ALLOWLIST`) — install-if-absent, so
  operator edits survive `setup.sh` re-runs.
- **Posture defaults:** severity `warn`, 1 h anomaly dedup cooldown, 30-day
  NDJSON retention — all env/constructor-tunable.

### Stack verification (requires the Linux box — not CI-runnable)

macOS dev machines have no conntrack/nftables and CI has no docker-in-docker
privileges, so the live datapath is verified on the single-box after
`./scripts/setup.sh`:

```bash
# 1. Unit healthy, accounting on
systemctl status droplet-egress-audit --no-pager
sysctl net.netfilter.nf_conntrack_acct        # expect: = 1

# 2. Raw feeds work
sudo conntrack -E -e NEW,DESTROY -o timestamp | head -3
sudo tcpdump -i any -c 3 -n udp port 53

# 3. Attribution map is populated
docker network inspect droplet_default | python3 -c "import json,sys;d=json.load(sys.stdin);print({c['Name']:c['IPv4Address'] for c in d[0]['Containers'].values()})"

# 4. Orchestrator reachability from the host netns (SAME dependency as the
#    WARP-468/470 routing samplers)
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/api/orchestrator/health

# 5. Provoke an unlisted egress from a container and watch it land
docker compose -f docker/docker-compose.yml exec ai-gateway \
  python3 -c "import urllib.request; urllib.request.urlopen('https://example.com', timeout=10)"
tail -n 5 /var/lib/droplet/egress-audit/egress-$(date -u +%Y%m%d).ndjson
# expect: flow_start + flow_end, service="ai-gateway", dst 93.184.x.x, allowed=false
# then: /admin/audit shows a warn "Egress anomaly: ai-gateway → example.com:443"

# 6. Allowlist hot-reload: append a matching entry to the allowlist,
#    repeat step 5 → allowed=true, no new anomaly.

# 7. Restart resilience: docker restart a service, confirm re-attribution and
#    that systemctl restart droplet-egress-audit resumes cleanly.

# 8. 24 h soak: check log growth and collector RSS
#    (ps -o rss= -p $(systemctl show -p MainPID --value droplet-egress-audit)).
```
