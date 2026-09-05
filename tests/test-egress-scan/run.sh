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

# =============================================================================
# WARP-2467 — bare hosts in CODE files, filtered by pattern not by exemption.
#
# Before this, the only shape the gate enforced in code was a literal scheme
# URL, so `const HOST = "api.evil-corp.io"` + a runtime-assembled fetch passed
# with exit 0 and the destination was registered nowhere. Bare-host matching
# was config-files-only to dodge prose noise — which meant the gate caught
# connectors that already follow the whole-string-URL convention and missed
# every one that does not.
# =============================================================================

# The reproduction from the ticket. The host is spelled with a real TLD, not
# the ticket's `.example`: RFC 2606 names are filtered by design (see the
# noise cases below), so an `.example` fixture could never fail.
# Mutation: restore the config-files-only bare-host scope -> exit 0, red.
run_case "bare host in a code string literal fails" 1 \
  "apps/svc/src/beacon.ts" \
  'const HOST = "api.evil-corp.io";
export const u = `https://${HOST}/v1/data`;'

# The same host in Python, where the assembly is an f-string. This is the
# ambient-rates-ecb shape verbatim (ECB_HOST = "..." then f"https://{ECB_HOST}").
run_case "bare host in a python string literal fails" 1 \
  "services/svc/fetcher.py" \
  'ECB_HOST = "api.evil-corp.io"
ECB_URL = f"https://{ECB_HOST}/stats/daily.xml"'

# Comments are stripped for the BARE-host pass: a hostname in prose is usually
# just prose, and that was the whole reason code files were exempt.
# Mutation: stop stripping comments in the bare-host pass -> exit 1, red.
run_case "bare host in a code comment does not deny" 0 \
  "apps/svc/src/beacon.ts" \
  '// the old vendor was api.evil-corp.io before the migration
export const N = 1;'

# ...but a SCHEME URL in a comment still denies. That asymmetry is deliberate:
# a commented-out endpoint is one uncomment away from egress, whereas a bare
# hostname in prose is not. Pinned above as well ("unregistered host in a
# comment still fails"); repeated here as the pair to the case above so the
# two cannot be "simplified" into one rule.
run_case "scheme URL in a comment still denies, unlike a bare host" 1 \
  "apps/svc/src/beacon.ts" \
  '// the old vendor was https://api.evil-corp.io/v1 before the migration
export const N = 1;'

# ── The noise filter: PATTERNS. Every one of these is a shape, not a file. ──

# RFC 2606 reserved names, filtered in TWO independent layers — worth stating
# because it decides what a meaningful mutation looks like here:
#   1. BARE_HOST_TLDS — the bare-host matcher only considers a scanned TLD,
#      and `.example`/`.test`/`.invalid`/`.localhost` are not in that list.
#   2. INTERNAL_HOST_RE — filters reserved names for EVERY extraction mode.
# `example.com` is the case where only layer 2 stands in the way (`.com` is a
# scanned TLD), so it is the one that pins layer 2 non-vacuously.
# Mutation: drop `example\.(com|net|org)` from INTERNAL_HOST_RE -> exit 1, red.
run_case "noise: example.com in a code literal does not deny" 0 \
  "apps/svc/src/beacon.ts" \
  'const HOST = "example.com";
export const u = `https://${HOST}/v1/data`;'

# Layer 1. Dropping `.example` from INTERNAL_HOST_RE alone does NOT turn this
# red — BARE_HOST_TLDS already excludes it — so the mutation has to break both
# layers: add the reserved TLDs to BARE_HOST_TLDS and drop them from
# INTERNAL_HOST_RE. Recorded here so nobody reads this row as pinning layer 2.
run_case "noise: RFC 2606 .example/.test/.invalid bare hosts do not deny" 0 \
  "apps/svc/src/beacon.ts" \
  'const A = "api.evil.example"; const B = "b.evil.test"; const C = "c.evil.invalid";'

# An npm scoped package can never be a hostname — a host cannot start with `@`.
# Mutation: stop excluding @scope/name -> exit 1, red (socket.io matches
# BARE_HOST_RE and .io is a scanned TLD).
run_case "noise: @scope/name package identifier does not deny" 0 \
  "apps/svc/src/beacon.ts" \
  'import { io } from "@vendor/socket.io";'

