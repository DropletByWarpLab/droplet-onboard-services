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
#   _RAW_DEVICE.
#
# CLI: [--list] [--checks a,b,c] [--pcap-seconds N] [--verify-bundle DIR]
# =============================================================================
set -u

VFY_OUTPUT_ROOT="${DROPLET_VFY_OUTPUT_ROOT:-/var/lib/droplet/verify}"
VFY_REPO_ROOT="${DROPLET_VFY_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
VFY_COMPOSE_PROJECT="${DROPLET_VFY_COMPOSE_PROJECT:-droplet}"
VFY_COMPOSE_FILE="${DROPLET_VFY_COMPOSE_FILE:-$VFY_REPO_ROOT/docker/docker-compose.yml}"
VFY_DATA_PATHS="${DROPLET_VFY_DATA_PATHS:-/var/lib/docker/volumes /var/lib/droplet $VFY_REPO_ROOT/data/secrets $VFY_REPO_ROOT/.env}"
VFY_USB_GLOB="${DROPLET_VFY_USB_GLOB:-/mnt/droplet/*}"
VFY_MESH_TARGETS="${DROPLET_VFY_MESH_TARGETS:-ai-gateway:8000 mcp-server:9090 web-dashboard:3001}"
VFY_REDIS_TLS_PORT="${DROPLET_VFY_REDIS_TLS_PORT:-6380}"
VFY_PCAP_SECONDS="${DROPLET_VFY_PCAP_SECONDS:-60}"
VFY_SIGNER_CONTAINER="${DROPLET_VFY_SIGNER_CONTAINER:-droplet-device-identity-svc}"
VFY_TPM_DIR="${DROPLET_VFY_TPM_DIR:-/var/lib/droplet/tpm}"
VFY_CHECKS="${DROPLET_VFY_CHECKS:-all}"
VFY_RAW_DEVICE="${DROPLET_VFY_RAW_DEVICE:-}"

# shellcheck source=droplet-verify-encryption-lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/droplet-verify-encryption-lib.sh"

# id|family|maps_to|threat_ids|description
VFY_REGISTRY="
rest.luks.device|rest|WARP-232|T5.8|data mount backed by a dm-crypt (LUKS) device
rest.luks.header|rest|WARP-232|T5.8|LUKS2 header with aes-xts + Argon2id keyslot
rest.luks.tpm-token|rest|WARP-232|T5.8|TPM2 token enrolled in a LUKS keyslot
rest.entropy|rest|WARP-232|T5.8|raw partition reads as ciphertext (entropy + magic scan)
rest.mount-coverage|rest|WARP-232|T5.8|all data surfaces on encrypted devices
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

vfy_have() { command -v "$1" >/dev/null 2>&1; }

# vfy_env NAME — read a single value from the repo .env (best-effort).
vfy_env() { grep -m1 "^$1=" "$VFY_REPO_ROOT/.env" 2>/dev/null | cut -d= -f2-; }

# vfy_compose ARGS — run docker compose against the pinned project + file.
vfy_compose() { docker compose -p "$VFY_COMPOSE_PROJECT" -f "$VFY_COMPOSE_FILE" "$@"; }

# vfy_record ID STATUS DETAIL EVIDENCE_CSV — registry supplies family/maps/threats/desc.
vfy_record() {
  local id="$1" status="$2" detail="$3" ev="${4:-}" row _ family maps threats desc
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
  local id="$1" fn
  fn="probe_$(printf '%s' "$1" | tr '.-' '__')"
  mkdir -p "$VFY_EVID/$id"
  if ! declare -F "$fn" >/dev/null; then vfy_record "$id" SKIP "no-probe-implemented" ""; return; fi
  "$fn" "$id" || vfy_record "$id" SKIP "probe-crashed (rc=$?) — harness bug, inspect $VFY_EVID/$id" ""
}

# vfy_find_raw_luks_device — DROPLET_VFY_RAW_DEVICE override, else best-effort
# lsblk walk for the first LUKS crypt parent. Prints device path or nothing.
vfy_find_raw_luks_device() {
  if [ -n "$VFY_RAW_DEVICE" ]; then printf '%s' "$VFY_RAW_DEVICE"; return 0; fi
  vfy_have lsblk || return 0
  lsblk -P -o NAME,FSTYPE 2>/dev/null | awk -F'"' '/FSTYPE="crypto_LUKS"/{print "/dev/"$2; exit}'
}

# --- probes: guard shells (Task 5). Live bodies land in Task 6. --------------

probe_rest_luks_device() {
  local id="$1" dev
  vfy_have lsblk || { vfy_record "$id" SKIP "lsblk-not-on-path"; return; }
  vfy_have findmnt || { vfy_record "$id" SKIP "findmnt-not-on-path"; return; }
  dev="$(vfy_find_raw_luks_device)"
  [ -n "$dev" ] || { vfy_record "$id" FAIL "no-crypt-device-in-chain (WARP-232 not landed?)" ""; return; }
  vfy_record "$id" PASS "crypt-device=$dev" ""
}

