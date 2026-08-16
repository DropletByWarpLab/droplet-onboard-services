#!/usr/bin/env bash
# =============================================================================
# Integration tests for scripts/lib/apply-update.sh (WARP-539).
# =============================================================================
#
# Pins the two behaviours a stubbed helper once faked (QA rework findings):
#
#   1. PER-TARGET DIGEST PINNING — the appliance compose file defines the
#      first-party services (orchestrator, web-dashboard, …) as build:-only,
#      so `recreate-services` MUST drive `docker compose` with
#      `-f <base> -f <updatesDir>/<id>/override-<target>.yml` and
#      `--no-build --pull never`; the merged config must RESOLVE each
#      service to the pinned image ref for BOTH targets (release/previous).
#      The resolution assertions run the REAL `docker compose config`
#      (client-side only — no daemon needed).
#
#   2. THE DETACHED SELF-SWAP HELPER IS REAL — `recreate-self-detached`
#      launches a helper that (a) recreates the orchestrator pinned to the
#      target override, (b) waits BOUNDED on the recreated container's
#      healthcheck, (c) on timeout rolls EVERY service in services.txt back
#      to the previous refs. The test extracts the helper's payload + `-e`
#      environment from the recorded `docker run` argv and EXECUTES it under
#      the fake docker — both the healthy path and the timeout→rollback path.
#
# Harness: PATH-shimmed fake `docker` (same convention as tests/setup.test.sh
# Phase 3) that records every invocation — one space-joined line in calls.log
# for substring asserts plus a NUL-separated argv file per call for payload
# extraction — and answers the small read surface the script needs.
#
# Does NOT require a running Docker daemon. Requires the docker CLI with the
# compose plugin for the config-resolution assertions (present on the box,
# on ubuntu-latest runners, and anywhere ship-check's compose-config gate
# already runs) — missing compose FAILS those tests, it never skips.
# Runtime: < 20 seconds.
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
APPLY_SH="$REPO_ROOT/scripts/lib/apply-update.sh"

FAILURES=0
TESTS=0
pass() { TESTS=$((TESTS + 1)); printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { TESTS=$((TESTS + 1)); FAILURES=$((FAILURES + 1)); printf "  \033[31m✗\033[0m %s\n" "$1"; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# -----------------------------------------------------------------------------
# Fake docker (PATH shim)
# -----------------------------------------------------------------------------
STUB_BIN="$TMP/bin"
STUB_DIR="$TMP/stub-state"
mkdir -p "$STUB_BIN" "$STUB_DIR"

cat > "$STUB_BIN/docker" <<'EOF'
#!/usr/bin/env bash
# Fake docker for apply-update.test.sh: records every invocation and answers
# the small read surface apply-update.sh + the self-swap helper payload need.
set -u
mkdir -p "$DOCKER_STUB_DIR"
n=$(( $(cat "$DOCKER_STUB_DIR/count" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$DOCKER_STUB_DIR/count"
printf '%s\n' "$*" >> "$DOCKER_STUB_DIR/calls.log"
printf '%s\0' "$@" > "$DOCKER_STUB_DIR/call-$n"

case "${1:-}" in
  compose)
    # docker compose … ps -q orchestrator → the scripted container id.
    # docker compose … up …  → fail the recreate of any service named in
    #   DOCKER_STUB_FAIL_RECREATE (comma list) so the per-service capture
    #   path is exercised; the failing service is the LAST argv token.
    case "$*" in
      *" ps -q "*) printf '%s\n' "${DOCKER_STUB_PS_CID:-}" ;;
      *" up "*)
        svc="${!#}"
        case ",${DOCKER_STUB_FAIL_RECREATE:-}," in
          *",$svc,"*) echo "stub: recreate of $svc failed" >&2; exit 1 ;;
        esac
        ;;
    esac
    exit 0
    ;;
  ps)
    # WARP-1044 helper listing: scripted newline-joined container ids.
    printf '%s\n' "${DOCKER_STUB_PS_ALL_IDS:-}"
    exit 0
    ;;
  logs)
    # WARP-1044 log capture: scripted helper log content + exit code.
    printf '%s\n' "${DOCKER_STUB_LOGS:-stub helper logs}"
    exit "${DOCKER_STUB_LOGS_EXIT:-0}"
    ;;
  inspect)
    case "$*" in
      *finishedAt*)
        # WARP-1044 helper listing: scripted JSON lines (one per container).
        printf '%s\n' "${DOCKER_STUB_HELPER_JSON:-}"
        ;;
      *Mounts*)
        # Mounts listing: scripted "name|source|destination" lines.
        printf '%s\n' "${DOCKER_STUB_MOUNTS:-}"
        ;;
      *RepoDigests*)
        # RepoDigests listing (current-image-refs): scripted newline-joined
        # "repo@sha256:…" refs per DOCKER_STUB_REPO_DIGESTS; empty models a
        # locally-built, never-pushed image (zero RepoDigests).
        printf '%s' "${DOCKER_STUB_REPO_DIGESTS:-}"
        ;;
      *.Id*|*Image*)
        # Image ID fallback for a zero-RepoDigests image.
        printf '%s\n' "${DOCKER_STUB_IMAGE_ID:-}"
        ;;
      *State.Health*)
        # Healthcheck probe: healthy from the Nth call onward.
        h=$(( $(cat "$DOCKER_STUB_DIR/health-calls" 2>/dev/null || echo 0) + 1 ))
        echo "$h" > "$DOCKER_STUB_DIR/health-calls"
        if [ "$h" -ge "${DOCKER_STUB_HEALTHY_AFTER:-999}" ]; then
          echo healthy
        else
          echo starting
        fi
        ;;
    esac
    exit 0
    ;;
  run)
    echo "stub-helper-cid"
    exit 0
    ;;