# Dashboard onboarding copy. `you@company.com` is an example address.
# Mutation: drop the email-localpart filter -> exit 1, red.
run_case "noise: sample email domain in placeholder copy does not deny" 0 \
  "apps/svc/src/beacon.tsx" \
  'export const P = <input placeholder="you@company.com" />;'

# ...but userinfo in a REAL url is not excused. URL_RE alone does not catch
# this shape (its host class excludes `@`), so the bare-host pass is the only
# thing standing between `https://user@host/` and a silent pass.
# Mutation: drop the `"://" in literal` guard on the email filter -> exit 0, red.
run_case "noise filter does not excuse userinfo in a real URL" 1 \
  "apps/svc/src/beacon.ts" \
  'export const u = "https://user@telemetry.evil-corp.io/beacon";'

# A Python docstring is prose, not a literal. Without this the scanner denies
# on its own module docstring, and on every explanatory docstring in the repo.
# Mutation: stop treating triple quotes as prose -> exit 1, red.
run_case "noise: prose in a python docstring does not deny" 0 \
  "services/svc/fetcher.py" \
  'def f():
    """Used to fetch from api.evil-corp.io before the migration."""
    return 1'

# ── Config files keep their old, wider behaviour ────────────────────────────
# A bare host in .env.example is a setting, not prose, and the whole raw line
# is still read. Pinned so the code-file path cannot replace it.
# Mutation: return only string literals for config files too -> exit 0, red.
run_case "config file bare host still denies on a raw line" 1 \
  ".env.example" \
  'GEO_URL=api.evil-corp.io'

# =============================================================================
# WARP-2487 — what counts as a hostname is the Public Suffix List.
#
# #1831 made the fifteen-entry BARE_HOST_TLDS tuple load-bearing for CODE and
# not just config. Everything outside it — vendor.sh, vendor.app, vendor.xyz —
# was therefore invisible in the denial direction, and stayed invisible until
# somebody remembered to widen a tuple. Coverage that depends on remembering
# is not coverage.
# =============================================================================

# Assert on the MESSAGE as well as the exit code: "exit 1 with the host named"
# is the acceptance criterion, and an exit code alone cannot tell a report that
# names the right host from one that names something else.
run_case_grep() { # $1=name $2=expected_exit $3=file_rel $4=content $5=pattern
  local dir; dir="$(mktemp -d)"
  make_repo "$dir"
  mkdir -p "$dir/$(dirname "$3")"
  printf '%s\n' "$4" > "$dir/$3"
  git -C "$dir" add -A
  local out actual=0
  out="$(python3 "$SCANNER" --repo-root "$dir" 2>&1)" || actual=$?
  if [ "$actual" -eq "$2" ] && printf '%s' "$out" | grep -q -- "$5"; then
    PASS=$((PASS + 1)); echo "PASS: $1"
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: $1 (expected exit $2 + /$5/, got exit $actual)"
  fi
  rm -rf "$dir"
}

# Same, for the registry-shaped cases that bring their own YAML.
run_entry_case_grep() { # $1=name $2=exit $3=yaml $4=file_rel $5=content $6=pattern
  local dir; dir="$(mktemp -d)"
  mkdir -p "$dir/docs/security" "$dir/$(dirname "$4")"
  git -C "$dir" init -q
  printf '%s\n' "$3" > "$dir/docs/security/allowed-egress.yaml"
  printf '%s\n' "$5" > "$dir/$4"
  git -C "$dir" add -A
  local out actual=0
  out="$(python3 "$SCANNER" --repo-root "$dir" 2>&1)" || actual=$?
  if [ "$actual" -eq "$2" ] && printf '%s' "$out" | grep -q -- "$6"; then
    PASS=$((PASS + 1)); echo "PASS: $1"
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: $1 (expected exit $2 + /$6/, got exit $actual)"
  fi
  rm -rf "$dir"
}