probe_rest_luks_header() {
  local id="$1"
  vfy_have cryptsetup || { vfy_record "$id" SKIP "cryptsetup-not-on-path"; return; }
  vfy_record "$id" FAIL "no-luks-device-found (WARP-232 not landed?)" ""
}

probe_rest_luks_tpm_token() {
  local id="$1"
  vfy_have cryptsetup || { vfy_record "$id" SKIP "cryptsetup-not-on-path"; return; }
  vfy_record "$id" FAIL "no-luks-device-found (WARP-232 not landed?)" ""
}

probe_rest_entropy() {
  local id="$1"
  vfy_have dd || { vfy_record "$id" SKIP "dd-not-on-path"; return; }
  vfy_record "$id" FAIL "no-luks-device-found (WARP-232 not landed?)" ""
}

probe_rest_mount_coverage() {
  local id="$1" p uncovered="" table="$VFY_EVID/$id/mount-map.txt"
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

probe_rest_usb_luks() {
  local id="$1" g uncovered="" any=0 table="$VFY_EVID/$id/usb-map.txt"
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
  vfy_have docker || { vfy_record "$id" SKIP "docker-not-on-path"; return; }
  vfy_record "$id" SKIP "not-implemented-yet"
}
probe_transit_pg_tls13() {
  local id="$1"
  vfy_have docker || { vfy_record "$id" SKIP "docker-not-on-path"; return; }
  vfy_record "$id" SKIP "not-implemented-yet"
}
probe_transit_pg_scram() {
  local id="$1"
  vfy_have docker || { vfy_record "$id" SKIP "docker-not-on-path"; return; }
  vfy_record "$id" SKIP "not-implemented-yet"
}
probe_transit_redis_plaintext_refused() {
  local id="$1"
  vfy_have docker || { vfy_record "$id" SKIP "docker-not-on-path"; return; }
  vfy_record "$id" SKIP "not-implemented-yet"
}
probe_transit_redis_tls() {
  local id="$1"
  vfy_have docker || { vfy_record "$id" SKIP "docker-not-on-path"; return; }
  vfy_record "$id" SKIP "not-implemented-yet"
}
probe_transit_mqtt_plaintext_closed() {
  local id="$1"
  vfy_have docker || { vfy_record "$id" SKIP "docker-not-on-path"; return; }
  vfy_record "$id" SKIP "not-implemented-yet"
}
probe_transit_mqtt_mtls_required() {
  local id="$1"
  vfy_have docker || { vfy_record "$id" SKIP "docker-not-on-path"; return; }
  vfy_record "$id" SKIP "not-implemented-yet"
}
probe_transit_mesh_plain_http_refused() {
  local id="$1"
  vfy_have docker || { vfy_record "$id" SKIP "docker-not-on-path"; return; }
  vfy_record "$id" SKIP "not-implemented-yet"
}
probe_transit_edge_tls_policy() {
  local id="$1"
  vfy_have openssl || { vfy_record "$id" SKIP "openssl-not-on-path"; return; }
  vfy_record "$id" SKIP "not-implemented-yet"
}
probe_transit_pcap_canary() {
  local id="$1"
  vfy_have tcpdump || { vfy_record "$id" SKIP "tcpdump-not-installed (apt-get install tcpdump)"; return; }
  vfy_have docker || { vfy_record "$id" SKIP "docker-not-on-path"; return; }
  vfy_record "$id" SKIP "not-implemented-yet"
}

# vfy_sign_bundle DIR — minimal degrade-to-skipped stub (full Sign RPC lands in
# Task 7). If the signer container is not resolvable, the bundle is unsigned.
vfy_sign_bundle() {
  VFY_SIGNING='{"status":"skipped","reason":"device-identity-svc not running"}'
  return 0
}

# vfy_prev_manifest_hash ROOT NEW_TS — sha256 of the most recent prior bundle's
# manifest, or "genesis" if this is the first run.
vfy_prev_manifest_hash() {
  local root="$1" new="$2" d prev="genesis"
  for d in $(ls -1dt "$root"/*/ 2>/dev/null); do
    case "$d" in *"$new"/) continue;; esac
    if [ -f "${d}manifest.sha256" ]; then prev="$(vfy_sha256 "${d}manifest.sha256")"; break; fi
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
  local only="" ts bundle prev meta hostname krel commit rc=0 id
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

  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  bundle="$VFY_OUTPUT_ROOT/$ts"
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
  vfy_render_json "$VFY_RESULTS" "$meta" "$prev" "$bundle/report.json.tmp"
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

# vfy_finalize_signature BUNDLE — placeholder extended in Task 7 (writes
# manifest.sig + copies the cert when the signer is available). No-op here.
vfy_finalize_signature() { :; }

# Only run main when executed directly (not when sourced by the test suite).
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  vfy_main "$@"
  exit $?
fi