esac
exit 0
EOF
chmod +x "$STUB_BIN/docker"

cat > "$STUB_BIN/cosign" <<EOF
#!/usr/bin/env bash
# Fake cosign for apply-update.test.sh (WARP-244): records the argv into the
# shared calls.log and obeys COSIGN_STUB_EXIT so tests drive both verdicts.
printf 'cosign %s\n' "\$*" >> "$STUB_DIR/calls.log"
exit "\${COSIGN_STUB_EXIT:-0}"
EOF
chmod +x "$STUB_BIN/cosign"

stub_reset() { rm -rf "$STUB_DIR"; mkdir -p "$STUB_DIR"; }

# Run apply-update.sh with the fake docker on PATH + the fixture updates dir.
run_apply() {
  PATH="$STUB_BIN:$PATH" \
  DOCKER_STUB_DIR="$STUB_DIR" \
  DOCKER_STUB_PS_CID="${DOCKER_STUB_PS_CID:-}" \
  DOCKER_STUB_MOUNTS="${DOCKER_STUB_MOUNTS:-}" \
  DOCKER_STUB_FAIL_RECREATE="${DOCKER_STUB_FAIL_RECREATE:-}" \
  DOCKER_STUB_REPO_DIGESTS="${DOCKER_STUB_REPO_DIGESTS:-}" \
  DOCKER_STUB_IMAGE_ID="${DOCKER_STUB_IMAGE_ID:-}" \
  DOCKER_STUB_PS_ALL_IDS="${DOCKER_STUB_PS_ALL_IDS:-}" \
  DOCKER_STUB_LOGS="${DOCKER_STUB_LOGS:-}" \
  DOCKER_STUB_LOGS_EXIT="${DOCKER_STUB_LOGS_EXIT:-0}" \
  DOCKER_STUB_HELPER_JSON="${DOCKER_STUB_HELPER_JSON:-}" \
  COSIGN_STUB_EXIT="${COSIGN_STUB_EXIT:-0}" \
  DROPLET_OTA_UPDATES_DIR="$UPDATES_DIR" \
  DROPLET_OTA_CONFIG_ROOT="${DROPLET_OTA_CONFIG_ROOT:-}" \
  bash "$APPLY_SH" "$@"
}

# -----------------------------------------------------------------------------
# Fixtures — a mini build:-only base compose (the exact shape that made the
# original stub a no-op) + runner-format overrides and services list.
# -----------------------------------------------------------------------------
FIXTURE="$TMP/fixture"
UPDATES_DIR="$FIXTURE/updates"
UPDATE_ID="du-test-1"
UDIR="$UPDATES_DIR/$UPDATE_ID"
mkdir -p "$UDIR" "$FIXTURE/ctx"

COMPOSE_FILE="$FIXTURE/docker-compose.yml"
cat > "$COMPOSE_FILE" <<EOF
services:
  orchestrator:
    build:
      context: ./ctx
  web-dashboard:
    build:
      context: ./ctx
  routing:
    build:
      context: ./ctx
EOF

HEX_A="$(printf 'a%.0s' $(seq 64))"
HEX_B="$(printf 'b%.0s' $(seq 64))"
HEX_C="$(printf 'c%.0s' $(seq 64))"
HEX_D="$(printf 'd%.0s' $(seq 64))"
HEX_E="$(printf 'e%.0s' $(seq 64))"
REL_ORCH="ghcr.io/dropletbywarplab/orchestrator@sha256:$HEX_A"
REL_DASH="ghcr.io/dropletbywarplab/web-dashboard@sha256:$HEX_B"
REL_ROUTING="ghcr.io/dropletbywarplab/routing@sha256:$HEX_C"
# Previous refs: one repo-digest ref + two bare image IDs (local builds) —
# both shapes must pin.
PREV_ORCH="sha256:$HEX_D"
PREV_DASH="ghcr.io/dropletbywarplab/web-dashboard@sha256:$HEX_E"
PREV_ROUTING="sha256:$HEX_A"

cat > "$UDIR/override-release.yml" <<EOF
# WARP-539 — test fixture in the exact runner-generated format
# (host-compose-runner.ts composeOverrideYaml).
services:
  web-dashboard:
    image: $REL_DASH
  routing:
    image: $REL_ROUTING
  orchestrator:
    image: $REL_ORCH
EOF

cat > "$UDIR/override-previous.yml" <<EOF
# WARP-539 — test fixture in the exact runner-generated format.
services:
  web-dashboard:
    image: $PREV_DASH
  routing:
    image: $PREV_ROUTING
  orchestrator:
    image: $PREV_ORCH
EOF

printf 'web-dashboard\nrouting\norchestrator\n' > "$UDIR/services.txt"

echo ""
echo "  ================================================"
echo "  apply-update.sh Integration Tests (WARP-539)"
echo "  ================================================"

# =============================================================================
# Phase 0 — current-image-refs must report the REGISTRY DIGEST (RepoDigests),
# NOT the local image ID. imageRefMatchesDigest (apply.ts) compares the
# reported ref against the manifest sha256; a bare image ID never matches a
# release digest, so a successful self-swap would be misdiagnosed as "still
# on the old image" and rolled back. (Romain review finding 1, WARP-539.)
# =============================================================================
echo ""
echo "--- Phase 0: current-image-refs reports the RepoDigest ---"