# Two files, because several rules are about one file's content being read in
# the light of another file EXISTING (the tracked-basename filter).
run_case2() { # $1=name $2=exit $3=fileA $4=contentA $5=fileB $6=contentB
  local dir; dir="$(mktemp -d)"
  make_repo "$dir"
  mkdir -p "$dir/$(dirname "$3")" "$dir/$(dirname "$5")"
  printf '%s\n' "$4" > "$dir/$3"
  printf '%s\n' "$6" > "$dir/$5"
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

# The ticket's three fixtures, one per TLD, each named in the failure report.
# All three are dead silent under the old tuple: .sh, .app and .xyz are not in
# it, so the host was never even a candidate.
# Mutation (all three rows): replace the is_registrable_domain() call in
# extract() with `host.endswith(LEGACY_HIGH_SIGNAL_TLDS)` -> all three go
# green at 0, red.
run_case_grep "PSL: bare host on .sh in a code literal fails, host named" 1 \
  "apps/svc/src/beacon.ts" \
  'const HOST = "api.vendor.sh";
export const u = `https://${HOST}/v1/data`;' \
  "api.vendor.sh"

run_case_grep "PSL: bare host on .app in a code literal fails, host named" 1 \
  "apps/svc/src/beacon.ts" \
  'const HOST = "api.vendor.app";
export const u = `https://${HOST}/v1/data`;' \
  "api.vendor.app"

run_case_grep "PSL: bare host on .xyz in a code literal fails, host named" 1 \
  "apps/svc/src/beacon.ts" \
  'const HOST = "api.vendor.xyz";
export const u = `https://${HOST}/v1/data`;' \
  "api.vendor.xyz"

# ...and the same widening in a CONFIG value, which is the other extraction
# shape. Pinned separately so a change to one path cannot quietly cover for
# the other.
run_case "PSL: bare host on .sh in a config value fails" 1 \
  ".env.example" \
  'GEO_HOST=api.vendor.sh'

# The suffix list is also what keeps the widening from taking every dotted
# token: `tar`, `json` and `css` are not delegated, so these are not candidates
# at all. This is the ticket's "1.2.3.tar-style version string" class, resolved
# by the data rather than by another pattern.
# Mutation: implement the PSL's `*` default rule in public_suffix_of ->
# every dotted token becomes a registrable domain, exit 1, red.
run_case "PSL: version strings and filenames on undelegated suffixes do not deny" 0 \
  "apps/svc/src/beacon.ts" \
  'const A = "vosk-model-0.22.tar"; const B = "package-lock.json"; const C = "styles.module.css";'

# A public suffix is not itself a destination — only a name registered under
# one is. `com.au` has no label of its own; `api.vendor.com.au` has two.
# `.au` deliberately, not `.uk`: `.uk` IS in the legacy tuple, so a `co.uk`
# row would be satisfied by the OLD gate and would pin nothing about the
# suffix list. (Caught by mutation M1, which left it green.)
# Mutation: drop the "at least one label to the left" test in
# is_registrable_domain -> the first literal denies, exit 1, red.
run_case "PSL: a bare public suffix is not a host" 0 \
  "apps/svc/src/beacon.ts" \
  'const REGION = "com.au";'

run_case_grep "PSL: a name registered under a multi-label suffix IS a host" 1 \
  "apps/svc/src/beacon.ts" \
  'const HOST = "api.vendor.com.au";' \
  "api.vendor.com.au"

# ── The noise the wider list creates, filtered by PATTERN. Zero file exemptions.
# Measured on pristine stage: 69 hosts -> 459 with the list alone, -> 76 with
# the filters below, and none of the original 69 lost.

# A member access inside a template interpolation is not a destination, and
# `.name`, `.id`, `.map`, `.host` and `.zone` are all delegated TLDs — so
# without a filter every member access in the repo becomes one. What rejects
# it is the value-shape tier: the `${` sitting in front of the candidate is
# not decoration a hostname could carry.
#
# An earlier draft stripped `${...}` spans outright. Measured against the whole
# repo that turned out to change nothing (+0/-0 hosts) once value-shape was in
# place, and it cost a host when first applied to shell — `${VAR:-default}` is
# a parameter expansion whose default is real data. It was deleted rather than
# kept as a second, redundant rule.
# Mutation: accept every PSL match regardless of position -> item.name is
# extracted, exit 1, red.
run_case "noise: a member access in a template interpolation does not deny" 0 \
  "apps/svc/src/beacon.ts" \
  'export const label = `${item.name} (${row.id})`;'

# The shell shape that draft broke, pinned so it cannot come back:
# scripts/host/droplet-watchdog.sh:122 verbatim, where the parameter default
# IS the destination and is the only place the repo names it.
# Mutation: skip bare-host extraction when the chunk contains "${" -> the host
# vanishes, exit 0, red.
run_case_grep "a shell parameter default is a destination, not an expression" 1 \
  "scripts/probe.sh" \
  'WD_DNS_PROBE="${DROPLET_WATCHDOG_DNS_PROBE:-registry-1.evil-corp.io}"' \
  "registry-1.evil-corp.io"

# A filename is not a hostname, and `.sh`/`.md`/`.py` are all delegated. The
# filter is DERIVED from git ls-files, so it needs no upkeep.
#
# The filename sits in a VALUE position on purpose — `const ENTRY =
# "deploy.sh"` — because that is the only position where the basename filter
# is the thing standing in the way. In prose the value-shape tier rejects it
# first and the row would pin nothing. (Caught by mutation M6, which left an
# earlier prose version green. This is the Dockerfile `CMD ["main.py"]` shape,
# and 7 real hosts in this repo are exactly it.)
# Mutation: drop the basename filter -> deploy.sh denies, exit 1, red.
run_case2 "noise: a tracked file's basename is a filename, not a host" 0 \
  "scripts/deploy.sh" \
  'echo deploying' \
  "apps/svc/src/notes.ts" \
  'export const ENTRY = "deploy.sh";'

# ...and the same shape with NO such file in the tree is still a host. This is
# the row that stops the filter above from being read as "`.sh` is exempt".
run_case_grep "noise: an untracked .sh name in a value position still denies" 1 \
  "apps/svc/src/notes.ts" \
  'const HOST = "deploy-hooks.sh";' \
  "deploy-hooks.sh"

# SQL has `--` comments and the walker knew neither of its comment styles, so a
# migration header was read as source — and because a single quote is SQL's
# string delimiter, one apostrophe in that prose left the walker inside a
# phantom string for the rest of the file.
# Mutation: drop the dashes branch in scan_source -> exit 1, red.
run_case "noise: a host in a SQL -- comment does not deny" 0 \
  "apps/svc/prisma/migrations/20260101000000_x/migration.sql" \
  "-- WARP-1: the vendor's old key lived at api.evil-corp.io before the move
ALTER TABLE \"User\" ADD COLUMN \"x\" TEXT;"

# The second confidence: a non-legacy suffix is taken only where a destination
# is actually written — as the value. In running prose it is not, because
# `.channel`, `.name` and `.zone` are ordinary words that happen to be
# delegated.
# Mutation: accept every PSL match regardless of position -> exit 1, red.
run_case "noise: a non-legacy suffix inside running text does not deny" 0 \
  "apps/svc/src/notes.ts" \
  'export const HELP = "open the vendor.xyz dashboard and pick a plan";'

# ...but a LEGACY suffix in exactly the same position still denies, because
# that is what the gate did before this change and nothing may be lost.
# Mutation: require value-shape for legacy TLDs too -> exit 0, red.
run_case_grep "no regression: a legacy TLD in running text still denies" 1 \
  "apps/svc/src/notes.ts" \
  'export const HELP = "open the api.evil-corp.io dashboard and pick a plan";' \
  "api.evil-corp.io"

# A literal ENDING in a dot is a PREFIX finished at runtime — WARP-268's
# problem, not this pass's, and a name that was never written down. The
# concatenation form is what pins it: with a template literal the `${` in the
# tail rejects the candidate anyway, so that shape would leave the trailing-dot
# rule untested. (Caught by mutation M10, which left the template version
# green.)
# Mutation: add "." back to VALUE_TAIL_TRIM_RE -> exit 1, red.
run_case "noise: a runtime-assembled namespace prefix does not deny" 0 \
  "apps/svc/src/notes.ts" \
  'const cmd = "firewall.zone." + zone;'

# ...and the same literal WITHOUT the trailing dot is a complete name, so it
# denies. Without this row the rule above could be satisfied by a gate that
# simply never takes a `.zone` host.
run_case_grep "a complete name on the same suffix still denies" 1 \
  "apps/svc/src/notes.ts" \
  'const HOST = "api.evil-corp.zone";' \
  "api.evil-corp.zone"

# =============================================================================
# WARP-2487 — no_code_literal is a claim about a HOST, not about an entry.
#
# With one flag for the whole entry a MIXED entry could not be described: with
# two hosts, one SDK-owned and one dialled by our code, declaring the flag
# failed (a literal exists) and omitting it passed (some host is backed) while
# nothing accounted for the SDK-owned half. Neither state was the truth.
# =============================================================================

YAML_PER_HOST=$(cat <<'YAML'
version: 1
entries:
  - id: vendor-mixed
    kind: egress
    service: svc
    destination:
      hosts: [files.allowed-vendor.com, sdk.allowed-vendor.com]
      ports: [443]
      protocol: https
    phase: runtime
    data_class: none
    purpose: fixture
    ticket: WARP-2487
    code_refs: [apps/svc/src/files.ts]
    no_code_literal:
      sdk.allowed-vendor.com: a pinned third-party SDK owns this destination
YAML
)

# The honest mixed entry: our code names one host, the SDK owns the other, and
# the declaration says exactly that.
# Mutation: evaluate no_code_literal per ENTRY again (any backed host
# contradicts any declaration) -> exit 1, red.
run_entry_case "per-host: a declaration for one host does not indict the other" 0 \
  "$YAML_PER_HOST" "apps/svc/src/files.ts" \
  'export const FILES_BASE_URL = "https://files.allowed-vendor.com";'

# The teeth on the other side: with NOTHING backing the entry, the host the
# declaration does not cover has no excuse.
# Mutation: per-ENTRY again (a truthy declaration exempts the whole entry) ->
# exit 0, red.
run_entry_case "per-host: an undeclared host with no literal still fails" 1 \
  "$YAML_PER_HOST" "apps/svc/src/files.ts" \
  'export const FILES_BASE_URL = process.env.FILES_BASE_URL;'

# ...and the declaration is still a claim that can be false, per host.
# Mutation: skip the contradiction check for mapping declarations -> exit 0, red.
run_entry_case "per-host: a declared host that IS a literal still fails" 1 \
  "$YAML_PER_HOST" "apps/svc/src/files.ts" \
  'export const SDK_BASE_URL = "https://sdk.allowed-vendor.com";'

YAML_PER_HOST_TYPO=$(cat <<'YAML'
version: 1
entries:
  - id: vendor-mixed
    kind: egress
    service: svc
    destination:
      hosts: [files.allowed-vendor.com]
      ports: [443]
      protocol: https
    phase: runtime
    data_class: none
    purpose: fixture
    ticket: WARP-2487
    code_refs: [apps/svc/src/files.ts]
    no_code_literal:
      flies.allowed-vendor.com: typo — exempts nothing, and looks like it does
YAML
)

# A mapping key that is not one of the entry's hosts exempts nothing while
# reading as though it does. Config error (2), not a violation (1).
# Mutation: ignore unknown keys -> the entry looks undeclared and unbacked,
# exit 1, red.
run_entry_case "per-host: a declaration for a host the entry does not own is a config error" 2 \
  "$YAML_PER_HOST_TYPO" "apps/svc/src/files.ts" \
  'export const FILES_BASE_URL = process.env.FILES_BASE_URL;'

# =============================================================================
# WARP-2487 — duplicate entry ids.
#
# Two list items may legally carry the same `id:`; nothing in YAML objects and
# both blocks load. PR #1828 shipped two byte-identical `hubspot-api` blocks
# under a green "OK — 41 registry entries".
# =============================================================================

YAML_DUP_ID=$(cat <<'YAML'
version: 1
entries:
  - id: vendor-files
    kind: reference
    service: svc
    destination:
      hosts: [files.allowed-vendor.com]
    purpose: fixture
    ticket: WARP-2487
  - id: vendor-files
    kind: reference
    service: svc
    destination:
      hosts: [other.allowed-vendor.com]
    purpose: fixture
    ticket: WARP-2487
YAML
)

run_entry_case "duplicate id fails" 1 \
  "$YAML_DUP_ID" "apps/svc/src/files.ts" \
  'export const N = 1;'

# The report has to be actionable: the id, and BOTH line numbers, or a reviewer
# staring at two identical blocks has nothing to go on.
# Mutation: drop dup_failures from main()'s failure set -> exit 0, red.
run_entry_case_grep "duplicate id names the id and how many times" 1 \
  "$YAML_DUP_ID" "apps/svc/src/files.ts" \
  'export const N = 1;' \
  "vendor-files: declared 2 times"

# Mutation: report only the first occurrence's line -> the second line number
# is missing, red.
run_entry_case_grep "duplicate id report carries BOTH line numbers" 1 \
  "$YAML_DUP_ID" "apps/svc/src/files.ts" \
  'export const N = 1;' \
  "allowed-egress.yaml:3, docs/security/allowed-egress.yaml:10"

# A unique id in the same shape must NOT fail, or the rule above is vacuous.
YAML_UNIQUE_ID=$(cat <<'YAML'
version: 1
entries:
  - id: vendor-files
    kind: reference
    service: svc
    destination:
      hosts: [files.allowed-vendor.com]
    purpose: fixture
    ticket: WARP-2487
  - id: vendor-other
    kind: reference
    service: svc
    destination:
      hosts: [other.allowed-vendor.com]
    purpose: fixture
    ticket: WARP-2487
YAML
)

run_entry_case "two entries with distinct ids pass" 0 \
  "$YAML_UNIQUE_ID" "apps/svc/src/files.ts" \
  'export const N = 1;'

# =============================================================================
# WARP-2487 — the vendored snapshot is a drift gate, not a fire-and-forget blob.
#
# Age is read from the snapshot's OWN `// VERSION:` line, which upstream
# stamps. Not from a hand-maintained header (which can be refreshed without
# refreshing the data) and not from the file mtime (which a fresh clone resets
# to checkout time, reporting a five-year-old list as brand new).
# =============================================================================

run_psl_case() { # $1=name $2=expected_exit $3=today $4=snapshot(optional)
  local actual=0
  if [ -n "${4:-}" ]; then
    python3 "$SCANNER" --check-psl-freshness --today "$3" --psl-path "$4" \
      >/dev/null 2>&1 || actual=$?
  elif [ -n "$3" ]; then
    python3 "$SCANNER" --check-psl-freshness --today "$3" >/dev/null 2>&1 || actual=$?
  else
    python3 "$SCANNER" --check-psl-freshness >/dev/null 2>&1 || actual=$?
  fi
  if [ "$actual" -eq "$2" ]; then
    PASS=$((PASS + 1)); echo "PASS: $1"
  else
    FAIL=$((FAIL + 1)); echo "FAIL: $1 (expected exit $2, got $actual)"
  fi
}

PSL_DATE="$(grep -m1 '^// VERSION:' "$REPO_ROOT/scripts/data/public_suffix_list.dat" \
  | sed -E 's|^// VERSION: ([0-9]{4})-([0-9]{2})-([0-9]{2}).*|\1-\2-\3|')"
# Both sides of the 180-day boundary, measured against the REAL committed
# snapshot and with "today" pinned rather than read from the clock — a fixture
# dated relative to now can never fail, which is how a staleness check ends up
# proving nothing.
PSL_OK_DAY="$(python3 -c "
import datetime,sys
d=datetime.date(*(int(x) for x in sys.argv[1].split('-')))
print(d+datetime.timedelta(days=180))" "$PSL_DATE")"
PSL_STALE_DAY="$(python3 -c "
import datetime,sys
d=datetime.date(*(int(x) for x in sys.argv[1].split('-')))
print(d+datetime.timedelta(days=181))" "$PSL_DATE")"

# Mutation: change the comparison to >= PSL_MAX_AGE_DAYS -> this goes red at 1.
run_psl_case "psl drift: exactly 180 days old is still fresh" 0 "$PSL_OK_DAY"
# Mutation: drop the staleness comparison -> exit 0, red.
run_psl_case "psl drift: 181 days old is stale" 1 "$PSL_STALE_DAY"
# The committed snapshot must be fresh TODAY as well, or the branch ships a
# list that is already past its own limit.
run_psl_case "psl drift: the committed snapshot is fresh right now" 0 ""

PSL_NO_VERSION="$(mktemp)"
printf '%s\n' '// no version line here' \
  '// ===BEGIN ICANN DOMAINS===' 'com' '// ===END ICANN DOMAINS===' \
  > "$PSL_NO_VERSION"
# A snapshot whose age cannot be read is a config error, never a silent pass —
# "I could not tell" must not look like "it is fine".
# Mutation: return 0 when psl_snapshot_date is None -> exit 0, red.
run_psl_case "psl drift: a snapshot with no VERSION line is a config error" 2 \
  "2026-08-28" "$PSL_NO_VERSION"
rm -f "$PSL_NO_VERSION"

# =============================================================================
# WARP-2516 — a regex literal is not a string, and not a divide.
#
# `scan_source` did not know about regex literals, so the apostrophe in
# `/[^']/` opened a phantom string that never closed: comment stripping
# stopped for the rest of the file, and a hostname in a `//` comment below it
# counted as a NON-COMMENT literal and backed a registry entry that should
# have been reported as unreferenced. That is the escape WARP-2452 exists to
# close, reachable with one regex.
# =============================================================================

# The reproduction. The docs comment carries the host, so the denial pass is
# satisfied either way and only the BACKING pass can move: the entry has no
# real literal, so it must fail.
# Mutation: drop the regex branch in scan_source -> the phantom string swallows
# the comment, the comment backs the entry, exit 0, red.
run_entry_case "regex: an apostrophe in a regex does not turn a comment into a literal" 1 \
  "$YAML_EGRESS" "apps/svc/src/files.ts" \
  "const re = /[^']/;
// baseUrl: https://files.allowed-vendor.com
export const FILES_BASE_URL = process.env.FILES_BASE_URL;"

# ...and the same file WITHOUT the regex already failed, which is what makes
# the row above a regression test rather than a restatement of WARP-2452.
run_entry_case "regex: the same comment-only entry fails with no regex present" 1 \
  "$YAML_EGRESS" "apps/svc/src/files.ts" \
  '// baseUrl: https://files.allowed-vendor.com
export const FILES_BASE_URL = process.env.FILES_BASE_URL;'

# No over-skipping: the literal must end at the closing `/`, not at the end of
# the line, or every host sharing a line with a regex goes invisible.
# Mutation: skip to the end of the line instead of the closing `/` -> the host
# after it is never seen, exit 0, red.
run_case_grep "regex: a host later on the same line is still found" 1 \
  "apps/svc/src/beacon.ts" \
  'const cleaned = raw.replace(/[^a-z'"'"']/g, ""); const HOST = "api.evil-corp.io";' \
  "api.evil-corp.io"

# The other direction — a regex is CODE, so its characters are still yielded
# and still back an entry. Skipping them the way a comment is skipped would
# make `/files.allowed-vendor.com/` stop counting as the code that names the
# host.
# Mutation: skip regex contents instead of yielding them -> the entry loses its
# only backing, exit 1, red.
run_entry_case "regex: a host inside a regex still backs an entry" 0 \
  "$YAML_EGRESS" "apps/svc/src/files.ts" \
  'export const FILES_RE = /files.allowed-vendor.com/;'

# A `/` the heuristic must DECLINE. `[` puts it in expression position, so the
# regex branch really is entered here — and a JS regex cannot span lines, so
# with no closing `/` before the newline it has to give up. Otherwise one stray
# slash blinds comment stripping for the rest of the file, which is the very
# failure this ticket fixes, reintroduced from the other side.
#
# `width / height` does NOT exercise this: a division follows a value, so it is
# never in expression position and the branch is never entered. (Caught by
# mutation R4, which left that version green.)
# Mutation: return the end of the file instead of None at the newline -> the
# comment below is swallowed, backs the entry, exit 0, red.
run_entry_case "regex: an unterminated slash does not swallow the comment below it" 1 \
  "$YAML_EGRESS" "apps/svc/src/files.ts" \
  'const broken = [ /a ];
// baseUrl: https://files.allowed-vendor.com
export const FILES_BASE_URL = process.env.FILES_BASE_URL;'

# JSX closing tags are the shape most likely to be mistaken for a regex, and a
# `.tsx` file full of them would go dark. `<` is deliberately absent from
# REGEX_POSITION_CHARS; this row is what says so.
#
# TWO closing tags with the host between them, on one line — the ordinary shape
# of a JSX row. One tag alone pins nothing: with no second `/` before the
# newline the scan declines anyway, so the row stays green either way. (Caught
# by mutation R5, which left that version green.)
# Mutation: add "<" to REGEX_POSITION_CHARS -> `/b>{"..."}</li` is eaten as a
# regex literal and the host between the tags is never extracted, exit 0, red.
run_case_grep "regex: JSX closing tags are not regex literals" 1 \
  "apps/svc/src/panel.tsx" \
  'export const Row = <li><b>host</b>{"api.evil-corp.io"}</li>;' \
  "api.evil-corp.io"

echo
echo "egress-scan tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
