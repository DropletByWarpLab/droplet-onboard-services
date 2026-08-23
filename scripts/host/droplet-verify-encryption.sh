#!/usr/bin/env bash
# =============================================================================
# WARP-966 — droplet-verify-encryption: on-hardware encryption verification
# (rest + transit) producing a signed, hash-chained evidence bundle.
#
# One command on the appliance —
#     sudo bash scripts/host/droplet-verify-encryption.sh
# — probes data-at-rest (LUKS2) and every in-transit hop (Postgres, Redis,
# MQTT, internal service mesh, nginx edge) and emits a signed, timestamped,
# hash-chained evidence bundle under $DROPLET_VFY_OUTPUT_ROOT satisfying the
# WARP-966 acceptance criteria.
#
# CONTRACT (same rule as droplet-watchdog.sh — explicit enums, never inferred
# from absence): every registered check ALWAYS appears in the report with one of
# PASS | FAIL | SKIP. A missing subsystem (no LUKS device, tls-port closed,
# tcpdump not installed, container not running) is a SKIP with a reason or a
# posture FAIL — never a crash. The runner is `set -u` (NOT `set -e`): a
# verification pass must survive any single probe failing and still write the
# bundle.
#
# EXIT CODES:
#   0  no FAIL (SKIPs allowed and listed)
#   1  >= 1 FAIL (bundle still fully produced — the AC's "plaintext path is a
#      release blocker" surface)
#   2  harness error (could not even produce a bundle)
#
# All external binaries are resolved via PATH and all box paths via env knobs so
# tests/verify-encryption.test.sh can drive the real runner end-to-end against
# stub binaries.
#
# TEST HOOKS (env knobs, see below): DROPLET_VFY_OUTPUT_ROOT, _REPO_ROOT,
#   _COMPOSE_PROJECT, _COMPOSE_FILE, _DATA_PATHS, _USB_GLOB, _MESH_TARGETS,
#   _REDIS_TLS_PORT, _PCAP_SECONDS, _SIGNER_CONTAINER, _TPM_DIR, _CHECKS,
#   _RAW_DEVICE, _PROC_ROOT, _DATA_MOUNT.
#
# CLI: [--list] [--checks a,b,c] [--pcap-seconds N] [--verify-bundle DIR]
# =============================================================================
set -u

VFY_OUTPUT_ROOT="${DROPLET_VFY_OUTPUT_ROOT:-/var/lib/droplet/verify}"
VFY_REPO_ROOT="${DROPLET_VFY_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
VFY_COMPOSE_PROJECT="${DROPLET_VFY_COMPOSE_PROJECT:-droplet}"
VFY_COMPOSE_FILE="${DROPLET_VFY_COMPOSE_FILE:-$VFY_REPO_ROOT/docker/docker-compose.yml}"
# WARP-232 canonical data surfaces (docs/security/at-rest-encryption.md
# "Coverage table"): the docker data-root plus the relocated .env and
# data/secrets symlink targets on the encrypted data LV.
VFY_DATA_PATHS="${DROPLET_VFY_DATA_PATHS:-/data/droplet/env/.env /data/droplet/secrets /data/docker}"
VFY_USB_GLOB="${DROPLET_VFY_USB_GLOB:-/mnt/droplet/*}"
# WARP-236 mesh hops that must refuse cert-less plain HTTP. mcp-server:9090
# (JWT-gated, off-stack consumers) and web-dashboard:3001 (nginx user plane,
# no service secrets) are by-design plain — listing them would make this
# check FAIL forever (docs/security/internal-mtls.md, deviation 4).
VFY_MESH_TARGETS="${DROPLET_VFY_MESH_TARGETS:-orchestrator:3000 ai-gateway:8000}"
VFY_REDIS_TLS_PORT="${DROPLET_VFY_REDIS_TLS_PORT:-6380}"
VFY_PCAP_SECONDS="${DROPLET_VFY_PCAP_SECONDS:-60}"
VFY_SIGNER_CONTAINER="${DROPLET_VFY_SIGNER_CONTAINER:-droplet-device-identity-svc}"
VFY_TPM_DIR="${DROPLET_VFY_TPM_DIR:-/var/lib/droplet/tpm}"
VFY_CHECKS="${DROPLET_VFY_CHECKS:-all}"
VFY_RAW_DEVICE="${DROPLET_VFY_RAW_DEVICE:-}"
# WARP-2102 store-root probe: where /proc lives (test fixture seam) and the
# encrypted mount every live image/layer store must resolve under.
VFY_PROC_ROOT="${DROPLET_VFY_PROC_ROOT:-/proc}"
VFY_DATA_MOUNT="${DROPLET_VFY_DATA_MOUNT:-/data}"

# shellcheck source=droplet-verify-encryption-lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/droplet-verify-encryption-lib.sh"

# id|family|maps_to|threat_ids|description
VFY_REGISTRY="
rest.luks.device|rest|WARP-232|T5.8|data mount backed by a dm-crypt (LUKS) device
rest.luks.header|rest|WARP-232|T5.8|LUKS2 header with aes-xts + Argon2id keyslot
rest.luks.tpm-token|rest|WARP-232|T5.8|TPM2 token enrolled in a LUKS keyslot
rest.entropy|rest|WARP-232|T5.8|raw partition reads as ciphertext (entropy + magic scan)
rest.mount-coverage|rest|WARP-232|T5.8|all data surfaces on encrypted devices
rest.docker.store-root|rest|WARP-2102|T5.8|the RUNNING docker image store (incl. the containerd store) lives under /data
rest.usb-luks|rest|WARP-232|T5.8|USB automount drives are LUKS-enrolled
transit.pg.plaintext-rejected|transit|WARP-233|T5.8|psql with sslmode=disable is rejected
transit.pg.tls13|transit|WARP-233|T1.2|Postgres negotiates TLSv1.3
transit.pg.scram|transit|WARP-233|T5.8|password_encryption is scram-sha-256
transit.redis.plaintext-refused|transit|WARP-234|T5.8|non-TLS Redis port refuses connections
transit.redis.tls|transit|WARP-234|T5.8|Redis TLS port serves authenticated PING
transit.mqtt.plaintext-closed|transit|WARP-235|T5.8|plaintext MQTT :1883 no longer accepts publishes
transit.mqtt.mtls-required|transit|WARP-235|T5.8|MQTT :8883 refuses clients without certs
transit.mesh.plain-http-refused|transit|WARP-236|T2.8|internal APIs refuse plain HTTP
transit.edge.tls-policy|transit|WARP-1021|T1.2|nginx :443 floor TLSv1.2, :80 redirects
transit.pcap.canary|transit|WARP-966|T5.8|no canary/secret plaintext in sampled capture
"