# A pulled/tagged image: docker inspect .RepoDigests carries repo@sha256:… .
stub_reset
export DOCKER_STUB_PS_CID="orch-cid"
REPO_REF="ghcr.io/dropletbywarplab/orchestrator@sha256:$HEX_A"
OUT="$(DOCKER_STUB_REPO_DIGESTS="$REPO_REF" DOCKER_STUB_IMAGE_ID="sha256:$HEX_D" \
  run_apply current-image-refs --compose-file "$COMPOSE_FILE" --services orchestrator 2>/dev/null)"
if [ "$OUT" = "{\"orchestrator\":\"$REPO_REF\"}" ]; then
  pass "current-image-refs reports the RepoDigest ref for a pulled image"
else
  fail "current-image-refs did not report the RepoDigest (got: $OUT)"
fi
if grep -q "index .Image" "$STUB_DIR/calls.log" 2>/dev/null; then
  fail "current-image-refs still inspects the local image ID ({{index .Image}})"
else
  pass "current-image-refs no longer inspects {{index .Image}}"
fi

# Multiple RepoDigests: match must resolve to a RepoDigest ref (not the ID).
stub_reset
export DOCKER_STUB_PS_CID="orch-cid"
MULTI="ghcr.io/mirror/orchestrator@sha256:$HEX_B
ghcr.io/dropletbywarplab/orchestrator@sha256:$HEX_A"
OUT="$(DOCKER_STUB_REPO_DIGESTS="$MULTI" DOCKER_STUB_IMAGE_ID="sha256:$HEX_D" \
  run_apply current-image-refs --compose-file "$COMPOSE_FILE" --services orchestrator 2>/dev/null)"
case "$OUT" in
  *"@sha256:$HEX_A"*|*"@sha256:$HEX_B"*)
    pass "current-image-refs picks a RepoDigest when several are present" ;;
  *) fail "current-image-refs did not pick a RepoDigest for a multi-digest image (got: $OUT)" ;;
esac

# Zero RepoDigests (locally-built, never pushed): fall back to the image ID
# EXPLICITLY (documented) — the previous-target rollback pin still resolves.
stub_reset
export DOCKER_STUB_PS_CID="orch-cid"
OUT="$(DOCKER_STUB_REPO_DIGESTS="" DOCKER_STUB_IMAGE_ID="sha256:$HEX_D" \
  run_apply current-image-refs --compose-file "$COMPOSE_FILE" --services orchestrator 2>/dev/null)"
if [ "$OUT" = "{\"orchestrator\":\"sha256:$HEX_D\"}" ]; then
  pass "current-image-refs falls back to the image ID when RepoDigests is empty"
else
  fail "current-image-refs did not fall back to the image ID for a local build (got: $OUT)"
fi

# No running container → null.
stub_reset
export DOCKER_STUB_PS_CID=""
OUT="$(run_apply current-image-refs --compose-file "$COMPOSE_FILE" --services orchestrator 2>/dev/null)"
if [ "$OUT" = '{"orchestrator":null}' ]; then
  pass "current-image-refs reports null for a service with no running container"
else
  fail "current-image-refs did not report null for an absent container (got: $OUT)"
fi
unset DOCKER_STUB_PS_CID DOCKER_STUB_REPO_DIGESTS DOCKER_STUB_IMAGE_ID

# =============================================================================
# Phase 1 — recreate-services: per-target pinning via the compose override
# =============================================================================
echo ""
echo "--- Phase 1: recreate-services per-target pinning ---"

stub_reset
if run_apply recreate-services --compose-file "$COMPOSE_FILE" \
    --update-id "$UPDATE_ID" --services web-dashboard,routing \
    --target release >/dev/null 2>&1; then
  pass "recreate-services --target release exits 0"
else
  fail "recreate-services --target release exited non-zero"
fi

for svc in web-dashboard routing; do
  if grep -qF -- "compose -f $COMPOSE_FILE -f $UDIR/override-release.yml up -d --no-deps --no-build --pull never --force-recreate $svc" \
      "$STUB_DIR/calls.log"; then
    pass "release recreate of $svc rides base + override-release.yml with --no-build --pull never"
  else
    fail "release recreate of $svc missing the pinned compose invocation (calls: $(cat "$STUB_DIR/calls.log" 2>/dev/null))"
  fi
done
if grep -q "override-previous.yml" "$STUB_DIR/calls.log"; then
  fail "release recreate must not touch the previous override"
else
  pass "release recreate never references override-previous.yml"
fi

stub_reset
if run_apply recreate-services --compose-file "$COMPOSE_FILE" \
    --update-id "$UPDATE_ID" --services web-dashboard,routing,orchestrator \
    --target previous >/dev/null 2>&1; then
  pass "recreate-services --target previous exits 0"
else
  fail "recreate-services --target previous exited non-zero"
fi
for svc in web-dashboard routing orchestrator; do
  if grep -qF -- "compose -f $COMPOSE_FILE -f $UDIR/override-previous.yml up -d --no-deps --no-build --pull never --force-recreate $svc" \
      "$STUB_DIR/calls.log"; then
    pass "previous recreate of $svc rides base + override-previous.yml"
  else
    fail "previous recreate of $svc missing the pinned compose invocation"
  fi
done

# Every `up` must carry a per-target override — an unpinned up on a
# build:-only service is exactly the original no-op bug.
if grep " up " "$STUB_DIR/calls.log" | grep -qv "override-"; then
  fail "found an un-pinned 'compose up' invocation (no override -f)"
else
  pass "every compose up invocation carries a per-target override"
fi

stub_reset
if run_apply recreate-services --compose-file "$COMPOSE_FILE" \
    --update-id du-missing --services web-dashboard \
    --target release >/dev/null 2>&1; then
  fail "recreate-services must die when the per-target override is missing"
