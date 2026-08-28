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
    # These cases exercise the DENIAL direction (is a referenced host
    # registered?). The WARP-2452 backing direction is declared out of the
    # way so it cannot mask a denial regression — the cases below write to
    # several different files, so no single code_refs list would fit.
    no_code_literal: fixture — denial-direction cases only
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

# The denial pass reads comments ON PURPOSE — a commented-out endpoint is one
# uncomment away from egress. Pinned here so the WARP-2452 comment stripping
# can never leak into this direction.
# Mutation: strip comments in the denial pass too -> this goes green at 0.
run_case "unregistered host in a comment still fails" 1 \
  "apps/svc/src/beacon.ts" \
  '// const u = "https://telemetry.evil-corp.io/beacon";'

# =============================================================================
# WARP-2452 — the BACKING direction: is a registered entry load-bearing?
# Each case pairs with a mutation that must turn it red; see the ticket.
# =============================================================================

run_entry_case() { # $1=name $2=expected_exit $3=yaml $4=file_rel $5=content
  local dir; dir="$(mktemp -d)"
  mkdir -p "$dir/docs/security" "$dir/$(dirname "$4")"
  git -C "$dir" init -q
  printf '%s\n' "$3" > "$dir/docs/security/allowed-egress.yaml"
  printf '%s\n' "$5" > "$dir/$4"
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

YAML_EGRESS=$(cat <<'YAML'
version: 1
entries:
  - id: vendor-files
    kind: egress
    service: svc
    destination:
      hosts: [files.allowed-vendor.com]
      ports: [443]
      protocol: https
    phase: runtime
    data_class: none
    purpose: fixture
    ticket: WARP-2452
    code_refs: [apps/svc/src/files.ts]
YAML
)

# ── The reproduction table from WARP-2452, as fixtures ──────────────────────
# All three keep a doc comment carrying the scheme URL, so the denial pass is
# satisfied in every row and only the backing pass can move. Rows 1 and 2 were
# indistinguishable to CI before this change; that is the whole bug.

# Row 1: whole-string literal -> the honest shape, passes.
run_entry_case "backing: whole-string literal passes" 0 \
  "$YAML_EGRESS" "apps/svc/src/files.ts" \
  '// baseUrl: https://files.allowed-vendor.com
export const FILES_BASE_URL = "https://files.allowed-vendor.com";'

# Row 2: runtime-assembled + comment -> the hole. Was OK with no notice.
# Mutation: downgrade the backing failure to a NOTICE -> exit 0, red.
run_entry_case "backing: runtime-assembled host with comment fails" 1 \
  "$YAML_EGRESS" "apps/svc/src/files.ts" \
  '// baseUrl: https://files.allowed-vendor.com
export const FILES_BASE_URL = "https://files." + "allowed-vendor.com";'

# Row 3: comment-only -> the entry is decorative.
# Mutation: stop stripping comments in the backing pass -> exit 0, red.
run_entry_case "backing: comment-only host fails" 1 \
  "$YAML_EGRESS" "apps/svc/src/files.ts" \
  '// see https://files.allowed-vendor.com for the API
export const FILES_BASE_URL = process.env.FILES_BASE_URL;'

# A block comment hides a host just as well as a line comment.
run_entry_case "backing: block-comment-only host fails" 1 \
  "$YAML_EGRESS" "apps/svc/src/files.ts" \
  '/* baseUrl: https://files.allowed-vendor.com */
export const FILES_BASE_URL = process.env.FILES_BASE_URL;'

# The literal must be in a file the ENTRY names, not merely somewhere.
run_entry_case "backing: literal outside code_refs fails" 1 \
  "$YAML_EGRESS" "apps/svc/src/elsewhere.ts" \
  'export const FILES_BASE_URL = "https://files.allowed-vendor.com";'

# `//` inside a URL is not a comment — the guard against eating our own hosts.
# Mutation: drop the ":" guard in strip_comments -> the literal is stripped
# away with the rest of the line, entry looks unbacked, exit 1, red.
run_entry_case "backing: scheme slashes are not a comment" 0 \
  "$YAML_EGRESS" "apps/svc/src/files.ts" \
  'export const FILES_BASE_URL = "https://files.allowed-vendor.com";'

# A hash-comment file (YAML/shell/Dockerfile) hides a host too...
YAML_EGRESS_SH=$(cat <<'YAML'
version: 1
entries:
  - id: vendor-files
    kind: egress
    service: svc
    destination:
      hosts: [files.allowed-vendor.com]
      ports: [443]
      protocol: https
    phase: runtime
    data_class: none
    purpose: fixture
    ticket: WARP-2452
    code_refs: [scripts/fetch.sh]
YAML
)

run_entry_case "backing: shell comment-only host fails" 1 \
  "$YAML_EGRESS_SH" "scripts/fetch.sh" \
  '# mirrors https://files.allowed-vendor.com
curl -fsSL "$MIRROR/tool.tgz"'

# ...but an unquoted host in shell config still counts as backing. Hosts are
# bare in .conf/.env and quoted in TS; a quote-anchored rule would reject the
# honest config case.
run_entry_case "backing: unquoted host in shell counts" 0 \
  "$YAML_EGRESS_SH" "scripts/fetch.sh" \
  'curl -fsSL https://files.allowed-vendor.com/tool.tgz'

# ── Kind separation: each kind asserted on its own ───────────────────────────

# kind: dynamic is exempt BY DESIGN — the host is assembled from config_key at
# runtime, so no literal can exist (this is Mailchimp's datacentre suffix).
# Mutation: apply the literal requirement to dynamic kinds -> exit 1, red.
YAML_DYNAMIC=$(cat <<'YAML'
version: 1
entries:
  - id: vendor-dynamic
    kind: dynamic
    service: svc
    config_key: DROPLET_VENDOR_BASE_URL
    phase: runtime
    data_class: none
    purpose: fixture
    ticket: WARP-2452
    code_refs: [apps/svc/src/files.ts]
YAML
)

run_entry_case "dynamic entry with no literal anywhere still passes" 0 \
  "$YAML_DYNAMIC" "apps/svc/src/files.ts" \
  'export const FILES_BASE_URL = process.env.DROPLET_VENDOR_BASE_URL;'

# kind: reference is not egress at all — a comment-only host is all it ever is.
# Mutation: apply the literal requirement to reference kinds -> exit 1, red.
YAML_REFERENCE=$(cat <<'YAML'
version: 1
entries:
  - id: vendor-doc-link
    kind: reference
    service: svc
    destination:
      hosts: [files.allowed-vendor.com]
      ports: [443]
      protocol: https
    phase: runtime
    data_class: none
    purpose: fixture
    ticket: WARP-2452
    code_refs: [apps/svc/src/files.ts]
YAML
)

run_entry_case "reference entry with comment-only host still passes" 0 \
  "$YAML_REFERENCE" "apps/svc/src/files.ts" \
  '// API docs: https://files.allowed-vendor.com/docs
export const N = 1;'

# ── no_code_literal: per-entry, and self-pruning ─────────────────────────────

YAML_DECLARED=$(cat <<'YAML'
version: 1
entries:
  - id: vendor-files
    kind: egress
    service: svc
    destination:
      hosts: [files.allowed-vendor.com]
      ports: [443]
      protocol: https
    phase: runtime
    data_class: none
    purpose: fixture
    ticket: WARP-2452
    code_refs: [apps/svc/src/files.ts]
    no_code_literal: a pinned third-party image owns this destination
YAML
)

run_entry_case "declared no_code_literal exempts a comment-only host" 0 \
  "$YAML_DECLARED" "apps/svc/src/files.ts" \
  '// see https://files.allowed-vendor.com for the API
export const FILES_BASE_URL = process.env.FILES_BASE_URL;'

# The declaration is a claim, and a false claim fails: once the code does name
# the host, the exemption must go. This is what keeps the exemption list from
# rotting into a blanket one.
# Mutation: accept no_code_literal unconditionally -> exit 0, red.
run_entry_case "no_code_literal alongside a real literal fails" 1 \
  "$YAML_DECLARED" "apps/svc/src/files.ts" \
  'export const FILES_BASE_URL = "https://files.allowed-vendor.com";'

# An egress entry with no code_refs at all cannot be backed by anything.
YAML_NO_REFS=$(cat <<'YAML'
version: 1
entries:
  - id: vendor-files
    kind: egress
    service: svc
    destination:
      hosts: [files.allowed-vendor.com]
      ports: [443]
      protocol: https
    phase: runtime
    data_class: none
    purpose: fixture
    ticket: WARP-2452
YAML
)

run_entry_case "egress entry with no code_refs fails" 1 \
  "$YAML_NO_REFS" "apps/svc/src/files.ts" \
  'export const FILES_BASE_URL = "https://files.allowed-vendor.com";'

# no_code_literal is meaningful only on kind: egress — a config error (exit 2),
# not a violation, so it cannot be used to quiet a reference/dynamic entry.
YAML_MISPLACED=$(cat <<'YAML'
version: 1
entries:
  - id: vendor-doc-link
    kind: reference
    service: svc
    destination:
      hosts: [files.allowed-vendor.com]
      ports: [443]
      protocol: https
    phase: runtime
    data_class: none
    purpose: fixture
    ticket: WARP-2452
    code_refs: [apps/svc/src/files.ts]
    no_code_literal: not allowed here
YAML
)

run_entry_case "no_code_literal on a non-egress kind is a config error" 2 \
  "$YAML_MISPLACED" "apps/svc/src/files.ts" \
  'export const N = 1;'

# =============================================================================
# WARP-2468 — code_refs must live inside the scanner's own denial scope.
# A path the denial pass would never read cannot be evidence that the entry is
# used. Without this rule an entry stays green off an ADR that merely proposed
# the destination, from design time through to a connector that never ships.
# =============================================================================

# The docs file DOES carry the literal, so the backing pass is satisfied — only
# the scope rule can move this case.
# Mutation: drop the scope check -> the backing pass is happy, exit 0, red.
YAML_DOCS_REF=$(cat <<'YAML'
version: 1
entries:
  - id: vendor-files
    kind: egress
    service: svc
    destination:
      hosts: [files.allowed-vendor.com]
      ports: [443]
      protocol: https
    phase: runtime
    data_class: none
    purpose: fixture
    ticket: WARP-2468
    code_refs: [docs/ADR-999-vendor.md]
YAML
)

run_entry_case "scope: docs-only code_refs fails" 1 \
  "$YAML_DOCS_REF" "docs/ADR-999-vendor.md" \
  'The connector dials https://files.allowed-vendor.com for the file list.'

# EVERY path must be in scope, not merely one of them — this is the shape
# sso-oidc-idps had (config.ts + an onboarding doc). The in-scope ref carries
# the literal, so the backing pass passes and only the scope rule fails it.
# Mutation: check only entries whose refs are ALL out of scope -> exit 0, red.
YAML_MIXED_REF=$(cat <<'YAML'
version: 1
entries:
  - id: vendor-files
    kind: egress
    service: svc
    destination:
      hosts: [files.allowed-vendor.com]
      ports: [443]
      protocol: https
    phase: runtime
    data_class: none
    purpose: fixture
    ticket: WARP-2468
    code_refs: [apps/svc/src/files.ts, docs/ADR-999-vendor.md]
YAML
)

run_entry_case "scope: one in-scope ref does not excuse a docs ref" 1 \
  "$YAML_MIXED_REF" "apps/svc/src/files.ts" \
  'export const FILES_BASE_URL = "https://files.allowed-vendor.com";'

# A test file is excluded from the denial scan too (EXCLUDE_RE), so a fixture
# host cannot vouch for an entry either. This is the m365-graph-api shape:
# graph.microsoft.com exists in the repo ONLY inside .test.ts files.
# Mutation: use a bare SCOPE_PREFIXES check instead of in_scope() -> exit 0, red.
YAML_TEST_REF=$(cat <<'YAML'
version: 1
entries:
  - id: vendor-files
    kind: egress
    service: svc
    destination:
      hosts: [files.allowed-vendor.com]
      ports: [443]
      protocol: https
    phase: runtime
    data_class: none
    purpose: fixture
    ticket: WARP-2468
    code_refs: [apps/svc/src/files.test.ts]
YAML
)

run_entry_case "scope: a test-file code_ref cannot back an entry" 1 \
  "$YAML_TEST_REF" "apps/svc/src/files.test.ts" \
  'export const FILES_BASE_URL = "https://files.allowed-vendor.com";'

# kind: reference exists precisely for doc/namespace hostnames, so pointing one
# at a doc is correct. Asserted on its own so the scope rule cannot creep.
# Mutation: apply the scope rule to reference kinds -> exit 1, red.
YAML_REFERENCE_DOCS=$(cat <<'YAML'
version: 1
entries:
  - id: vendor-doc-link
    kind: reference
    service: svc
    destination:
      hosts: [files.allowed-vendor.com]
      ports: [443]
      protocol: https
    phase: runtime
    data_class: none
    purpose: fixture
    ticket: WARP-2468
    code_refs: [docs/ADR-999-vendor.md]
YAML
)

run_entry_case "scope: reference entry may cite a docs path" 0 \
  "$YAML_REFERENCE_DOCS" "docs/ADR-999-vendor.md" \
  'Namespace URL: https://files.allowed-vendor.com/schema'

# ── The m365 shape: no_code_literal self-prunes when the client lands ────────
# Same registry text both ways; only the fixture under services/ changes. This
# is the acceptance criterion "adding a graph.microsoft.com literal to a
# fixture under services/ makes the gate fail until the declaration is removed".

YAML_M365_DECLARED=$(cat <<'YAML'
version: 1
entries:
  - id: m365-graph-api
    kind: egress
    service: orchestrator
    destination:
      hosts: [graph.microsoft.com]
      ports: [443]
      protocol: https
    phase: runtime
    data_class: none
    purpose: fixture
    ticket: WARP-2468
    code_refs: [services/m365/sync.ts]
    no_code_literal: registered ahead of the WARP-2118 sync engine
YAML
)

YAML_M365_UNDECLARED=$(cat <<'YAML'
version: 1
entries:
  - id: m365-graph-api
    kind: egress
    service: orchestrator
    destination:
      hosts: [graph.microsoft.com]
      ports: [443]
      protocol: https
    phase: runtime
    data_class: none
    purpose: fixture
    ticket: WARP-2468
    code_refs: [services/m365/sync.ts]
YAML
)

# Before the client lands: nothing names the host, the declaration is true.
run_entry_case "m365: declaration holds while no client exists" 0 \
  "$YAML_M365_DECLARED" "services/m365/sync.ts" \
  'export const GRAPH_BASE_URL = process.env.M365_GRAPH_BASE_URL;'

# The client lands under services/ -> the declaration is now a false claim.
# Mutation: make no_code_literal a permanent exemption -> exit 0, red.
run_entry_case "m365: declaration fails once a services/ literal appears" 1 \
  "$YAML_M365_DECLARED" "services/m365/sync.ts" \
  'export const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";'

# ...and removing the declaration is what makes it green again. Without this
# row the case above could be satisfied by a gate that simply never passes.
run_entry_case "m365: dropping the declaration restores green" 0 \
  "$YAML_M365_UNDECLARED" "services/m365/sync.ts" \
  'export const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";'

echo
echo "egress-scan tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
