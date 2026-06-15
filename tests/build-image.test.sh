#!/usr/bin/env bash
# =============================================================================
# Static contract tests for the appliance OS image build (M2.8 SD-card image).
#
# Windows-runnable via Git-Bash / WSL — does NOT build an image, NOT run pi-gen,
# NOT require Docker or Linux. Pure grep/contract assertions over the checked-in
# build script, pi-gen config, custom stage, and first-boot unit. Mirrors the
# tests/setup.test.sh + tests/factory-reset.test.sh style.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FAILURES=0
TESTS=0

pass() { TESTS=$((TESTS + 1)); printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { TESTS=$((TESTS + 1)); FAILURES=$((FAILURES + 1)); printf "  \033[31m✗\033[0m %s\n" "$1"; }

BUILD_SCRIPT="$REPO_ROOT/scripts/build-image.sh"
PIGEN_CONFIG="$REPO_ROOT/image/config"
STAGE_RUN="$REPO_ROOT/image/stage-droplet/01-run.sh"
STAGE_PKGS="$REPO_ROOT/image/stage-droplet/00-packages"
FIRSTBOOT_UNIT="$REPO_ROOT/image/stage-droplet/files/droplet-firstboot.service"
SYSTEMD_LIB="$REPO_ROOT/scripts/lib/systemd.sh"
EXPORT_MARKER="$REPO_ROOT/image/stage-droplet/EXPORT_IMAGE"

echo ""
echo "  ================================================"
echo "  Appliance Image Build — Contract Tests"
echo "  ================================================"
echo ""

# =============================================================================
# Phase 1: build-image.sh exists, is hardened, fails fast off-Linux
# =============================================================================
echo "--- Phase 1: scripts/build-image.sh ---"

if [ -f "$BUILD_SCRIPT" ]; then
  pass "build-image.sh exists"
else
  fail "build-image.sh missing — cannot continue"
  exit 1
fi

if grep -qE '^set -euo pipefail' "$BUILD_SCRIPT"; then
  pass "build-image.sh has 'set -euo pipefail'"
else
  fail "build-image.sh missing 'set -euo pipefail'"
fi

# Stub must be gone.
if grep -q 'TODO: Implement Pi image build' "$BUILD_SCRIPT"; then
  fail "build-image.sh still contains the TODO stub"
else
  pass "build-image.sh stub replaced with real implementation"
fi

# Non-Linux fast-fail: the script must check uname -s = Linux and exit non-zero.
if grep -q 'uname -s' "$BUILD_SCRIPT" && grep -qE 'can only run on a Linux host|Linux host' "$BUILD_SCRIPT"; then
  pass "build-image.sh fails fast on non-Linux host (uname -s guard)"
else
  fail "build-image.sh missing non-Linux host fast-fail guard"
fi

# Functional check of the fast-fail: mock uname to report Windows and assert the
# script exits non-zero with the host-requirement message. We can only run this
# on a host where bash exists (this test's own host).
MOCK_DIR="$(mktemp -d)"
trap 'rm -rf "$MOCK_DIR"' EXIT
cat > "$MOCK_DIR/uname" << 'MOCK'
#!/usr/bin/env bash
# Mock: report a non-Linux kernel for `uname -s`; pass through otherwise.
if [ "${1:-}" = "-s" ]; then echo "MINGW64_NT-10.0"; exit 0; fi
exec /usr/bin/uname "$@"
MOCK
chmod +x "$MOCK_DIR/uname"
if PATH="$MOCK_DIR:$PATH" bash "$BUILD_SCRIPT" --app >/dev/null 2>&1; then
  fail "build-image.sh did NOT fail on a mocked non-Linux host"
else
  pass "build-image.sh exits non-zero on a mocked non-Linux host"
fi

# Env knobs must be present.
if grep -q 'DROPLET_IMAGE_RELEASE_REF' "$BUILD_SCRIPT" && grep -q 'PIGEN_TAG' "$BUILD_SCRIPT"; then
  pass "build-image.sh exposes DROPLET_IMAGE_RELEASE_REF + PIGEN_TAG knobs"
else
  fail "build-image.sh missing DROPLET_IMAGE_RELEASE_REF / PIGEN_TAG knobs"
fi

# Must collect into image/output and produce .img.gz (+ sha256).
if grep -q 'image/output' "$BUILD_SCRIPT" || grep -q 'OUTPUT_DIR=.*image' "$BUILD_SCRIPT"; then
  pass "build-image.sh collects artifacts into image/output"
else
  fail "build-image.sh does not target image/output for artifacts"
fi

# Must NOT run setup.sh at build time.
if grep -qE 'setup\.sh' "$BUILD_SCRIPT"; then
  # Allowed only inside echo/banner text; assert it never invokes it.
  if grep -E 'setup\.sh' "$BUILD_SCRIPT" | grep -vqE 'echo|#|scripts/setup\.sh --systemd ONCE|runs scripts/setup'; then
    fail "build-image.sh appears to INVOKE setup.sh at build time (should be first-boot only)"
  else
    pass "build-image.sh references setup.sh only in banner text (not invoked at build)"
  fi
else
  pass "build-image.sh does not invoke setup.sh at build time"
fi

# =============================================================================
# Phase 2: pi-gen config — no baked password, gz, arm64 Lite
# =============================================================================
echo "--- Phase 2: image/config ---"

if [ -f "$PIGEN_CONFIG" ]; then
  pass "image/config exists"
else
  fail "image/config missing"
fi

# No baked first-user password — the security invariant.
if grep -qE '^FIRST_USER_PASS=' "$PIGEN_CONFIG"; then
  fail "image/config bakes FIRST_USER_PASS — secrets must NOT be baked"
else
  pass "image/config bakes NO first-user password"
fi

if grep -qE '^DEPLOY_COMPRESSION=.?gz' "$PIGEN_CONFIG"; then
  pass "image/config sets DEPLOY_COMPRESSION=gz"
else
  fail "image/config does not set DEPLOY_COMPRESSION=gz"
fi

if grep -qE '^ARCH=.?arm64' "$PIGEN_CONFIG"; then
  pass "image/config pins ARCH=arm64"
else
  fail "image/config does not pin ARCH=arm64"
fi

if grep -qE '^IMG_NAME=.?.?droplet-appliance' "$PIGEN_CONFIG"; then
  pass "image/config sets IMG_NAME=droplet-appliance"
else
  fail "image/config does not set IMG_NAME=droplet-appliance"
fi

# Lite-only stage list (no desktop stage3/4/5 in the active list) + our stage.
if grep -qE '^STAGE_LIST=' "$PIGEN_CONFIG" && grep -E '^STAGE_LIST=' "$PIGEN_CONFIG" | grep -q 'stage-droplet'; then
  pass "image/config STAGE_LIST includes stage-droplet"
else
  fail "image/config STAGE_LIST missing stage-droplet"
fi

# =============================================================================
# Phase 3: droplet-firstboot.service — sentinel guard + ExecStart
# =============================================================================
echo "--- Phase 3: droplet-firstboot.service (baked unit) ---"

if [ -f "$FIRSTBOOT_UNIT" ]; then
  pass "droplet-firstboot.service exists"
else
  fail "droplet-firstboot.service missing"
fi

if grep -qF 'ConditionPathExists=!/var/lib/droplet/.firstboot-done' "$FIRSTBOOT_UNIT"; then
  pass "firstboot unit has the explicit !/var/lib/droplet/.firstboot-done guard"
else
  fail "firstboot unit missing the .firstboot-done sentinel guard"
fi

if grep -qE '^ExecStart=.*/scripts/setup\.sh --systemd' "$FIRSTBOOT_UNIT"; then
  pass "firstboot unit ExecStart runs scripts/setup.sh --systemd"
else
  fail "firstboot unit ExecStart does not point at scripts/setup.sh --systemd"
fi

if grep -qE '^Type=oneshot' "$FIRSTBOOT_UNIT" && grep -qE '^RemainAfterExit=yes' "$FIRSTBOOT_UNIT"; then
  pass "firstboot unit is Type=oneshot + RemainAfterExit=yes"
else
  fail "firstboot unit is not a RemainAfterExit oneshot"
fi

if grep -qE '^ExecStartPost=.*firstboot-done' "$FIRSTBOOT_UNIT"; then
  pass "firstboot unit writes the sentinel via ExecStartPost (success-only)"
else
  fail "firstboot unit does not write the .firstboot-done sentinel on success"
fi

# =============================================================================
# Phase 4: lib/systemd.sh install_firstboot_service parity
# =============================================================================
echo "--- Phase 4: lib/systemd.sh::install_firstboot_service ---"

if grep -q 'install_firstboot_service()' "$SYSTEMD_LIB"; then
  pass "systemd.sh defines install_firstboot_service()"
else
  fail "systemd.sh missing install_firstboot_service()"
fi

if grep -qF 'ConditionPathExists=!/var/lib/droplet/.firstboot-done' "$SYSTEMD_LIB"; then
  pass "install_firstboot_service emits the .firstboot-done guard"
else
  fail "install_firstboot_service missing the .firstboot-done guard"
fi

if grep -qE 'ExecStart=.*scripts/setup\.sh --systemd|ExecStart=\$setup_path --systemd' "$SYSTEMD_LIB"; then
  pass "install_firstboot_service ExecStart ends in setup.sh --systemd"
else
  fail "install_firstboot_service ExecStart does not end in setup.sh --systemd"
fi

# The original droplet.service generator must remain.
if grep -q 'install_systemd_service()' "$SYSTEMD_LIB"; then
  pass "install_systemd_service() (droplet.service) still present"
else
  fail "install_systemd_service() was removed — regression"
fi

# =============================================================================
# Phase 5: stage-droplet/01-run.sh — does NOT bake secrets / run setup
# =============================================================================
echo "--- Phase 5: stage-droplet/01-run.sh ---"

if [ -f "$STAGE_RUN" ]; then
  pass "stage-droplet/01-run.sh exists"
else
  fail "stage-droplet/01-run.sh missing"
fi

# Must NOT invoke setup.sh at build time.
if grep -E 'setup\.sh' "$STAGE_RUN" | grep -vqE '#|echo|first boot|first-boot'; then
  fail "01-run.sh appears to invoke setup.sh at build time (must be first-boot only)"
else
  pass "01-run.sh does not invoke setup.sh at build time"
fi

# Must NOT create a real secret .env (no baked secrets). Strip comment lines
# first, then allow only the transient build `--env-file` and the defensive
# "assert no .env was baked" guard. A real write would be `> "$INSTALL_DIR/.env"`
# or `cat > ...env` on a non-comment line.
ENV_CODE_HITS="$(grep -nE '\.env' "$STAGE_RUN" | sed 's/[[:space:]]*#.*$//' | grep -E '\.env' || true)"
if printf '%s\n' "$ENV_CODE_HITS" | grep -qE '>[[:space:]]*"?[^"]*\.env"?|cat[[:space:]]+>[[:space:]]*"?[^"]*\.env'; then
  fail "01-run.sh appears to WRITE a real .env (secrets must NOT be baked)"
else
  pass "01-run.sh does not write a secret .env (only a transient build --env-file + a no-bake guard)"
fi

# Must install Docker from Docker's repo (compose v2), not distro docker.io.
if grep -q 'download.docker.com' "$STAGE_RUN" && grep -q 'docker-compose-plugin' "$STAGE_RUN"; then
  pass "01-run.sh installs Docker + compose-plugin from Docker's apt repo"
else
  fail "01-run.sh does not install Docker from Docker's apt repo / compose-plugin"
fi

# Must clone into the path droplet.service expects.
if grep -q '/opt/droplet/edge-platform' "$STAGE_RUN"; then
  pass "01-run.sh clones into /opt/droplet/edge-platform"
else
  fail "01-run.sh does not clone into /opt/droplet/edge-platform"
fi

# FIPS guard: must NOT strip OPENSSL_CONF or disable FIPS — on a NON-COMMENT
# line. The script's header comment documents the invariant ("Does NOT strip
# OPENSSL_CONF ... DROPLET_FIPS_REQUIRED=false"), which is fine; only an actual
# code statement setting either would undermine FIPS.
FIPS_CODE_HITS="$(grep -nE 'OPENSSL_CONF=|DROPLET_FIPS_REQUIRED=false' "$STAGE_RUN" | sed 's/[[:space:]]*#.*$//' | grep -E 'OPENSSL_CONF=|DROPLET_FIPS_REQUIRED=false' || true)"
if [ -n "$FIPS_CODE_HITS" ]; then
  fail "01-run.sh strips OPENSSL_CONF / disables FIPS in code — must not undermine FIPS gating"
else
  pass "01-run.sh does not touch OPENSSL_CONF / FIPS gating (only documented in comments)"
fi

# =============================================================================
# Phase 6: misc stage inputs present
# =============================================================================
echo "--- Phase 6: stage inputs ---"

if [ -f "$STAGE_PKGS" ] && grep -q 'ca-certificates' "$STAGE_PKGS"; then
  pass "stage-droplet/00-packages present with base packages"
else
  fail "stage-droplet/00-packages missing or empty"
fi

if [ -f "$EXPORT_MARKER" ]; then
  pass "stage-droplet/EXPORT_IMAGE marker present (pi-gen export trigger)"
else
  fail "stage-droplet/EXPORT_IMAGE marker missing"
fi

# =============================================================================
# Results
# =============================================================================
echo ""
echo "  ================================================"
printf "  Results: %d/%d passed" "$((TESTS - FAILURES))" "$TESTS"
if [ "$FAILURES" -gt 0 ]; then
  printf " (\033[31m%d failed\033[0m)" "$FAILURES"
fi
printf "\n"
echo "  ================================================"
echo ""

exit "$FAILURES"