else
  pass "recreate-services dies when the per-target override is missing"
fi
if grep -q " up " "$STUB_DIR/calls.log" 2>/dev/null; then
  fail "missing override still recreated a service (unpinned!)"
else
  pass "missing override recreates nothing"
fi

if run_apply recreate-services --compose-file "$COMPOSE_FILE" \
    --update-id "$UPDATE_ID" --services web-dashboard \
    --target sideways >/dev/null 2>&1; then
  fail "--target must reject values outside release|previous"
else
  pass "--target rejects values outside release|previous"
fi

# --- per-service failure capture: one failing recreate must NOT abort the
#     loop mid-way (leaving later services on the old digest); every service
#     is attempted and the failures are reported as a structured list.
#     (Romain review finding 2, WARP-539.) ---
stub_reset
FAIL_OUT="$(DOCKER_STUB_FAIL_RECREATE=routing \
  run_apply recreate-services --compose-file "$COMPOSE_FILE" \
  --update-id "$UPDATE_ID" --services web-dashboard,routing,orchestrator \
  --target release 2>/dev/null)"; FAIL_RC=$?
if [ "$FAIL_RC" -ne 0 ]; then
  pass "recreate-services exits non-zero when a service fails to recreate"
else
  fail "recreate-services returned 0 despite a failed recreate"
fi
# Every service is attempted — the loop did NOT abort after routing failed.
for svc in web-dashboard routing orchestrator; do
  if grep -qF -- "--force-recreate $svc" "$STUB_DIR/calls.log"; then
    pass "recreate-services attempted $svc despite an earlier failure"
  else
    fail "recreate-services skipped $svc — the loop aborted mid-way"
  fi
done
# The outcome names the failed service in a structured (JSON) failure list.
if printf '%s' "$FAIL_OUT" | grep -q '"failed"' && printf '%s' "$FAIL_OUT" | grep -q 'routing'; then
  pass "recreate-services reports a structured failure list naming the failed service"
else
  fail "recreate-services failure output not structured/observable (got: $FAIL_OUT)"
fi
# A clean run reports no failures (empty list) and exits 0.
stub_reset
OK_OUT="$(run_apply recreate-services --compose-file "$COMPOSE_FILE" \
  --update-id "$UPDATE_ID" --services web-dashboard,routing \
  --target release 2>/dev/null)"; OK_RC=$?
if [ "$OK_RC" -eq 0 ] && printf '%s' "$OK_OUT" | grep -q '"failed":\[\]'; then
  pass "recreate-services reports an empty failure list on a clean run"
else
  fail "recreate-services clean run not reported as empty failures (rc=$OK_RC out=$OK_OUT)"
fi

# =============================================================================
# Phase 2 — resolved image refs: base + override must RESOLVE per service
# (real `docker compose config`, client-side; this is the merge strategy that
# gives build:-only services their image: key)
# =============================================================================
echo ""
echo "--- Phase 2: merged compose config resolves the pinned refs ---"

resolved_image() { # $1 = override file, $2 = service name
  docker compose -f "$COMPOSE_FILE" -f "$1" config 2>/dev/null \
    | awk -v svc="$2" '
        /^  [a-z0-9-]+:$/ { cur = substr($1, 1, length($1) - 1) }
        cur == svc && $1 == "image:" { print $2; exit }'
}

if docker compose version >/dev/null 2>&1; then
  for spec in \
      "override-release.yml orchestrator $REL_ORCH" \
      "override-release.yml web-dashboard $REL_DASH" \
      "override-release.yml routing $REL_ROUTING" \
      "override-previous.yml orchestrator $PREV_ORCH" \
      "override-previous.yml web-dashboard $PREV_DASH" \
      "override-previous.yml routing $PREV_ROUTING"; do
    read -r ov svc want <<< "$spec"
    got="$(resolved_image "$UDIR/$ov" "$svc")"
    if [ "$got" = "$want" ]; then
      pass "$ov resolves $svc -> pinned ref"
    else
      fail "$ov resolves $svc -> '$got' (wanted '$want')"
    fi
  done
else
  # FAIL, never skip — the pinning contract is unverifiable without compose.
  fail "docker compose CLI unavailable — cannot verify the merged image resolution"
fi

# =============================================================================
# Phase 3 — recreate-self-detached: launch surface + the helper payload's
# wait-then-rollback behaviour (executed under the fake docker)
# =============================================================================
echo ""
echo "--- Phase 3: detached self-swap helper ---"

stub_reset
export DOCKER_STUB_PS_CID="orch-cid-123"
export DOCKER_STUB_MOUNTS="ota-updates|/var/lib/docker/volumes/ota-updates/_data|$UPDATES_DIR"
if DROPLET_OTA_SELF_HEALTH_ATTEMPTS=3 DROPLET_OTA_SELF_HEALTH_INTERVAL_SECONDS=0 \
    run_apply recreate-self-detached --compose-file "$COMPOSE_FILE" \
    --update-id "$UPDATE_ID" --target release >/dev/null 2>&1; then
  pass "recreate-self-detached exits 0 after launching the helper"
else
  fail "recreate-self-detached exited non-zero"
fi

RUN_LINE="$(grep '^run ' "$STUB_DIR/calls.log" 2>/dev/null || true)"
for want in \
    "-v /var/run/docker.sock:/var/run/docker.sock" \
    "-v $COMPOSE_FILE:$COMPOSE_FILE:ro" \
    "-v ota-updates:$UPDATES_DIR:ro" \
    "docker:27-cli"; do
  if [[ "$RUN_LINE" == *"$want"* ]]; then
    pass "helper launch carries '$want'"
  else
    fail "helper launch missing '$want' (got: $RUN_LINE)"
  fi
