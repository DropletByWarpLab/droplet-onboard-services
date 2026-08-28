#!/usr/bin/env bash
# =============================================================================
# Unit tests for scripts/check-egress-allowlist.py (WARP-269).
# Builds throwaway git repos with synthetic fixtures and asserts exit codes.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SCANNER="$REPO_ROOT/scripts/check-egress-allowlist.py"

PASS=0
FAIL=0

make_repo() { # $1=dir
  mkdir -p "$1/docs/security" "$1/apps/svc/src" "$1/apps/svc/src/__tests__"
  git -C "$1" init -q
  cat > "$1/docs/security/allowed-egress.yaml" <<'YAML'
version: 1
entries:
  - id: allowed-api
    kind: egress
    service: svc
    destination:
      hosts: [api.allowed-vendor.com, "*.wildcard-ok.org"]
      ports: [443]
      protocol: https
    phase: runtime
    data_class: none
    purpose: fixture
    ticket: WARP-269
YAML
}

run_case() { # $1=name $2=expected_exit $3=file_rel $4=content
  local dir; dir="$(mktemp -d)"
  make_repo "$dir"
  mkdir -p "$dir/$(dirname "$3")"
  printf '%s\n' "$4" > "$dir/$3"
  git -C "$dir" add -A
  local actual=0
  python3 "$SCANNER" --repo-root "$dir" >/dev/null 2>&1 || actual=$?
  if [ "$actual" -eq "$2" ]; then
    PASS=$((PASS + 1)); echo "PASS: $1"
  else
    FAIL=$((FAIL + 1)); echo "FAIL: $1 (expected exit $2, got $actual)"
  fi
  rm -rf "$dir"
}

run_case "allowlisted host passes" 0 \
  "apps/svc/src/client.ts" \
  'export const u = "https://api.allowed-vendor.com/v1";'

run_case "wildcard allowlist matches subdomain" 0 \
  "apps/svc/src/client.ts" \
  'export const u = "https://edge7.wildcard-ok.org/ping";'

run_case "unlisted host fails" 1 \
  "apps/svc/src/beacon.ts" \
  'export const u = "https://telemetry.evil-corp.io/beacon";'

run_case "unlisted host in Dockerfile fails" 1 \
  "apps/svc/Dockerfile" \
  'RUN curl -fsSL https://sneaky-mirror.example-cdn.net/tool.tgz | tar xz'

run_case "RFC-2606 test host is filtered" 0 \
  "apps/svc/src/client.ts" \
  'export const u = "https://hq.example.test/api";'

run_case "test files are out of scope" 0 \
  "apps/svc/src/__tests__/client.test.ts" \
  'export const u = "https://fixture.attacker-site.com/";'

run_case "private IP literal passes" 0 \
  "apps/svc/src/client.ts" \
  'export const u = "http://192.168.1.1/api";'

run_case "public IP literal fails" 1 \
  "apps/svc/src/client.ts" \
  'export const u = "http://8.8.8.8/api";'

# ── WARP-2217: provider-descriptor egressHosts ──────────────────────────────
# A descriptor declares its destinations as BARE hosts, and code files are
# otherwise exempt from bare-host matching. Without these the declaration would
# be invisible to the gate and a descriptor could name an unregistered vendor
# host with nothing going red.

run_case "descriptor egressHosts: allowlisted host passes" 0 \
  "packages/shared-types/src/provider-registry.ts" \
  '  egressHosts: ["api.allowed-vendor.com"],'

run_case "descriptor egressHosts: unlisted host fails" 1 \
  "packages/shared-types/src/provider-registry.ts" \
  '  egressHosts: ["telemetry.evil-corp.io"],'

# The array wraps once it holds more than two entries. A single-line regex
# would silently stop matching the day a third host is added — which is the
# exact drift this gate exists to catch, so the multi-line form is asserted.
run_case "descriptor egressHosts: unlisted host on a WRAPPED array fails" 1 \
  "packages/shared-types/src/provider-registry.ts" \
  '    egressHosts: [
      "api.allowed-vendor.com",
      // a comment between entries, as prettier leaves them
      "telemetry.evil-corp.io",
    ],
    datasets: ["invoice"],'

# Everything after the closing bracket is ordinary code again — a hostname in a
# later comment must not be attributed to the array.
run_case "descriptor egressHosts: closing bracket ends the array" 0 \
  "packages/shared-types/src/provider-registry.ts" \
  '  egressHosts: ["api.allowed-vendor.com"],
  // unrelated prose mentioning evil-corp.io should not be extracted'

run_case "descriptor egressHosts: empty array is not a violation" 0 \
  "packages/shared-types/src/provider-registry.ts" \
  '  egressHosts: [],'

echo
echo "egress-scan tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