# =============================================================================
# Runner internals
# =============================================================================

VFY_RESULTS=""   # ndjson accumulator file, set in vfy_main
VFY_EVID=""      # bundle evidence/ dir, set in vfy_main
VFY_SIGNING='{"status":"skipped","reason":"signing-not-attempted"}'

vfy_have() {
  # Test-only injection: VFY_ASSUME_MISSING is a space-separated list of tools to
  # treat as absent regardless of PATH. Lets the unit suite simulate an "empty
  # world" deterministically on CI runners that ship docker in /usr/bin (which a
  # PATH restriction cannot hide). Empty/unset in production → normal behavior.
  case " ${VFY_ASSUME_MISSING:-} " in *" $1 "*) return 1 ;; esac
  command -v "$1" >/dev/null 2>&1
}

# vfy_env NAME — read a single value from the repo .env (best-effort).
vfy_env() { grep -m1 "^$1=" "$VFY_REPO_ROOT/.env" 2>/dev/null | cut -d= -f2-; }

# vfy_compose ARGS — run docker compose against the pinned project + file.
vfy_compose() { docker compose -p "$VFY_COMPOSE_PROJECT" -f "$VFY_COMPOSE_FILE" "$@"; }

# vfy_container_running SERVICE — true when the compose service has a running
# container. Every exec-based transit probe calls this first: `docker compose
# exec` against a stopped service exits non-zero, which the expect-reject
# probes would misread as "plaintext refused" — a fully stopped stack must
# read SKIP ("container not running", the documented status contract), never
# a green PASS.
vfy_container_running() {
  [ -n "$(vfy_compose ps --status running -q "$1" 2>/dev/null)" ]
}

# vfy_record ID STATUS DETAIL EVIDENCE_CSV — registry supplies family/maps/threats/desc.
vfy_record() {
  local id="$1"
  local status="$2" detail="$3" ev="${4:-}" row _ family maps threats desc
  row="$(printf '%s\n' "$VFY_REGISTRY" | grep -m1 "^$id|")" || return 1
  IFS='|' read -r _ family maps threats desc <<EOF
$row
EOF
  vfy_result_line "$id" "$family" "$maps" "$threats" "$desc" "$status" "$detail" "$ev" \
    >> "$VFY_RESULTS"
}

# vfy_run_check ID — dispatch to probe_<id with . and - collapsed to _>; contain
# every error so one probe failing never aborts the pass (status contract).
vfy_run_check() {
  local id="$1"
  local fn
  fn="probe_$(printf '%s' "$1" | tr '.-' '__')"
  mkdir -p "$VFY_EVID/$id"
  if ! declare -F "$fn" >/dev/null; then vfy_record "$id" SKIP "no-probe-implemented" ""; return; fi
  "$fn" "$id" || vfy_record "$id" SKIP "probe-crashed (rc=$?) — harness bug, inspect $VFY_EVID/$id" ""
}

# vfy_evidence_csv ID — comma-joined relative paths of every file this check
# has written under evidence/<id>/ (for multi-file probes: mesh, edge, pcap).
vfy_evidence_csv() {
  local id="$1"
  local dir="$VFY_EVID/$id" f csv=""
  [ -d "$dir" ] || return 0
  for f in "$dir"/*; do
    [ -f "$f" ] || continue
    csv="$csv,evidence/$id/$(basename "$f")"
  done
  printf '%s' "${csv#,}"
}

# vfy_find_raw_luks_device — DROPLET_VFY_RAW_DEVICE override, else best-effort
# lsblk walk for the first LUKS crypt parent. Prints device path or nothing.
vfy_find_raw_luks_device() {
  if [ -n "$VFY_RAW_DEVICE" ]; then printf '%s' "$VFY_RAW_DEVICE"; return 0; fi
  vfy_have lsblk || return 0
  lsblk -P -o NAME,FSTYPE 2>/dev/null | awk -F'"' '/FSTYPE="crypto_LUKS"/{print "/dev/"$2; exit}'
}

# --- probes: live capture -> evaluate -> record. Each is guarded so a missing
#     tool/subsystem is a reasoned SKIP, never a crash (status contract). ------

probe_rest_luks_device() {
  local id="$1"
  local dev
  vfy_have lsblk || { vfy_record "$id" SKIP "lsblk-not-on-path"; return; }
  vfy_have findmnt || { vfy_record "$id" SKIP "findmnt-not-on-path"; return; }
  dev="$(vfy_find_raw_luks_device)"
  [ -n "$dev" ] || { vfy_record "$id" FAIL "no-crypt-device-in-chain (WARP-232 not landed?)" ""; return; }
  vfy_record "$id" PASS "crypt-device=$dev" ""
}

probe_rest_luks_header() {
  local id="$1"
  local dev out="$VFY_EVID/$id/luksdump.txt" v1 v2 v3
  vfy_have cryptsetup || { vfy_record "$id" SKIP "cryptsetup-not-on-path"; return; }
  dev="$(vfy_find_raw_luks_device)"
  [ -n "$dev" ] || { vfy_record "$id" FAIL "no-luks-device-found (WARP-232 not landed?)" ""; return; }
  cryptsetup luksDump "$dev" > "$out" 2>&1
  v1="$(vfy_eval_luks_version "$out")"; v2="$(vfy_eval_luks_cipher "$out")"
  v3="$(vfy_eval_luks_pbkdf "$out")"
  if [ "${v1%%|*}" = PASS ] && [ "${v2%%|*}" = PASS ] && [ "${v3%%|*}" = PASS ]; then
    vfy_record "$id" PASS "${v1#*|}; ${v2#*|}; ${v3#*|}" "evidence/$id/luksdump.txt"
  else
    vfy_record "$id" FAIL "${v1#*|}; ${v2#*|}; ${v3#*|}" "evidence/$id/luksdump.txt"
  fi
}

probe_rest_luks_tpm_token() {
  local id="$1"
  local dev out="$VFY_EVID/$id/luksdump.txt" v
  vfy_have cryptsetup || { vfy_record "$id" SKIP "cryptsetup-not-on-path"; return; }
  dev="$(vfy_find_raw_luks_device)"
  [ -n "$dev" ] || { vfy_record "$id" FAIL "no-luks-device-found (WARP-232 not landed?)" ""; return; }
  cryptsetup luksDump "$dev" > "$out" 2>&1
  v="$(vfy_eval_luks_tpm_token "$out")"
  vfy_record "$id" "${v%%|*}" "${v#*|}" "evidence/$id/luksdump.txt"
}

probe_rest_entropy() {
  local id="$1"
  local dev off worst_h="" worst_line magic_fail="" sample v hv
  vfy_have dd || { vfy_record "$id" SKIP "dd-not-on-path"; return; }
  dev="$(vfy_find_raw_luks_device)"
  [ -n "$dev" ] || { vfy_record "$id" FAIL "no-luks-device-found (WARP-232 not landed?)" ""; return; }
  # Sample three 4 MiB windows at 32/1024/4096 MiB. Unwritten SSD regions read
  # zeros even under LUKS, so we take the MAX entropy across the samples.
  for off in 32 1024 4096; do
    sample="$VFY_EVID/$id/sample-${off}MiB.raw"
    # Read 4 MiB from stdout (portable across real dd and the test's stub); the
    # raw bytes are transient and shredded below — only the entropy value stays.
    dd if="$dev" bs=1M count=4 skip="$off" status=none 2>/dev/null > "$sample" || true
    [ -s "$sample" ] || continue
    v="$(vfy_eval_entropy "$sample" 7.5)"
    hv="$(printf '%s' "${v#*|}" | sed -n 's/entropy=\([0-9.]*\).*/\1/p')"
    printf 'offset=%sMiB\t%s\n' "$off" "$v" > "$VFY_EVID/$id/sample-${off}MiB.entropy.txt"
    if [ -z "$worst_h" ] || vfy_gt "$hv" "$worst_h"; then worst_h="$hv"; worst_line="$v"; fi
    # Plaintext-magic scan runs on every sample; any hit is a finding.
    m="$(vfy_eval_no_plaintext_magic "$sample")"
    [ "${m%%|*}" = FAIL ] && magic_fail="$magic_fail ${m#*|}"
    rm -f "$sample"   # raw bytes are NOT bundled (only the entropy value is)
  done
  if [ -z "$worst_line" ]; then vfy_record "$id" SKIP "no-readable-samples"; return; fi
  if [ -n "$magic_fail" ]; then
    vfy_record "$id" FAIL "plaintext-magic-found:${magic_fail# }; max-${worst_line#*|}" \
      "$(vfy_evidence_csv "$id")"
    return
  fi
  vfy_record "$id" "${worst_line%%|*}" "max-${worst_line#*|} (max across 3 offsets; unwritten regions read zero)" \
    "$(vfy_evidence_csv "$id")"
}