done

# Rollback forensics (Romain review finding 3): the helper must NOT be
# launched with --rm (its logs are the only forensic trail if rollback
# itself fails on an unattended fleet), and a `docker rm -f
# droplet-ota-self-swap-<id>` collision guard must run BEFORE the launch so
# a retried apply for the same update id can't hit a name clash.
if [[ "$RUN_LINE" == *" --rm "* ]]; then
  fail "helper launch still uses --rm — rollback logs would be destroyed on exit"
else
  pass "helper launch drops --rm (logs survive for post-rollback forensics)"
fi
if grep -qF -- "rm -f droplet-ota-self-swap-$UPDATE_ID" "$STUB_DIR/calls.log"; then
  pass "a docker rm -f collision guard runs before the helper launch"
else
  fail "no docker rm -f collision guard before the helper launch"
fi
# Ordering: the collision guard must precede the launch.
GUARD_N="$(grep -n "rm -f droplet-ota-self-swap-$UPDATE_ID" "$STUB_DIR/calls.log" | head -1 | cut -d: -f1)"
RUN_N="$(grep -n '^run ' "$STUB_DIR/calls.log" | head -1 | cut -d: -f1)"
if [ -n "$GUARD_N" ] && [ -n "$RUN_N" ] && [ "$GUARD_N" -lt "$RUN_N" ]; then
  pass "collision guard is recorded before the helper launch"
else
  fail "collision guard did not precede the helper launch (guard=$GUARD_N run=$RUN_N)"
fi

# Extract the helper's argv: the recorded `docker run …` call.
HELPER_CALL=""
for f in "$STUB_DIR"/call-*; do
  mapfile -d '' -t argv < "$f"
  if [ "${argv[0]:-}" = "run" ]; then HELPER_CALL="$f"; fi
done
if [ -n "$HELPER_CALL" ]; then
  pass "helper docker run argv captured"
else
  fail "no docker run invocation recorded"
fi

mapfile -d '' -t HELPER_ARGV < "$HELPER_CALL"
HELPER_PAYLOAD="${HELPER_ARGV[$((${#HELPER_ARGV[@]} - 1))]}"
HELPER_ENVS=()
i=0
while [ "$i" -lt "${#HELPER_ARGV[@]}" ]; do
  if [ "${HELPER_ARGV[$i]}" = "-e" ]; then
    HELPER_ENVS+=("${HELPER_ARGV[$((i + 1))]}")
  fi
  i=$((i + 1))
done

# Run the payload EXACTLY as the helper container would: POSIX sh, the -e
# environment from the recorded launch, docker resolved via PATH.
run_helper_payload() {
  (
    export PATH="$STUB_BIN:$PATH" DOCKER_STUB_DIR="$STUB_DIR"
    export DOCKER_STUB_PS_CID DOCKER_STUB_MOUNTS DOCKER_STUB_HEALTHY_AFTER
    local kv
    for kv in "${HELPER_ENVS[@]}"; do export "${kv?}"; done
    sh -c "$HELPER_PAYLOAD"
  )
}

# --- healthy path: swap holds, nothing rolls back ---
stub_reset
DOCKER_STUB_PS_CID="new-orch-cid"
DOCKER_STUB_HEALTHY_AFTER=2
if run_helper_payload >/dev/null 2>&1; then
  pass "helper payload exits 0 when the recreated orchestrator goes healthy"
else
  fail "helper payload exited non-zero on the healthy path"
fi
if grep -qF -- "compose -f $COMPOSE_FILE -f $UDIR/override-release.yml up -d --no-deps --no-build --pull never --force-recreate orchestrator" \
    "$STUB_DIR/calls.log"; then
  pass "helper recreates the orchestrator pinned to the RELEASE override"
else
  fail "helper did not recreate the orchestrator on the release override"
fi
if grep -q "override-previous.yml" "$STUB_DIR/calls.log"; then
  fail "healthy path must not roll anything back"
else
  pass "healthy path rolls nothing back"
fi

# --- timeout path: bounded wait, then EVERY service back to previous ---
stub_reset
DOCKER_STUB_PS_CID="new-orch-cid"
DOCKER_STUB_HEALTHY_AFTER=999
if run_helper_payload >/dev/null 2>&1; then
  pass "helper payload exits 0 after a successful full rollback"
else
  fail "helper payload exited non-zero after the rollback path"
fi
if [ "$(cat "$STUB_DIR/health-calls" 2>/dev/null || echo 0)" = "3" ]; then
  pass "helper polled the healthcheck exactly DROPLET_OTA_SELF_HEALTH_ATTEMPTS (3) times"
else
  fail "helper health poll count != 3 (got $(cat "$STUB_DIR/health-calls" 2>/dev/null || echo 0))"
fi
for svc in web-dashboard routing orchestrator; do
  if grep -qF -- "compose -f $COMPOSE_FILE -f $UDIR/override-previous.yml up -d --no-deps --no-build --pull never --force-recreate $svc" \
      "$STUB_DIR/calls.log"; then
    pass "timeout rollback recreates $svc on the PREVIOUS override"
  else
    fail "timeout rollback missing $svc"
  fi
done

# --- launch preconditions: refuse to launch a helper that cannot roll back ---
stub_reset
if DROPLET_OTA_SELF_HEALTH_ATTEMPTS=3 DROPLET_OTA_SELF_HEALTH_INTERVAL_SECONDS=0 \
    run_apply recreate-self-detached --compose-file "$COMPOSE_FILE" \
    --update-id du-missing --target release >/dev/null 2>&1; then
  fail "recreate-self-detached must die when overrides/services.txt are missing"
