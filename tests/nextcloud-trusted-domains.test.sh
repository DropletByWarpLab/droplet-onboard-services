#!/usr/bin/env bash
# =============================================================================
# WARP-1688 — docker/nextcloud-init.sh :: reconcile_trusted_domains
# =============================================================================
#
# Bug (measured live on the box): Nextcloud's STORED `trusted_domains` was
# missing the publicly-trusted per-device FQDN, so browsing the gateway's
# /nextcloud/ leg with `Host: warp-lab.droplet-us.com` returned HTTP 400
# "Access through untrusted domain". The friendly .local/.lan names 307 to that
# same FQDN, so there was NO hostname at which a browser-facing Nextcloud page —
# including the dashboard's embedded editor — could render.
#
# Root cause: docker-compose.yml already appends ${DROPLET_PUBLIC_FQDN} to
# NEXTCLOUD_TRUSTED_DOMAINS, but the stock `nextcloud:29-apache` image consumes
# that env var ONLY inside its install branch. A box renamed AFTER install (this
# one was) freezes its stored list forever. Same "set once, never reconciled"
# class as WARP-1694 — and the fix is the same shape: converge it in the
# every-boot `before-starting` hook.
#
# These tests need no Docker and no Nextcloud. The reconcile is a
# self-contained POSIX function delimited by sentinel markers; we extract it and
# run it against a stub `occ_www` whose stored list and write behaviour are
# scriptable, so we can assert the properties that actually matter:
#   (a) a renamed box ADDS the new FQDN at the next free index,
#   (b) a converged box writes NOTHING (idempotent — no duplicate entries),
#   (c) a blank DROPLET_PUBLIC_FQDN never writes an empty domain,
#   (d) `config:system:get` exiting non-zero for an unset key does NOT abort the
#       hook under `set -euo pipefail` (the WARP-1694 lesson, encoded),
#   (e) drift after the writes is reported LOUDLY on stderr,
#   (f) nothing is ever DELETED — the reconcile only adds.
#
# Runtime: < 5 seconds.
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT_REAL="$(cd "$SCRIPT_DIR/.." && pwd)"
HOOK="$REPO_ROOT_REAL/docker/nextcloud-init.sh"
COMPOSE_FILE="$REPO_ROOT_REAL/docker/docker-compose.yml"
TESTS=0
FAILURES=0