probe_rest_mount_coverage() {
  local id="$1"
  local p uncovered="" table="$VFY_EVID/$id/mount-map.txt"
  : > "$table"
  for p in $VFY_DATA_PATHS; do
    if [ ! -e "$p" ]; then printf '%s\tabsent\tSKIP\n' "$p" >> "$table"; continue; fi
    if vfy_path_is_crypt_backed "$p" >> "$table"; then :; else uncovered="$uncovered $p"; fi
  done
  if [ -n "$uncovered" ]; then
    vfy_record "$id" FAIL "plaintext-at-rest:${uncovered# }" "evidence/$id/mount-map.txt"
  else
    vfy_record "$id" PASS "all-paths-crypt-backed" "evidence/$id/mount-map.txt"
  fi
}

# vfy_pids NAME — pids of a running process (pidof; empty when not running).
vfy_pids() { pidof "$1" 2>/dev/null || true; }

# vfy_open_store_dbs PID... — resolve every open fd of the given pids and print
# the targets that end in .db (bolt databases stay open for the daemon's whole
# lifetime). Reading /proc/<pid>/fd needs root; unreadable dirs yield nothing.
vfy_open_store_dbs() {
  local pid f t
  for pid in "$@"; do
    for f in "$VFY_PROC_ROOT/$pid/fd"/*; do
      [ -e "$f" ] || [ -L "$f" ] || continue
      t="$(readlink "$f" 2>/dev/null || true)"
      case "$t" in *.db) printf '%s\n' "$t";; esac
    done
  done
}

# vfy_paths_outside PREFIX — filter stdin; print the lines NOT under PREFIX/.
vfy_paths_outside() {
  local prefix="$1" line
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    case "$line" in "$prefix"/*) ;; *) printf '%s\n' "$line";; esac
  done
}

probe_rest_docker_store_root() {
  # WARP-2102: Docker >= 28 can serve images from the containerd image store
  # (features.containerd-snapshotter), whose root (/var/lib/containerd)
  # IGNORES daemon.json data-root — so a box can swear data-root=/data/docker
  # while every image byte lands on the plain root LV (the bench box's 63G
  # root hit 92% this way). Neither daemon.json nor `containerd config dump`
  # is proof here: both only render configuration a daemon WOULD load
  # (`containerd config dump` runs fine with the daemon stopped) and say
  # nothing about which store the RUNNING daemon actually writes into — so
  # this probe deliberately does NOT use `containerd config dump`. The honest
  # evidence is the running processes' own open file handles: the store's
  # bolt metadata database (io.containerd.metadata.v1.bolt/meta.db for the
  # containerd store; the buildkit/volumes/network bolt DBs under data-root
  # for the classic store) is held open for the daemon's lifetime, so
  # /proc/<pid>/fd readlinks pin the store the daemon REALLY uses. Which
  # store is active comes from `docker info` — the running daemon's own
  # runtime report over the API (it errors when dockerd is down), not a
  # config render.
  local id="$1"
  local out="$VFY_EVID/$id/open-store-dbs.txt" info="$VFY_EVID/$id/docker-info.txt"
  local dockerd_pids containerd_pids dbs containerd_meta offdata dataroot_dbs
  vfy_have docker || { vfy_record "$id" SKIP "docker-not-on-path"; return; }
  vfy_have pidof || { vfy_record "$id" SKIP "pidof-not-on-path"; return; }
  dockerd_pids="$(vfy_pids dockerd)"
  containerd_pids="$(vfy_pids containerd)"
  if [ -z "$dockerd_pids" ]; then
    vfy_record "$id" SKIP "dockerd-not-running"
    return
  fi
  # shellcheck disable=SC2086  # pid lists are intentionally word-split
  dbs="$(vfy_open_store_dbs $dockerd_pids $containerd_pids | LC_ALL=C sort -u)"
  printf '%s\n' "$dbs" > "$out"
  if [ -z "$dbs" ]; then
    vfy_record "$id" SKIP "no-open-store-dbs-resolvable (run as root so /proc/<pid>/fd is readable)" \
      "evidence/$id/open-store-dbs.txt"
    return
  fi
  docker info > "$info" 2>&1 || true
  containerd_meta="$(printf '%s\n' "$dbs" | grep -F 'io.containerd.metadata.v1.bolt/meta.db' || true)"
  if grep -q 'io\.containerd\.snapshotter' "$info" 2>/dev/null; then
    # containerd image store ACTIVE — the meta.db containerd holds open IS the
    # image store, and daemon.json data-root does not govern it.
    if [ -z "$containerd_meta" ]; then
      vfy_record "$id" SKIP "containerd-store-active-but-no-meta.db-fd-resolved" "$(vfy_evidence_csv "$id")"
      return
    fi
    offdata="$(printf '%s\n' "$containerd_meta" | vfy_paths_outside "$VFY_DATA_MOUNT")"
    if [ -n "$offdata" ]; then
      vfy_record "$id" FAIL \
        "containerd-image-store-off-$VFY_DATA_MOUNT:$(printf '%s' "$offdata" | tr '\n' ' ') (containerd-snapshotter active — data-root does NOT govern this store; WARP-2102)" \
        "$(vfy_evidence_csv "$id")"
    else
      vfy_record "$id" PASS "containerd-image-store-under-$VFY_DATA_MOUNT" "$(vfy_evidence_csv "$id")"
    fi
    return
  fi
  # Classic store — data-root governs the image/layer store, and dockerd's own
  # bolt DBs (buildkit, volumes, network) reveal the data-root it REALLY runs
  # with. containerd's meta.db off /data is fine in this mode: with the
  # snapshotter off it holds runtime metadata only, never image content.
  dataroot_dbs="$(printf '%s\n' "$dbs" | grep -E '/(buildkit|volumes|network)/' || true)"
  if [ -z "$dataroot_dbs" ]; then
    vfy_record "$id" SKIP "no-data-root-dbs-resolved-from-dockerd-fds" "$(vfy_evidence_csv "$id")"
    return
  fi
  offdata="$(printf '%s\n' "$dataroot_dbs" | vfy_paths_outside "$VFY_DATA_MOUNT")"
  if [ -n "$offdata" ]; then
    vfy_record "$id" FAIL \
      "docker-data-root-off-$VFY_DATA_MOUNT:$(printf '%s' "$offdata" | tr '\n' ' ')" \
      "$(vfy_evidence_csv "$id")"
  else
    vfy_record "$id" PASS "classic-store-data-root-under-$VFY_DATA_MOUNT" "$(vfy_evidence_csv "$id")"
  fi
}

probe_rest_usb_luks() {
  local id="$1"
  local g uncovered="" any=0 table="$VFY_EVID/$id/usb-map.txt"
  : > "$table"
  for g in $VFY_USB_GLOB; do
    [ -e "$g" ] || continue
    any=1
    if vfy_path_is_crypt_backed "$g" >> "$table"; then :; else uncovered="$uncovered $g"; fi
  done
  if [ "$any" -eq 0 ]; then vfy_record "$id" SKIP "no-usb-mounts"; return; fi
  if [ -n "$uncovered" ]; then
    vfy_record "$id" FAIL "usb-plaintext:${uncovered# }" "evidence/$id/usb-map.txt"
  else
    vfy_record "$id" PASS "all-usb-crypt-backed" "evidence/$id/usb-map.txt"
  fi
}

probe_transit_pg_plaintext_rejected() {
  local id="$1"
  local out="$VFY_EVID/$id/psql-disable.txt" rc v pw
  vfy_have docker || { vfy_record "$id" SKIP "docker-not-on-path"; return; }
  vfy_container_running db || { vfy_record "$id" SKIP "container-not-running:db"; return; }
  # WARP-233 ⇄ WARP-318: a FIPS-mode box deliberately serves pg_hba.fips.conf,
  # which tolerates plaintext+SCRAM on the private container bridge (the P1011
  # Prisma/libpq clash, decision A). Plaintext acceptance there is the
  # configured posture, not a regression — record the exception, don't FAIL.
  if [ "$(vfy_env DROPLET_FIPS_MODE)" = "1" ]; then
    vfy_record "$id" SKIP "fips-mode-plaintext-exception (WARP-318 P1011 decision A — pg_hba.fips.conf)"
    return
  fi
  # Password passed inline in the conninfo (not via `-e PGPASSWORD`) so the
  # exec argv keeps `db psql` adjacent and the value never lands in the process
  # list of the host (it is inside the container's argv only).
  pw="$(vfy_env POSTGRES_PASSWORD)"
  vfy_compose exec -T db \
    psql "host=db user=droplet password=$pw dbname=droplet sslmode=disable" -c 'SELECT 1' \
    > "$out" 2>&1
  rc=$?
  printf '\n[exit=%s]\n' "$rc" >> "$out"
  # "pg_hba.conf rejects connection" = WARP-233's explicit terminal reject
  # line matching (the shipped shape); "no pg_hba.conf entry" = the no-match
  # wording kept for configs without a terminal reject.
  v="$(vfy_eval_expect_reject "$rc" "$out" \
       '(no pg_hba.conf entry|pg_hba.conf rejects connection).*(SSL off|no encryption)|server does not support SSL')"
  vfy_record "$id" "${v%%|*}" "${v#*|}" "evidence/$id/psql-disable.txt"
}

probe_transit_pg_tls13() {
  local id="$1"
  local out="$VFY_EVID/$id/sclient-pg.txt" v
  vfy_have docker || { vfy_record "$id" SKIP "docker-not-on-path"; return; }
  vfy_container_running db || { vfy_record "$id" SKIP "container-not-running:db"; return; }
  vfy_compose exec -T db sh -c 'openssl s_client -starttls postgres -connect db:5432 </dev/null' \
    > "$out" 2>&1 || true
  v="$(vfy_eval_tls_protocol "$out" 'TLSv1\.3')"
  vfy_record "$id" "${v%%|*}" "${v#*|}" "evidence/$id/sclient-pg.txt"
}

probe_transit_pg_scram() {
  local id="$1"
  local out="$VFY_EVID/$id/pg-settings.txt" pw
  vfy_have docker || { vfy_record "$id" SKIP "docker-not-on-path"; return; }
  vfy_container_running db || { vfy_record "$id" SKIP "container-not-running:db"; return; }
  pw="$(vfy_env POSTGRES_PASSWORD)"
  vfy_compose exec -T db \
    psql "host=db user=droplet password=$pw dbname=droplet" -tAc 'SHOW password_encryption; SHOW ssl;' \
    > "$out" 2>&1 || true
  if grep -q 'scram-sha-256' "$out" 2>/dev/null; then
    vfy_record "$id" PASS "password_encryption=scram-sha-256" "evidence/$id/pg-settings.txt"
  else
    vfy_record "$id" FAIL "scram-sha-256-not-confirmed" "evidence/$id/pg-settings.txt"
  fi
}

probe_transit_redis_plaintext_refused() {
  local id="$1"
  local out="$VFY_EVID/$id/redis-plain.txt" rc v pw
  vfy_have docker || { vfy_record "$id" SKIP "docker-not-on-path"; return; }
  vfy_container_running cache || { vfy_record "$id" SKIP "container-not-running:cache"; return; }
  pw="$(vfy_env REDIS_PASSWORD)"
  vfy_compose exec -T cache redis-cli -h cache -p 6379 -a "$pw" --no-auth-warning PING \
    > "$out" 2>&1
  rc=$?
  printf '\n[exit=%s]\n' "$rc" >> "$out"
  if grep -qx 'PONG' "$out" 2>/dev/null; then
    vfy_record "$id" FAIL "plaintext-pong (6379 answered PONG over plaintext)" "evidence/$id/redis-plain.txt"
  else
    v="$(vfy_eval_expect_reject "$rc" "$out" 'Connection refused|NOAUTH|error')"
    vfy_record "$id" "${v%%|*}" "${v#*|}" "evidence/$id/redis-plain.txt"
  fi
}

probe_transit_redis_tls() {
  local id="$1"
  local out="$VFY_EVID/$id/redis-tls.txt" pw
  vfy_have docker || { vfy_record "$id" SKIP "docker-not-on-path"; return; }
  vfy_container_running cache || { vfy_record "$id" SKIP "container-not-running:cache"; return; }
  pw="$(vfy_env REDIS_PASSWORD)"
  # WARP-234: the cache serves a compose-internal-CA leaf (WARP-236 trust
  # root) that no public root signs — redis-cli must be pointed at the CA
  # the launch wrapper stages inside the container. REDIS_PASSWORD is the
  # ping-only `default` ACL user, which is exactly what PING needs.
  vfy_compose exec -T cache redis-cli -h cache --tls \
    --cacert /tmp/redis-ca.crt -p "$VFY_REDIS_TLS_PORT" \
    -a "$pw" --no-auth-warning PING > "$out" 2>&1 || true
  if grep -qx 'PONG' "$out" 2>/dev/null; then
    vfy_record "$id" PASS "tls-ping-ok (port $VFY_REDIS_TLS_PORT)" "evidence/$id/redis-tls.txt"
  else
    # WARP-234 landed the TLS listener — a non-PONG is a regression now,
    # not a not-yet-shipped feature.
    vfy_record "$id" FAIL "tls-ping-failed (port $VFY_REDIS_TLS_PORT)" "evidence/$id/redis-tls.txt"
  fi
}

probe_transit_mqtt_plaintext_closed() {
  local id="$1"
  local out="$VFY_EVID/$id/mqtt-plain.txt" rc pw
  vfy_have docker || { vfy_record "$id" SKIP "docker-not-on-path"; return; }
  vfy_container_running broker || { vfy_record "$id" SKIP "container-not-running:broker"; return; }
  # WARP-235 retired MQTT_PASSWORD from .env — fall back to a placeholder so
  # the probe still ATTEMPTS the plaintext connection (the check is "no 1883
  # listener", not "wrong credentials"); pre-235 installs still use the real
  # value so a lingering password listener is caught either way.
  pw="$(vfy_env MQTT_PASSWORD)"
  vfy_compose exec -T broker mosquitto_pub -h broker -p 1883 -u droplet -P "${pw:-warp235-retired}" \
    -t droplet/verify/canary -m probe > "$out" 2>&1
  rc=$?
  printf '\n[exit=%s]\n' "$rc" >> "$out"
  if [ "$rc" -eq 0 ]; then
    vfy_record "$id" FAIL "plaintext-mqtt-accepted (1883 accepted a publish)" "evidence/$id/mqtt-plain.txt"
  else
    vfy_record "$id" PASS "plaintext-1883-refused" "evidence/$id/mqtt-plain.txt"
  fi
}

probe_transit_mqtt_mtls_required() {
  local id="$1"
  local out="$VFY_EVID/$id/mqtt-nocert.txt" rc ca
  vfy_have docker || { vfy_record "$id" SKIP "docker-not-on-path"; return; }
  vfy_container_running broker || { vfy_record "$id" SKIP "container-not-running:broker"; return; }
  # WARP-235 mounts the broker bundle at /mosquitto/config/tls (ca.pem).
  ca="${DROPLET_VFY_MQTT_CA:-/mosquitto/config/tls/ca.pem}"
  vfy_compose exec -T broker mosquitto_pub -h broker -p 8883 --cafile "$ca" \
    -t droplet/verify/canary -m probe > "$out" 2>&1
  rc=$?
  printf '\n[exit=%s]\n' "$rc" >> "$out"
  if [ "$rc" -eq 0 ]; then
    vfy_record "$id" FAIL "client-cert-not-required (8883 accepted a certless publish)" "evidence/$id/mqtt-nocert.txt"
  elif grep -qiE 'tls|cert|connection refused' "$out" 2>/dev/null; then
    vfy_record "$id" PASS "certless-publish-refused" "evidence/$id/mqtt-nocert.txt"
  else
    vfy_record "$id" SKIP "8883-not-listening (WARP-235 not landed)" "evidence/$id/mqtt-nocert.txt"
  fi
}

probe_transit_mesh_plain_http_refused() {
  local id="$1"
  local t accepted="" out
  vfy_have docker || { vfy_record "$id" SKIP "docker-not-on-path"; return; }
  # The orchestrator container is the exec host for the fetch probes — a
  # stopped stack would otherwise read as "refused" (green) for every target.
  vfy_container_running orchestrator \
    || { vfy_record "$id" SKIP "container-not-running:orchestrator"; return; }
  for t in $VFY_MESH_TARGETS; do
    out="$VFY_EVID/$id/mesh-${t//[:\/]/_}.txt"
    if vfy_compose exec -T orchestrator node -e \
      "fetch('http://$t/',{signal:AbortSignal.timeout(5000)}).then(r=>{console.log('HTTP',r.status);process.exit(0)}).catch(e=>{console.error(String(e));process.exit(1)})" \
      > "$out" 2>&1; then
      accepted="$accepted $t"
    fi
  done
  if [ -n "$accepted" ]; then
    vfy_record "$id" FAIL "plain-http-accepted-by:${accepted# } (WARP-236 AC: cert-less callers must be refused)" \
      "$(vfy_evidence_csv "$id")"
  else
    vfy_record "$id" PASS "all-mesh-targets-refuse-plain-http" "$(vfy_evidence_csv "$id")"
  fi
}

probe_transit_edge_tls_policy() {
  local id="$1"
  local o1="$VFY_EVID/$id/sclient-edge.txt" o2="$VFY_EVID/$id/sclient-edge-tls11.txt"
  local o3="$VFY_EVID/$id/http-redirect.txt" v proto11 redir
  vfy_have openssl || { vfy_record "$id" SKIP "openssl-not-on-path"; return; }
  openssl s_client -connect 127.0.0.1:443 </dev/null > "$o1" 2>&1 || true
  openssl s_client -tls1_1 -connect 127.0.0.1:443 </dev/null > "$o2" 2>&1 || true
  if vfy_have curl; then curl -sSI http://127.0.0.1/ > "$o3" 2>&1 || true; else : > "$o3"; fi
  v="$(vfy_eval_tls_protocol "$o1" 'TLSv1\.[23]')"
  proto11="$(vfy_eval_tls_protocol "$o2" 'TLSv1\.1')"   # PASS here means 1.1 negotiated (BAD)
  redir="$(grep -m1 -oE 'HTTP/[0-9.]+ (301|308)' "$o3" 2>/dev/null || true)"
  if [ "${v%%|*}" = PASS ] && [ "${proto11%%|*}" != PASS ]; then
    vfy_record "$id" PASS "edge=${v#*|}; tls1.1-refused; ${redir:-redirect-unverified}" \
      "$(vfy_evidence_csv "$id")"
  else
    vfy_record "$id" FAIL "edge=${v#*|}; tls1.1=${proto11#*|}" "$(vfy_evidence_csv "$id")"
  fi
}

probe_transit_pcap_canary() {
  local id="$1"
  local br pcap="$VFY_EVID/$id/capture.pcap" wl="$VFY_EVID/$id/workload.log"
  local scan="$VFY_EVID/$id/pcap-scan.txt" canary netid tdpid patt v pw
  vfy_have tcpdump || { vfy_record "$id" SKIP "tcpdump-not-installed (apt-get install tcpdump)"; return; }
  vfy_have docker || { vfy_record "$id" SKIP "docker-not-on-path"; return; }
  netid="$(docker network inspect "${VFY_COMPOSE_PROJECT}_default" -f '{{.Id}}' 2>/dev/null | cut -c1-12)"
  [ -n "$netid" ] || { vfy_record "$id" SKIP "bridge-iface-unresolvable"; return; }
  br="br-$netid"
  canary="DROPLET-CANARY-$(openssl rand -hex 8 2>/dev/null || echo deadbeefdeadbeef)"
  : > "$wl"
  tcpdump -i "$br" -s 0 -w "$pcap" >/dev/null 2>&1 &
  tdpid=$!
  # Drive the canary through every hop (all ephemeral, read-mostly).
  pw="$(vfy_env POSTGRES_PASSWORD)"
  vfy_compose exec -T db \
    psql "host=db user=droplet password=$pw dbname=droplet" -tAc "SELECT '$canary'" >> "$wl" 2>&1 || true
  pw="$(vfy_env REDIS_PASSWORD)"
  vfy_compose exec -T cache redis-cli -h cache -a "$pw" --no-auth-warning \
    SET vfy:canary "$canary" >> "$wl" 2>&1 || true
  vfy_compose exec -T cache redis-cli -h cache -a "$pw" --no-auth-warning GET vfy:canary >> "$wl" 2>&1 || true
  vfy_compose exec -T cache redis-cli -h cache -a "$pw" --no-auth-warning DEL vfy:canary >> "$wl" 2>&1 || true
  pw="$(vfy_env MQTT_PASSWORD)"
  vfy_compose exec -T broker mosquitto_pub -h broker -p 1883 -u droplet -P "$pw" \
    -t droplet/verify/canary -m "$canary" >> "$wl" 2>&1 || true
  vfy_compose exec -T orchestrator node -e \
    "fetch('http://ai-gateway:8000/',{headers:{'x-droplet-canary':'$canary'},signal:AbortSignal.timeout(3000)}).then(()=>0).catch(()=>0)" \
    >> "$wl" 2>&1 || true
  sleep "$VFY_PCAP_SECONDS"
  kill -INT "$tdpid" 2>/dev/null || true
  wait "$tdpid" 2>/dev/null || true
  if [ ! -s "$pcap" ]; then vfy_record "$id" SKIP "capture-produced-no-packets" "evidence/$id/workload.log"; return; fi
  # Build a 0600 patterns file: canary + every secret VALUE by name. The values
  # never leave this shredded tempfile; the verdict names only pattern names.
  patt="$(mktemp)"; chmod 600 "$patt"
  printf 'canary\t%s\n' "$canary" >> "$patt"
  for name in POSTGRES_PASSWORD REDIS_PASSWORD MQTT_PASSWORD JWT_SECRET DEVICE_SECRET_KEY \
              $(grep -oE '^SERVICE_TOKEN_[A-Z0-9_]+' "$VFY_REPO_ROOT/.env" 2>/dev/null); do
    val="$(vfy_env "$name")"
    [ -n "$val" ] && printf '%s\t%s\n' "$name" "$val" >> "$patt"
  done
  v="$(vfy_eval_pcap_patterns "$pcap" "$patt")"
  printf '%s\n' "$v" > "$scan"
  { shred -u "$patt" 2>/dev/null || rm -P "$patt" 2>/dev/null || rm -f "$patt"; }
  vfy_record "$id" "${v%%|*}" "${v#*|}" "evidence/$id/pcap-scan.txt,evidence/$id/workload.log,evidence/$id/capture.pcap"
}

# vfy_sign_bundle DIR — decide the signing DISPOSITION and copy the verifier
# cert into the bundle (so the cert is covered by the manifest). The actual
# signature over the manifest is produced later by vfy_finalize_signature, once
# the manifest exists. If the device-identity sidecar (WARP-230) is not
# available, the bundle is produced UNSIGNED (degrade, don't die).
#
# Signing primitive: the sidecar's `rpc Sign` — ECDSA-P256 over SHA-256 with a
# non-extractable TPM-sealed key — invoked via `docker exec` into the container
# (proto/device_identity.proto). The orchestrator's symmetric audit HMAC was
# rejected: it gives no third-party verifiability and reusing that key would
# weaken WARP-456's key-custody story.
vfy_sign_bundle() {
  local dir="$1"
  if ! vfy_have docker \
     || ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$VFY_SIGNER_CONTAINER"; then
    VFY_SIGNING='{"status":"skipped","reason":"device-identity-svc not running (bundle is UNSIGNED)"}'
    return 0
  fi
  if [ -f "$VFY_TPM_DIR/device-id-cert.pem" ]; then
    cp "$VFY_TPM_DIR/device-id-cert.pem" "$dir/device-id-cert.pem" 2>/dev/null || true
  fi
  if [ ! -f "$dir/device-id-cert.pem" ]; then
    VFY_SIGNING='{"status":"skipped","reason":"verifier cert absent at DROPLET_VFY_TPM_DIR (bundle is UNSIGNED)"}'
    return 0
  fi
  VFY_SIGNING='{"status":"signed","algorithm":"ECDSA-P256-SHA256","signer":"device-identity-svc","signature_file":"manifest.sig","cert":"device-id-cert.pem"}'
}

# vfy_call_sign_rpc DIR — feed manifest.sha256 to the sidecar's Sign RPC and
# write the DER signature to manifest.sig. Prints nothing; returns non-zero on
# failure (caller downgrades the report to unsigned).
vfy_call_sign_rpc() {
  local dir="$1" sig
  sig="$(docker exec -i "$VFY_SIGNER_CONTAINER" python -c '
import sys, base64, grpc
sys.path.insert(0, "/app")
from grpc_generated import device_identity_pb2 as pb
from grpc_generated import device_identity_pb2_grpc as pbg
payload = sys.stdin.buffer.read()
stub = pbg.DeviceIdentityServiceStub(
    grpc.insecure_channel("unix:///var/run/droplet/device-identity.sock"))
resp = stub.Sign(pb.SignRequest(payload=payload), timeout=10)
print(base64.b64encode(resp.signature).decode())
' < "$dir/manifest.sha256" 2>"$dir/signing-error.txt")" || return 1
  [ -n "$sig" ] || return 1
  printf '%s' "$sig" | base64 -d > "$dir/manifest.sig" 2>/dev/null || return 1
  [ -s "$dir/manifest.sig" ]
}

# vfy_prev_manifest_hash ROOT NEW_TS — sha256 of the most recent prior bundle's
# manifest, or "genesis" if this is the first run. Bundle dirs are named by UTC
# timestamp, so reverse-lexical order == most-recent-first (no ls-parsing).
vfy_prev_manifest_hash() {
  local root="$1" new="$2" name prev="genesis"
  local names=() line
  # Sort on the bare basename (no trailing slash) so a "-NN" same-second suffix
  # sorts AFTER its bare timestamp and in numeric order — reverse sort then
  # yields true most-recent-first (the trailing "/" would otherwise invert it).
  while IFS= read -r line; do names+=("$line"); done < <(
    for name in "$root"/*/; do
      name="${name%/}"; [ -d "$name" ] && printf '%s\n' "$(basename "$name")"
    done | LC_ALL=C sort -r
  )
  for name in ${names[@]+"${names[@]}"}; do
    [ "$name" = "$new" ] && continue
    if [ -f "$root/$name/manifest.sha256" ]; then
      prev="$(vfy_sha256 "$root/$name/manifest.sha256")"; break
    fi
  done
  printf '%s' "$prev"
}