else
  pass "recreate-self-detached dies when overrides/services.txt are missing"
fi
if grep -q '^run ' "$STUB_DIR/calls.log" 2>/dev/null; then
  fail "a helper was launched despite missing rollback material"
else
  pass "no helper launched when rollback material is missing"
fi

unset DOCKER_STUB_PS_CID DOCKER_STUB_MOUNTS DOCKER_STUB_HEALTHY_AFTER

# =============================================================================
# Phase 4 — dry-run hook still short-circuits every daemon op
# =============================================================================
echo ""
echo "--- Phase 4: dry-run hook ---"

DRY_OUT="$(DROPLET_OTA_APPLY_DRY_RUN=1 DROPLET_OTA_UPDATES_DIR="$UPDATES_DIR" \
  bash "$APPLY_SH" recreate-services --compose-file "$COMPOSE_FILE" \
  --update-id "$UPDATE_ID" --services web-dashboard --target release 2>/dev/null)"
if printf '%s\n' "$DRY_OUT" | grep -q "^DRY-RUN: docker compose .*override-release.yml.*web-dashboard"; then
  pass "dry-run prints the pinned compose command without running it"
else
  fail "dry-run output missing the pinned compose command (got: $DRY_OUT)"
fi

# =============================================================================
echo ""
echo "--- Phase 5: pull-images signature gate (WARP-244) ---"

# 5a. Rejected signature → NO docker pull, non-zero exit, canonical marker.
stub_reset
GATE_OUT="$(COSIGN_STUB_EXIT=1 run_apply pull-images --images "$REL_ORCH" "$REL_DASH" 2>&1)"
GATE_RC=$?
if [ "$GATE_RC" -ne 0 ] && printf '%s' "$GATE_OUT" | grep -q "image-verify:"; then
  pass "pull-images refuses a rejected signature (rc=$GATE_RC, image-verify: marker present)"
else
  fail "pull-images did not refuse on cosign rejection (rc=$GATE_RC, out: $GATE_OUT)"
fi
if grep -q "^pull " "$STUB_DIR/calls.log" 2>/dev/null; then
  fail "docker pull ran despite a rejected signature (fail-open!)"
else
  pass "no docker pull was attempted after the cosign refusal (fail closed)"
fi

# 5b. Verified signature → verify runs BEFORE pull, with the exact policy flags.
stub_reset
run_apply pull-images --images "$REL_ORCH" >/dev/null 2>&1
VERIFY_LINE=$(grep -n "^cosign verify" "$STUB_DIR/calls.log" 2>/dev/null | head -1 | cut -d: -f1)
PULL_LINE=$(grep -n "^pull " "$STUB_DIR/calls.log" 2>/dev/null | head -1 | cut -d: -f1)
if [ -n "$VERIFY_LINE" ] && [ -n "$PULL_LINE" ] && [ "$VERIFY_LINE" -lt "$PULL_LINE" ]; then
  pass "cosign verify precedes docker pull"
else
  fail "verify/pull ordering wrong (verify=$VERIFY_LINE pull=$PULL_LINE, calls: $(cat "$STUB_DIR/calls.log" 2>/dev/null))"
fi
if grep "^cosign verify" "$STUB_DIR/calls.log" | grep -q -- "--certificate-identity-regexp" \
   && grep "^cosign verify" "$STUB_DIR/calls.log" | grep -q "droplet-onboard-services" \
   && grep "^cosign verify" "$STUB_DIR/calls.log" | grep -q -- "--offline=true"; then
  pass "verify carries the org-repo identity policy + --offline"
else
  fail "verify invocation missing policy flags (calls: $(cat "$STUB_DIR/calls.log" 2>/dev/null))"
fi

# 5c. Dry-run stays side-effect-free and prints the verify it WOULD run.
DRY_PULL_OUT="$(DROPLET_OTA_APPLY_DRY_RUN=1 DROPLET_OTA_UPDATES_DIR="$UPDATES_DIR" \
  bash "$APPLY_SH" pull-images --images "$REL_ORCH" 2>/dev/null)"
if printf '%s\n' "$DRY_PULL_OUT" | grep -q "^DRY-RUN: cosign verify" \
   && printf '%s\n' "$DRY_PULL_OUT" | grep -q "^DRY-RUN: docker pull"; then
  pass "dry-run prints verify + pull without executing either"
else
  fail "dry-run output missing verify/pull commands (got: $DRY_PULL_OUT)"
fi

# =============================================================================
echo ""
echo "--- Phase 6: self-swap helper GC surface (WARP-1044) ---"

# 6a. list-self-swap-helpers: filters on the helper name prefix, -a (exited
#     containers are the whole point), and prints the inspect JSON verbatim.
stub_reset
HELPER_JSON_1='{"name":"/droplet-ota-self-swap-du-test-1","status":"exited","finishedAt":"2026-06-01T03:00:00Z"}'
HELPER_JSON_2='{"name":"/droplet-ota-self-swap-du-test-2","status":"running","finishedAt":"0001-01-01T00:00:00Z"}'
LIST_OUT="$(DOCKER_STUB_PS_ALL_IDS=$'cid1\ncid2' \
  DOCKER_STUB_HELPER_JSON="$HELPER_JSON_1
$HELPER_JSON_2" \
  run_apply list-self-swap-helpers 2>/dev/null)"