pass() { TESTS=$((TESTS + 1)); printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { TESTS=$((TESTS + 1)); FAILURES=$((FAILURES + 1)); printf "  \033[31m✗\033[0m %s\n" "$1"; }

echo ""
echo "  ==================================================="
echo "  WARP-1688 — nextcloud-init.sh trusted_domains reconcile"
echo "  ==================================================="
echo ""

echo "--- Phase 1: wiring (sentinels, invocation, errexit guard) ---"

if [ -f "$HOOK" ]; then
  pass "docker/nextcloud-init.sh exists"
else
  fail "docker/nextcloud-init.sh missing at $HOOK"; echo "FAILURES=$FAILURES"; exit 1
fi

START_MARK="# >>> reconcile_trusted_domains (WARP-1688)"
END_MARK="# <<< reconcile_trusted_domains (WARP-1688)"

if grep -qF "$START_MARK" "$HOOK" && grep -qF "$END_MARK" "$HOOK"; then
  pass "reconcile_trusted_domains sentinel markers present"
else
  fail "reconcile_trusted_domains sentinel markers ('$START_MARK' .. '$END_MARK') missing"
fi

# Invoked at top level — a defined-but-never-called reconcile converges nothing.
if grep -qE '^reconcile_trusted_domains[[:space:]]*$' "$HOOK"; then
  pass "reconcile_trusted_domains is invoked at top level (runs on every boot)"
else
  fail "reconcile_trusted_domains is never invoked — the hook would define it and move on"
fi

# The hook is the EVERY-BOOT slot (WARP-1694). Guard that compose still mounts
# it there, since a reconcile in the install-only slot is a no-op on a renamed
# box — exactly the failure this ticket exists to fix.
if grep -qE '\./nextcloud-init\.sh:/docker-entrypoint-hooks\.d/before-starting/' "$COMPOSE_FILE"; then
  pass "compose mounts the hook in before-starting (every boot) — the reconcile actually runs"
else
  fail "compose no longer mounts nextcloud-init.sh in before-starting — a renamed box never reconciles"
fi

START_LINE=$(grep -nF "$START_MARK" "$HOOK" | head -1 | cut -d: -f1)
END_LINE=$(grep -nF "$END_MARK" "$HOOK" | head -1 | cut -d: -f1)
BODY=""
if [ -n "$START_LINE" ] && [ -n "$END_LINE" ]; then
  BODY="$(sed -n "${START_LINE},${END_LINE}p" "$HOOK")"
fi

# WARP-1694 lesson, encoded: `occ config:system:get` EXITS NON-ZERO for an unset
# key, and a failing command substitution carries that status into the
# assignment — under `set -euo pipefail` that aborts the whole hook. The `|| true`
# must live INSIDE the substitution.
if printf '%s' "$BODY" | grep -qE 'config:system:get trusted_domains.*\|\| true|\|\| true.*config:system:get trusted_domains'; then
  pass "the config:system:get read is guarded with '|| true' inside the substitution (errexit-safe)"
else
  fail "the config:system:get read is NOT '|| true'-guarded — an unset key aborts the hook (WARP-1694)"
fi

# occ must run as www-data (config.php's owner), not root — the hook's own
# documented foot-gun.
if printf '%s' "$BODY" | grep -q 'occ_www' && ! printf '%s' "$BODY" | grep -qE '\$OCC[[:space:]]'; then
  pass "the reconcile drives occ through occ_www (uid 33), never the root runner"
else
  fail "the reconcile calls occ as root ('\$OCC') — occ refuses any user but config.php's owner"
fi

echo "--- Phase 2: behavioural runs against a stub occ ---"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if [ -n "$BODY" ]; then
  printf '%s\n' "$BODY" > "$WORK/func.sh"
  pass "extracted reconcile_trusted_domains function body"
else
  fail "could not extract the function body — skipping behavioural asserts"
  echo ""; echo "  $((TESTS - FAILURES))/$TESTS passed"; echo "FAILURES=$FAILURES"
  exit 1
fi

# Harness: defines the stub occ_www, sources the extracted function, runs it.
#   STATE/stored            — the container's CURRENT stored trusted_domains
#                             (one per line). Absent file => occ exits non-zero,
#                             mimicking an unset key.
#   STATE/writes            — every `config:system:set` the function issued.
#   STATE/other             — every OTHER occ subcommand (delete, etc).
#   STUB_WRITES_APPLY=0     — accept writes but do NOT reflect them in `stored`,
#                             so the read-back sees drift.
#   STUB_GET_PLAIN=1        — emit the bare `value` form instead of occ's
#                             `  - value` array form.
cat > "$WORK/harness.sh" <<'HARNESS'
#!/usr/bin/env bash
# The hook itself runs under these flags; the reconcile must survive them.
set -euo pipefail

STATE="${STUB_STATE:?STUB_STATE unset}"

occ_www() {
  sub="${1:-}"
  key="${2:-}"
  if [ "$sub" = "config:system:get" ] && [ "$key" = "trusted_domains" ]; then
    if [ -s "$STATE/stored" ]; then
      if [ "${STUB_GET_PLAIN:-0}" = "1" ]; then
        cat "$STATE/stored"
      else
        sed 's/^/  - /' "$STATE/stored"
      fi
      return 0
    fi
    # occ exits NON-ZERO for an unset key — the WARP-1694 trap.
    return 1
  fi
  if [ "$sub" = "config:system:set" ] && [ "$key" = "trusted_domains" ]; then
    idx="${3:-}"
    val="${4:-}"
    val="${val#--value=}"
    printf '%s %s\n' "$idx" "$val" >> "$STATE/writes"
    if [ "${STUB_WRITES_APPLY:-1}" = "1" ]; then
      printf '%s\n' "$val" >> "$STATE/stored"
    fi
    return 0
  fi
  printf '%s %s\n' "$sub" "$key" >> "$STATE/other"
  return 0
}

# shellcheck disable=SC1090
. "$FUNC_FILE"

reconcile_trusted_domains
echo "HOOK_REACHED_END"
HARNESS

# run_case <name> — sets up a fresh STATE dir, runs the harness, captures
# stdout+stderr and the exit code into $WORK/last.*.
run_case() {
  rm -rf "$WORK/state"
  mkdir -p "$WORK/state"
  : > "$WORK/state/writes"
  : > "$WORK/state/other"
  if [ -n "${CASE_STORED:-}" ]; then
    printf '%s\n' "$CASE_STORED" > "$WORK/state/stored"
  fi
  set +e
  STUB_STATE="$WORK/state" \
  FUNC_FILE="$WORK/func.sh" \
  NEXTCLOUD_TRUSTED_DOMAINS="${CASE_ENV_DOMAINS-}" \
  STUB_WRITES_APPLY="${CASE_WRITES_APPLY:-1}" \
  STUB_GET_PLAIN="${CASE_GET_PLAIN:-0}" \
    bash "$WORK/harness.sh" > "$WORK/last.out" 2> "$WORK/last.err"
  LAST_RC=$?
  set -e
}

DESIRED="localhost nextcloud gateway droplet-ai.local droplet-ai.lan droplet.local droplet.lan warp-lab.droplet-us.com"
STORED_STALE="localhost
nextcloud
gateway
droplet-ai.local
droplet-ai.lan
droplet.local
droplet.lan"

# (1) THE BUG: a renamed box is missing the FQDN — it must be ADDED, exactly
#     once, at the next free index (7, after the 7 stored entries).
CASE_STORED="$STORED_STALE" CASE_ENV_DOMAINS="$DESIRED" run_case
if [ "$(wc -l < "$WORK/state/writes" | tr -d ' ')" = "1" ] \
   && grep -qxF "7 warp-lab.droplet-us.com" "$WORK/state/writes"; then
  pass "renamed box: the missing FQDN is added once, at the next free index"
else
  fail "renamed box: expected exactly one write '7 warp-lab.droplet-us.com', got: $(tr '\n' '|' < "$WORK/state/writes")"
fi

if grep -q "HOOK_REACHED_END" "$WORK/last.out" && [ "$LAST_RC" -eq 0 ]; then
  pass "renamed box: the hook runs to completion (errexit-safe)"
else
  fail "renamed box: the hook aborted (rc=$LAST_RC) — stderr: $(tr '\n' ' ' < "$WORK/last.err")"
fi

# (2) IDEMPOTENCE: a converged box writes NOTHING. This is what keeps repeat
#     boots from stacking duplicate entries.
CASE_STORED="$STORED_STALE
warp-lab.droplet-us.com" CASE_ENV_DOMAINS="$DESIRED" run_case
if [ ! -s "$WORK/state/writes" ]; then
  pass "converged box: zero writes on a repeat run (idempotent, no duplicates)"
else
  fail "converged box: rewrote entries that were already present: $(tr '\n' '|' < "$WORK/state/writes")"
fi

# (3) Never DELETES. The old name after a rename is inert (it no longer
#     resolves to the box); removing entries risks taking a live box off the
#     air, so the reconcile only ever adds.
CASE_STORED="$STORED_STALE
old-name.droplet-us.com" CASE_ENV_DOMAINS="$DESIRED" run_case
if [ ! -s "$WORK/state/other" ]; then
  pass "reconcile issues no delete/other occ subcommands (add-only)"
else
  fail "reconcile issued unexpected occ subcommands: $(tr '\n' '|' < "$WORK/state/other")"
fi

# (4) BLANK FQDN: compose renders `... droplet.lan ` with a trailing blank token
#     when DROPLET_PUBLIC_FQDN is unset. An empty domain must never be written.
CASE_STORED="$STORED_STALE" CASE_ENV_DOMAINS="localhost nextcloud gateway droplet-ai.local droplet-ai.lan droplet.local droplet.lan " run_case
if [ ! -s "$WORK/state/writes" ]; then
  pass "blank DROPLET_PUBLIC_FQDN: no empty domain is written"
else
  fail "blank DROPLET_PUBLIC_FQDN produced writes: $(tr '\n' '|' < "$WORK/state/writes")"
fi

# (5) UNSET KEY: `config:system:get` exits non-zero. Under `set -euo pipefail`
#     an unguarded substitution would abort the whole hook here (WARP-1694).
#     Instead every desired domain is written from index 0.
CASE_STORED="" CASE_ENV_DOMAINS="$DESIRED" run_case
if grep -q "HOOK_REACHED_END" "$WORK/last.out" && [ "$LAST_RC" -eq 0 ]; then
  pass "unset trusted_domains: the non-zero occ get does not abort the hook"
else
  fail "unset trusted_domains: the hook aborted (rc=$LAST_RC) — the '|| true' guard is missing"
fi
if [ "$(wc -l < "$WORK/state/writes" | tr -d ' ')" = "8" ] \
   && grep -qxF "0 localhost" "$WORK/state/writes" \
   && grep -qxF "7 warp-lab.droplet-us.com" "$WORK/state/writes"; then
  pass "unset trusted_domains: all 8 desired domains written from index 0"
else
  fail "unset trusted_domains: expected 8 writes from index 0, got: $(tr '\n' '|' < "$WORK/state/writes")"
fi

# (6) occ's PLAIN array output is `  - value`; a future/`--output` change could
#     make it bare. Both must parse, or the reconcile would re-add every domain
#     on every boot (the duplicate-stacking failure mode).
CASE_STORED="$STORED_STALE
warp-lab.droplet-us.com" CASE_ENV_DOMAINS="$DESIRED" CASE_GET_PLAIN=1 run_case
if [ ! -s "$WORK/state/writes" ]; then
  pass "parses the bare (prefix-less) occ output shape too — still idempotent"
else
  fail "bare occ output shape was not parsed — every domain would be re-added each boot"
fi

# (7) DRIFT IS LOUD. If the write silently did not stick, the only symptom is a
#     400 in someone's browser hours later. Say so on stderr instead.
CASE_STORED="$STORED_STALE" CASE_ENV_DOMAINS="$DESIRED" CASE_WRITES_APPLY=0 run_case
if grep -qi "trusted_domains" "$WORK/last.err" \
   && grep -qF "warp-lab.droplet-us.com" "$WORK/last.err"; then
  pass "drift after the writes is reported loudly on stderr"
else
  fail "drift was silent — stderr: $(tr '\n' ' ' < "$WORK/last.err")"
fi
if grep -q "HOOK_REACHED_END" "$WORK/last.out" && [ "$LAST_RC" -eq 0 ]; then
  pass "drift is non-fatal — the rest of the boot hook still runs"
else
  fail "drift aborted the hook (rc=$LAST_RC) — it must warn, not fail the boot"
fi

# (8) The env var being entirely absent must not explode under `set -u`.
CASE_STORED="$STORED_STALE" run_case
if grep -q "HOOK_REACHED_END" "$WORK/last.out" && [ "$LAST_RC" -eq 0 ] && [ ! -s "$WORK/state/writes" ]; then
  pass "absent NEXTCLOUD_TRUSTED_DOMAINS: no writes, no unbound-variable abort"
else
  fail "absent NEXTCLOUD_TRUSTED_DOMAINS: rc=$LAST_RC writes=$(tr '\n' '|' < "$WORK/state/writes")"
fi

echo ""
echo "  $((TESTS - FAILURES))/$TESTS passed"
echo "FAILURES=$FAILURES"
[ "$FAILURES" -eq 0 ] || exit 1
exit 0