vfy_print_summary() {  # REPORT_JSON
  local py; py="$(vfy_py)"; [ -n "$py" ] || return 0
  "$py" - "$1" <<'PYEOF'
import json, sys
r = json.load(open(sys.argv[1]))
s = r["summary"]
print(f"\nWARP-966 encryption verification — {s['pass']} PASS / {s['fail']} FAIL / {s['skip']} SKIP")
for c in r["checks"]:
    print(f"  [{c['status']:>4}] {c['id']:<32} {c.get('detail','')}")
if s["release_blockers"]:
    print("\nRELEASE BLOCKERS (each a documented plaintext path):")
    for b in s["release_blockers"]:
        print(f"  - {b}")
PYEOF
}

# vfy_list — print the registry (id|family|maps_to|threat_ids|description).
vfy_list() { printf '%s\n' "$VFY_REGISTRY" | sed '/^$/d'; }

vfy_main() {
  local ts bundle prev meta hostname krel commit rc=0 id
  while [ $# -gt 0 ]; do
    case "$1" in
      --list) vfy_list; return 0;;
      --checks) VFY_CHECKS="$2"; shift;;
      --checks=*) VFY_CHECKS="${1#--checks=}";;
      --pcap-seconds) VFY_PCAP_SECONDS="$2"; shift;;
      --pcap-seconds=*) VFY_PCAP_SECONDS="${1#--pcap-seconds=}";;
      --verify-bundle) vfy_verify_bundle "$2"; return $?;;
      --verify-bundle=*) vfy_verify_bundle "${1#--verify-bundle=}"; return $?;;
      -h|--help) grep -E '^# ' "${BASH_SOURCE[0]}" | sed 's/^# //'; return 0;;
      *) printf 'unknown argument: %s\n' "$1" >&2; return 2;;
    esac
    shift
  done

  # UTC-timestamp bundle dir. Second granularity keeps the name sortable (so the
  # prev-manifest chain walk is a plain lexical sort); if two runs land in the
  # same second, disambiguate with a -NN suffix that still sorts chronologically.
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  bundle="$VFY_OUTPUT_ROOT/$ts"
  if [ -d "$bundle" ]; then
    local n=1 cand
    while :; do
      cand="$(printf '%s-%02d' "$ts" "$n")"
      [ -d "$VFY_OUTPUT_ROOT/$cand" ] || break
      n=$((n + 1))
    done
    ts="$cand"
    bundle="$VFY_OUTPUT_ROOT/$ts"
  fi
  VFY_EVID="$bundle/evidence"
  VFY_RESULTS="$bundle/results.ndjson"
  mkdir -p "$VFY_EVID" || { printf 'cannot create bundle dir %s\n' "$bundle" >&2; return 2; }
  : > "$VFY_RESULTS"

  hostname="$(hostname 2>/dev/null || echo unknown)"
  krel="$(uname -r 2>/dev/null || echo unknown)"
  commit="$(git -C "$VFY_REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  meta="$(printf '{"hostname":"%s","kernel":"%s","git_commit":"%s","checks_filter":"%s"}' \
    "$(vfy_json_escape "$hostname")" "$(vfy_json_escape "$krel")" \
    "$(vfy_json_escape "$commit")" "$(vfy_json_escape "$VFY_CHECKS")")"

  while IFS='|' read -r id _rest; do
    [ -n "$id" ] || continue
    case "$VFY_CHECKS" in
      all|"") vfy_run_check "$id";;
      *) case ",$VFY_CHECKS," in *",$id,"*) vfy_run_check "$id";; esac;;
    esac
  done <<EOF