if [ "$LIST_OUT" = "$HELPER_JSON_1
$HELPER_JSON_2" ]; then
  pass "list-self-swap-helpers prints one JSON object per container"
else
  fail "list-self-swap-helpers output wrong (got: $LIST_OUT)"
fi
if grep -q "^ps -a --filter name=droplet-ota-self-swap-" "$STUB_DIR/calls.log"; then
  pass "listing rides docker ps -a filtered on the helper name prefix"
else
  fail "listing missing the ps -a name filter (calls: $(cat "$STUB_DIR/calls.log" 2>/dev/null))"
fi

# 6b. No helpers on the box → empty output, exit 0, no inspect round-trip.
stub_reset
LIST_OUT="$(DOCKER_STUB_PS_ALL_IDS="" run_apply list-self-swap-helpers 2>/dev/null)"; LIST_RC=$?
if [ "$LIST_RC" -eq 0 ] && [ -z "$LIST_OUT" ] && ! grep -q "^inspect" "$STUB_DIR/calls.log" 2>/dev/null; then
  pass "list-self-swap-helpers is a clean no-op when no helpers exist"
else
  fail "empty listing misbehaved (rc=$LIST_RC out=$LIST_OUT)"
fi

# 6c. capture-self-swap-logs persists BOTH streams of the helper's docker
#     logs into the update's state dir (the container is the only log store).
stub_reset
rm -f "$UDIR/self-swap-helper.log"
if DOCKER_STUB_LOGS="[ota-self-swap] rollback: recreating routing" \
    run_apply capture-self-swap-logs --update-id "$UPDATE_ID" >/dev/null 2>&1; then
  pass "capture-self-swap-logs exits 0"
else
  fail "capture-self-swap-logs exited non-zero"
fi
if grep -qF "[ota-self-swap] rollback: recreating routing" "$UDIR/self-swap-helper.log" 2>/dev/null; then
  pass "capture-self-swap-logs writes <updatesDir>/<id>/self-swap-helper.log"
else
  fail "self-swap-helper.log missing or wrong (got: $(cat "$UDIR/self-swap-helper.log" 2>/dev/null))"
fi
if grep -q "^logs droplet-ota-self-swap-$UPDATE_ID\$" "$STUB_DIR/calls.log"; then
  pass "capture reads docker logs of the id-derived helper name"
else
  fail "capture did not docker-logs the helper (calls: $(cat "$STUB_DIR/calls.log" 2>/dev/null))"
fi
rm -f "$UDIR/self-swap-helper.log"

# A failed docker logs must leave NOTHING behind: an existing
# self-swap-helper.log tells the GC caller the capture is DONE, so a
# poisoned partial file would skip the real capture forever.
stub_reset
if DOCKER_STUB_LOGS_EXIT=1 run_apply capture-self-swap-logs --update-id "$UPDATE_ID" >/dev/null 2>&1; then
  fail "capture-self-swap-logs exited 0 despite docker logs failing"
else
  pass "capture-self-swap-logs propagates a docker logs failure"
fi
if [ -f "$UDIR/self-swap-helper.log" ] || [ -f "$UDIR/self-swap-helper.log.tmp" ]; then
  fail "failed capture left a (partial) log file behind"
  rm -f "$UDIR/self-swap-helper.log" "$UDIR/self-swap-helper.log.tmp"
else
  pass "failed capture leaves no partial log file behind"
fi

# 6d. rm-self-swap-helper removes by id-derived name and NEVER forces —
#     the daemon's refusal to rm a running container is the last-line guard.
stub_reset
if run_apply rm-self-swap-helper --update-id "$UPDATE_ID" >/dev/null 2>&1; then
  pass "rm-self-swap-helper exits 0"
else
  fail "rm-self-swap-helper exited non-zero"
fi
if grep -q "^rm droplet-ota-self-swap-$UPDATE_ID\$" "$STUB_DIR/calls.log"; then
  pass "removal is a plain docker rm of the id-derived helper name"
else
  fail "removal invocation wrong (calls: $(cat "$STUB_DIR/calls.log" 2>/dev/null))"
fi
if grep -q "^rm -f" "$STUB_DIR/calls.log"; then
  fail "GC removal used -f — a running helper could be killed mid-rollback"
else
  pass "GC removal never uses -f (a running helper survives the race)"
fi

# 6e. A hostile update id dies in validation before any docker call.
stub_reset
if run_apply rm-self-swap-helper --update-id 'du;evil' >/dev/null 2>&1; then
  fail "rm-self-swap-helper accepted an invalid update id"
else
  pass "rm-self-swap-helper rejects an invalid update id"
fi
if [ -s "$STUB_DIR/calls.log" ]; then
  fail "an invalid update id still reached docker"
else
  pass "no docker call for an invalid update id"
fi

# 6f. Dry-run stays side-effect-free for the whole GC surface.
DRY_GC_OUT="$(DROPLET_OTA_APPLY_DRY_RUN=1 DROPLET_OTA_UPDATES_DIR="$UPDATES_DIR" \
  bash "$APPLY_SH" capture-self-swap-logs --update-id "$UPDATE_ID" 2>/dev/null; \
  DROPLET_OTA_APPLY_DRY_RUN=1 DROPLET_OTA_UPDATES_DIR="$UPDATES_DIR" \
  bash "$APPLY_SH" rm-self-swap-helper --update-id "$UPDATE_ID" 2>/dev/null)"
if printf '%s\n' "$DRY_GC_OUT" | grep -q "^DRY-RUN: docker logs droplet-ota-self-swap-$UPDATE_ID" \
   && printf '%s\n' "$DRY_GC_OUT" | grep -q "^DRY-RUN: docker rm droplet-ota-self-swap-$UPDATE_ID" \
   && [ ! -f "$UDIR/self-swap-helper.log" ]; then
  pass "dry-run prints the GC commands without touching anything"
else
  fail "dry-run GC output/side-effects wrong (got: $DRY_GC_OUT)"
fi

# =============================================================================
# 7. WARP-1669 — config-tree paths: the tar round-trip CI packs and the
#    device unpacks. These are the assertions that were missing when
#    stage-configs shipped double-nesting every deployment.
# =============================================================================
echo ""
echo "  7. Config tree: pack like CI, extract like the device"

# A deployment laid out exactly like the real one: <root>/docker/<compose>.
CFG_ROOT="$TMP/cfgroot"
mkdir -p "$CFG_ROOT/docker/nginx"
cat > "$CFG_ROOT/docker/docker-compose.yml" <<'EOF'
services:
  orchestrator:
    image: placeholder
EOF
echo "old-nginx" > "$CFG_ROOT/docker/nginx/nginx.conf"
echo "keep-me" > "$CFG_ROOT/untracked-runtime-state"

# configs.tar.gz exactly as publish-release.yml builds it: `git archive
# HEAD docker`, so every entry is prefixed `docker/`.
NEWCFG="$TMP/newcfg"
mkdir -p "$NEWCFG/docker/nginx"
cat > "$NEWCFG/docker/docker-compose.yml" <<'EOF'
services:
  orchestrator:
    image: shipped-by-release
EOF
echo "new-nginx" > "$NEWCFG/docker/nginx/nginx.conf"
CONFIGS_TAR="$TMP/configs.tar.gz"
tar -czf "$CONFIGS_TAR" -C "$NEWCFG" docker

CFG_UPDATE_ID="du-cfg-1"
CFG_UDIR="$UPDATES_DIR/$CFG_UPDATE_ID"
mkdir -p "$CFG_UDIR/backup"

# 7a. snapshot packs ONLY the config subdir — not the whole repo root.
run_apply snapshot --update-id "$CFG_UPDATE_ID" \
  --compose-file "$CFG_ROOT/docker/docker-compose.yml" \
  --backup-dir "$CFG_UDIR/backup" >/dev/null 2>&1 || true
PRE_TAR="$CFG_UDIR/backup/configs-pre-image.tar.gz"
if [ -f "$PRE_TAR" ] \
   && tar -tzf "$PRE_TAR" | grep -q "^docker/docker-compose.yml$" \
   && ! tar -tzf "$PRE_TAR" | grep -q "untracked-runtime-state"; then
  pass "snapshot packs the docker/ subtree only, rooted the same way as the release tar"
else
  fail "snapshot tar has the wrong root/scope (entries: $(tar -tzf "$PRE_TAR" 2>/dev/null | tr '\n' ' '))"
fi

# 7b. stage-configs lands the release configs OVER the live tree — not in a
#     nested docker/docker/. This is the defect: tar happily creates the
#     nested path, the stack keeps reading the real one, and the update
#     reports success having changed nothing.
run_apply stage-configs --update-id "$CFG_UPDATE_ID" \
  --compose-file "$CFG_ROOT/docker/docker-compose.yml" \
  --configs-tar "$CONFIGS_TAR" >/dev/null 2>&1
if grep -q "shipped-by-release" "$CFG_ROOT/docker/docker-compose.yml" \
   && [ ! -e "$CFG_ROOT/docker/docker" ]; then
  pass "stage-configs extracts to <root>/docker, never <root>/docker/docker"
else
  fail "stage-configs double-nested or missed (docker/docker exists: $([ -e "$CFG_ROOT/docker/docker" ] && echo yes || echo no))"
fi

# 7c. restore-configs puts the pre-image back — the rollback half of 7b. It
#     reads the snapshot 7a already wrote at the canonical backup path.
run_apply restore-configs --update-id "$CFG_UPDATE_ID" \
  --compose-file "$CFG_ROOT/docker/docker-compose.yml" >/dev/null 2>&1
if grep -q "placeholder" "$CFG_ROOT/docker/docker-compose.yml" \
   && grep -q "old-nginx" "$CFG_ROOT/docker/nginx/nginx.conf" \
   && [ ! -e "$CFG_ROOT/docker/docker" ]; then
  pass "restore-configs rolls the tree back to the snapshot"
else
  fail "restore-configs did not restore the pre-image tree"
fi

# 7d. An explicit DROPLET_OTA_CONFIG_ROOT still wins over the derivation,
#     for layouts that don't put the compose file one level down.
ALT_ROOT="$TMP/altroot"
mkdir -p "$ALT_ROOT"
DROPLET_OTA_CONFIG_ROOT="$ALT_ROOT" run_apply stage-configs \
  --update-id "$CFG_UPDATE_ID" \
  --compose-file "$CFG_ROOT/docker/docker-compose.yml" \
  --configs-tar "$CONFIGS_TAR" >/dev/null 2>&1
if [ -f "$ALT_ROOT/docker/docker-compose.yml" ]; then
  pass "DROPLET_OTA_CONFIG_ROOT overrides the compose-relative derivation"
else
  fail "explicit DROPLET_OTA_CONFIG_ROOT was ignored"
fi

# =============================================================================
# Summary
# =============================================================================
echo ""
echo "  ================================================"
if [ "$FAILURES" -eq 0 ]; then
  printf "  \033[32mAll %d tests passed.\033[0m\n" "$TESTS"
  exit 0
else
  printf "  \033[31m%d of %d tests FAILED.\033[0m\n" "$FAILURES" "$TESTS"
  exit 1
fi
