#!/usr/bin/env bash
# =============================================================================
# WARP-868 — the droplet rpcd ACL must be provisioned DURABLY, not via a
# silenced best-effort docker cp.
#
# Field incident (2026-06-11, .87 reflash): the attach script's
# `docker cp … >/dev/null 2>&1` failed silently, so the running container had
# no /usr/share/rpcd/acl.d/droplet-ai.json. rpcd's `read '*'` only expands
# over acl.d groups that EXIST, so even the root session got "Access denied"
# on `file` reads (/dhcp/leases) and `umdns` browse (/aps/discovered) — the
# network tab 500'd and the wizard's DDNS step surfaced a raw 500.
#
# Static drift guards (no Docker needed, < 1s):
#   1. the singlebox image BAKES the ACL (Dockerfile COPY from the canonical
#      openwrt/files/... path);
#   2. compose builds that Dockerfile with the openwrt/ context so the COPY
#      source actually resolves;
#   3. the attach script's safety-net copy is NOT silenced, VERIFIES the file
#      landed, and FAILS the unit when the ACL cannot be provisioned;
#   4. the canonical ACL file itself still exists and grants the file/umdns
#      capabilities the routing service needs;
#   5. the uhttpd concurrency bump ships in the image's uci-defaults AND the
#      attach-time enforcement for pre-bake containers.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DOCKERFILE="$REPO_ROOT/openwrt/singlebox-image/Dockerfile"
COMPOSE="$REPO_ROOT/docker/docker-compose.yml"
ATTACH="$REPO_ROOT/scripts/host/usr-local-sbin/droplet-openwrt-attach"
ACL="$REPO_ROOT/openwrt/files/usr/share/rpcd/acl.d/droplet-ai.json"
UCI_DEFAULTS="$REPO_ROOT/openwrt/singlebox-image/uci-defaults/60-droplet-uhttpd-limits"

PASS=0
FAIL=0
ok()  { PASS=$((PASS + 1)); echo "ok   - $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL - $1"; }

# 1. Image bakes the ACL from the canonical path.
if grep -Eq '^COPY +files/usr/share/rpcd/acl\.d/droplet-ai\.json +/usr/share/rpcd/acl\.d/droplet-ai\.json' "$DOCKERFILE"; then
  ok "Dockerfile bakes the canonical droplet-ai rpcd ACL"
else
  bad "Dockerfile does not COPY the droplet-ai rpcd ACL from openwrt/files"
fi

# 2. Compose context lets that COPY resolve (context openwrt/, dockerfile
#    singlebox-image/Dockerfile). The build block sits a comment-stanza below
#    the `openwrt:` service key, so scan a bounded window after it.
OPENWRT_BLOCK="$(grep -A25 '^  openwrt:$' "$COMPOSE")"
if echo "$OPENWRT_BLOCK" | grep -q 'context: \.\./openwrt$' \
   && echo "$OPENWRT_BLOCK" | grep -q 'dockerfile: singlebox-image/Dockerfile'; then
  ok "compose builds the singlebox image with the openwrt/ context"
else
  bad "compose openwrt build context/dockerfile do not match the baked COPY paths"
fi

# 3a. The attach safety-net is not silenced: no docker cp of the ACL may
#     redirect its own failure into /dev/null.
if grep -E 'docker cp .*droplet-ai\.json' "$ATTACH" | grep -q '>/dev/null 2>&1'; then
  bad "attach script still silences the rpcd ACL docker cp"
else
  ok "attach script's rpcd ACL copy is unsilenced"
fi

# 3b. It verifies the file actually landed in the container...
if grep -q 'docker exec droplet-openwrt test -r /usr/share/rpcd/acl.d/droplet-ai.json' "$ATTACH"; then
  ok "attach script verifies the ACL is present in the container"
else
  bad "attach script never verifies the ACL landed"
fi

# 3c. ...and fails the unit when it cannot be provisioned.
if grep -q 'rpcd ACL copy failed' "$ATTACH" && grep -A2 'rpcd ACL copy failed' "$ATTACH" | grep -q 'EXEC_RC=1'; then
  ok "attach script fails the unit on an ACL provisioning failure"
else
  bad "attach script does not fail the unit when the ACL cannot be provisioned"
fi

# 4. The canonical ACL still grants what routing needs (file read + umdns).
if [ -r "$ACL" ] && grep -q '"umdns"' "$ACL" && grep -q '"file"' "$ACL"; then
  ok "canonical droplet-ai.json grants umdns + file capabilities"
else
  bad "canonical droplet-ai.json missing or lost its umdns/file grants"
fi

# 5a. uhttpd concurrency bump ships in the image (uci-defaults)…
if [ -r "$UCI_DEFAULTS" ] && grep -q "max_requests='10'" "$UCI_DEFAULTS" \
   && grep -Eq '^COPY +singlebox-image/uci-defaults/60-droplet-uhttpd-limits' "$DOCKERFILE"; then
  ok "image ships the uhttpd max_requests uci-default"
else
  bad "uhttpd max_requests uci-default missing from the image"
fi

# 5b. …and attach enforces it for pre-bake containers.
if grep -q "uci set uhttpd.main.max_requests='10'" "$ATTACH"; then
  ok "attach script enforces uhttpd max_requests for pre-bake containers"
else
  bad "attach script does not enforce the uhttpd max_requests bump"
fi

echo
echo "openwrt-rpcd-acl-provisioning: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