$(printf '%s\n' "$VFY_REGISTRY" | sed '/^$/d')
EOF

  prev="$(vfy_prev_manifest_hash "$VFY_OUTPUT_ROOT" "$ts")"
  vfy_render_json "$VFY_RESULTS" "$meta" "$prev" "$bundle/report.json.tmp" "$bundle"
  vfy_render_md "$VFY_RESULTS" "$bundle/report.md"

  # Sign the manifest; the report records the signing status, so signing runs
  # BEFORE the manifest — inject the signing object into report.json first.
  vfy_sign_bundle "$bundle"
  vfy_inject_signing "$bundle/report.json.tmp" "$VFY_SIGNING" "$bundle/report.json"
  rm -f "$bundle/report.json.tmp" "$VFY_RESULTS"

  vfy_manifest "$bundle"
  vfy_finalize_signature "$bundle"

  vfy_print_summary "$bundle/report.json"
  printf '\nbundle: %s\n' "$bundle"

  # Exit 1 if any FAIL row present.
  if "$(vfy_py)" -c 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1]))["summary"]["fail"]>0 else 1)' \
       "$bundle/report.json"; then rc=1; else rc=0; fi
  return "$rc"
}

# vfy_inject_signing IN_JSON SIGNING_JSON OUT_JSON — add the signing object to
# the report (kept in the lib-free runner so Task 7 can extend it).
vfy_inject_signing() {
  local in="$1" sig="$2" out="$3" py; py="$(vfy_py)"
  VFY_IN="$in" VFY_SIG="$sig" VFY_OUT2="$out" "$py" - <<'PYEOF'
import json, os
r = json.load(open(os.environ["VFY_IN"]))
r["signing"] = json.loads(os.environ["VFY_SIG"])
with open(os.environ["VFY_OUT2"], "w") as fh:
    json.dump(r, fh, indent=2, sort_keys=False); fh.write("\n")
PYEOF
}

# vfy_finalize_signature BUNDLE — when the report says the bundle is signed,
# produce manifest.sig over the (already written) manifest via the Sign RPC. If
# the RPC fails, downgrade report.json to signing.status=skipped so the report
# never claims a signature the bundle does not carry.
vfy_finalize_signature() {
  local dir="$1" status
  status="$(printf '%s' "$VFY_SIGNING" | sed -n 's/.*"status":"\([a-z]*\)".*/\1/p')"
  [ "$status" = "signed" ] || return 0
  if vfy_call_sign_rpc "$dir"; then
    return 0
  fi
  # RPC failed after we advertised "signed" — rewrite the report honestly.
  VFY_SIGNING='{"status":"skipped","reason":"Sign RPC failed — see signing-error.txt (bundle is UNSIGNED)"}'
  vfy_inject_signing "$dir/report.json" "$VFY_SIGNING" "$dir/report.json.fix" \
    && mv "$dir/report.json.fix" "$dir/report.json"
  rm -f "$dir/manifest.sig"
}

# vfy_verify_bundle BUNDLE_DIR — offline verification. (1) recompute every
# manifest hash and compare; (2) if a signature is present, verify it against
# the bundled cert's public key. Exit 0 verified, 1 failed. No network, no
# sidecar — pure openssl + sha256, so evidence is verifiable by any third party.
vfy_verify_bundle() {
  local dir="$1" rc=0
  [ -d "$dir" ] || { printf 'no such bundle: %s\n' "$dir" >&2; return 1; }
  [ -f "$dir/manifest.sha256" ] || { printf 'no manifest.sha256 in %s\n' "$dir" >&2; return 1; }
  if ! ( cd "$dir" && while read -r h f; do
      [ -n "$h" ] && [ -n "$f" ] || continue
      calc="$( { sha256sum "$f" 2>/dev/null || shasum -a 256 "$f"; } | awk '{print $1}')"
      [ "$calc" = "$h" ] || { printf 'HASH MISMATCH: %s\n' "$f" >&2; exit 1; }
    done < manifest.sha256 ); then
    printf 'bundle verification FAILED: manifest hash mismatch\n' >&2
    return 1
  fi
  if [ -f "$dir/manifest.sig" ]; then
    if [ ! -f "$dir/device-id-cert.pem" ]; then
      printf 'signature present but no device-id-cert.pem to verify it\n' >&2
      return 1
    fi
    openssl x509 -in "$dir/device-id-cert.pem" -pubkey -noout > "$dir/.pub.pem" 2>/dev/null || rc=1
    if [ "$rc" -eq 0 ] && openssl dgst -sha256 -verify "$dir/.pub.pem" \
         -signature "$dir/manifest.sig" "$dir/manifest.sha256" >/dev/null 2>&1; then
      rm -f "$dir/.pub.pem"
      printf 'bundle verified: hashes + device-identity signature OK\n'
      return 0
    fi
    rm -f "$dir/.pub.pem"
    printf 'bundle verification FAILED: signature does not verify\n' >&2
    return 1
  fi
  printf 'bundle verified: hashes OK (bundle is UNSIGNED — signing was skipped)\n'
  return 0
}

# Only run main when executed directly (not when sourced by the test suite).
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  vfy_main "$@"
  exit $?
fi
