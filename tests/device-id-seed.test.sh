#!/usr/bin/env bash
# =============================================================================
# WARP-2938 / ADR-058 — DROPLET_DEVICE_ID is seeded from the hardware, never
# from the hostname, and the image default `droplet` never survives setup.
# =============================================================================
#
# THE INVARIANT:
#   A box's fleet identity is a function of its hardware. Two boxes never
#   share one; the same box re-derives the same one; an id a box already
#   carries is never rewritten — except the single value no box may carry.
#
# WHY (this shipped, and it is why the house unit greets every client with
# a certificate warning):
#   secrets.sh seeded DROPLET_DEVICE_ID=$(hostname). The image hostname is
#   `droplet`, so every box registered itself under the SAME id — one that
#   HQ cannot register without stealing it from every other default-hostname
#   box forever (first-writer-wins, key locked). A box with that id can never
#   provision, never gets its droplet-us.com certificate, and sits on the
#   bootstrap self-signed cert for its whole life. Verified live 2026-09-19
#   on 192.168.9.195: /api/tls/status = BOOTSTRAP_SELF_SIGNED, fqdn null,
#   HQ configured, DROPLET_DEVICE_ID=droplet.
#
# Static + behavioral over a fixture /sys tree; needs no docker, no root, no
# network. Runs the REAL functions out of scripts/lib/secrets.sh — a test
# that reimplements the derivation keeps passing when the code is reverted.
# =============================================================================
set -uo pipefail

REPO_ROOT_REAL="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SECRETS="$REPO_ROOT_REAL/scripts/lib/secrets.sh"
VERIFY="$REPO_ROOT_REAL/scripts/verify.sh"

pass=0; fail=0
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }

printf '\n=== WARP-2938: the device id comes from the hardware, never the hostname ===\n\n'

[ -f "$SECRETS" ] || { printf 'FATAL: %s not found\n' "$SECRETS"; exit 1; }
[ -f "$VERIFY" ]  || { printf 'FATAL: %s not found\n' "$VERIFY"; exit 1; }

# --- PART 1 (static): the hostname seed is gone, in both places it lived ----

if grep -qE 'DROPLET_DEVICE_ID=\$\(hostname' "$SECRETS"; then
  bad "secrets.sh still seeds DROPLET_DEVICE_ID from \$(hostname) — every default-hostname box shares one id"
else
  ok "secrets.sh no longer seeds DROPLET_DEVICE_ID from the hostname"
fi

if grep -qE '_migrate_ensure_key DROPLET_DEVICE_ID "\$\(hostname' "$SECRETS"; then
  bad "migrate_env still backfills DROPLET_DEVICE_ID from \$(hostname)"
else
  ok "migrate_env no longer backfills DROPLET_DEVICE_ID from the hostname"
fi

if grep -qE '^DROPLET_DEVICE_ID=\$device_id$' "$SECRETS" \
   && grep -qE '_migrate_ensure_key DROPLET_DEVICE_ID "\$\(_derive_device_id\)"' "$SECRETS"; then
  ok "both the first seed and the backfill go through _derive_device_id"
else
  bad "the first seed and/or the backfill do not go through _derive_device_id"
fi

# The verify gate must be there, keyed on HQ being configured, and must be a
# hard `check` (not `check_warn`) on the unregistrable value.
_gate_block="$(awk '/WARP-2938/,/^fi$/' "$VERIFY")"
if grep -q 'HQ_ISSUANCE_URL' <<<"$_gate_block" \
   && grep -qE '^\s*check "DROPLET_DEVICE_ID is registrable"' <<<"$_gate_block"; then
  ok "verify.sh hard-fails an unregistrable DROPLET_DEVICE_ID whenever HQ issuance is configured"
else
  bad "verify.sh has no hard DROPLET_DEVICE_ID gate keyed on HQ_ISSUANCE_URL"
fi

if grep -qE '"tests/device-id-seed.test.sh"' "$REPO_ROOT_REAL/.github/workflows/setup-tests.yml" \
   && grep -qE 'run: bash tests/device-id-seed.test.sh' "$REPO_ROOT_REAL/.github/workflows/setup-tests.yml"; then
  ok "this suite is wired into setup-tests.yml (paths + run step)"
else
  bad "this suite is not wired into setup-tests.yml — it would run nowhere (WARP-2647 class)"
fi

# --- PART 2 (behavioral): the real derivation over fixture hardware ----------

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Source the library exactly the way tests/setup.test.sh does: an isolated
# REPO_ROOT, logging stubs, artifact writers stubbed.
export REPO_ROOT="$TMP/repo"
mkdir -p "$REPO_ROOT/.data"
cp "$REPO_ROOT_REAL/.env.example" "$REPO_ROOT/.env.example"
LOG_FILE="$REPO_ROOT/.data/setup.log"; export LOG_FILE
# shellcheck source=../scripts/lib/logging.sh
source "$REPO_ROOT_REAL/scripts/lib/logging.sh"
_write_mosquitto_conf() { return 0; }
_write_mosquitto_acl()  { return 0; }
_generate_tls_cert()    { return 0; }
# shellcheck source=../scripts/lib/secrets.sh
source "$SECRETS"
_write_mosquitto_conf() { return 0; }
_write_mosquitto_acl()  { return 0; }
_generate_tls_cert()    { return 0; }

# The expected id is computed independently of the function under test, from
# the documented recipe: droplet- + first 12 hex of SHA-256("<kind>:<value>").
expect_id() { printf 'droplet-%s' "$(printf '%s:%s' "$1" "$2" | _sha256_hex | cut -c1-12)"; }

# Fixture builders. A physical NIC has a `device` symlink; a wireless one also
# has a `wireless` dir; ARPHRD_ETHER is type 1.
mk_nic() { # root name mac [physical:1|0] [wireless:1|0] [type]
  local d="$1/sys/class/net/$2"; mkdir -p "$d"
  printf '%s\n' "$3" > "$d/address"
  printf '%s\n' "${6:-1}" > "$d/type"
  [ "${4:-1}" = "1" ] && ln -s /dev/null "$d/device"
  [ "${5:-0}" = "1" ] && mkdir -p "$d/wireless"
  return 0
}
mk_dmi() { mkdir -p "$1/sys/class/dmi/id"; printf '%s\n' "$2" > "$1/sys/class/dmi/id/product_uuid"; }
mk_mid() { mkdir -p "$1/etc"; printf '%s\n' "$2" > "$1/etc/machine-id"; }

UUID_A="5f3c2a10-7b8e-4d21-9c3f-0e1a2b3c4d5e"
MAC_A="9c:6b:00:c9:e3:47"
MID_A="0123456789abcdef0123456789abcdef"

# Root A: a real mainboard UUID wins over everything else.
A="$TMP/A"; mk_dmi "$A" "$UUID_A"; mk_nic "$A" enp9s0 "$MAC_A"; mk_mid "$A" "$MID_A"
got="$(DROPLET_ID_SOURCE_ROOT="$A" _derive_device_id)"
if [ "$got" = "$(expect_id dmi "$UUID_A")" ]; then
  ok "a real DMI product UUID anchors the id ($got)"
else
  bad "DMI UUID not used: got $got, expected $(expect_id dmi "$UUID_A")"
fi

got2="$(DROPLET_ID_SOURCE_ROOT="$A" _derive_device_id)"
if [ "$got" = "$got2" ]; then
  ok "the same hardware re-derives the same id (idempotent — a reflash re-provisions against the same HQ key)"
else
  bad "derivation is not stable across calls: $got vs $got2"
fi

# Upper-case + whitespace in the UUID normalise to the same id.
A2="$TMP/A2"; mk_dmi "$A2" "  $(printf '%s' "$UUID_A" | tr '[:lower:]' '[:upper:]')  "
if [ "$(DROPLET_ID_SOURCE_ROOT="$A2" _derive_device_id)" = "$got" ]; then
  ok "UUID case and whitespace do not change the id"
else
  bad "UUID normalisation changed the id"
fi

# Root B: vendor placeholder UUIDs are rejected; the first PHYSICAL Ethernet
# MAC wins — not the wireless radio that sorts first, not docker0, not a veth,
# not a NIC without a device symlink.
for placeholder in "00000000-0000-0000-0000-000000000000" "03000200-0400-0500-0006-000700080009" "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF" "Default string"; do
  B="$TMP/B-$(printf '%s' "$placeholder" | tr -c 'A-Za-z0-9' '_')"
  mk_dmi "$B" "$placeholder"
  mk_nic "$B" awlan0  "02:11:22:33:44:55" 1 1        # wireless, sorts first
  mk_nic "$B" docker0 "02:42:ac:11:00:02" 0 0        # virtual bridge
  mk_nic "$B" enp9s0  "$MAC_A"                        # the cabled NIC
  mk_nic "$B" veth1ab "aa:bb:cc:dd:ee:ff" 0 0
  mk_nic "$B" zz0     "de:ad:be:ef:00:01" 0 0        # no device symlink → virtual
  mk_mid "$B" "$MID_A"
  got="$(DROPLET_ID_SOURCE_ROOT="$B" _derive_device_id)"
  if [ "$got" = "$(expect_id nic "$MAC_A")" ]; then
    ok "placeholder UUID '$placeholder' rejected; first physical Ethernet MAC anchors the id"
  else
    bad "with placeholder UUID '$placeholder': got $got, expected $(expect_id nic "$MAC_A")"
  fi
done

# Upper-case MAC → same id as lower-case.
B2="$TMP/B2"; mk_nic "$B2" eth0 "$(printf '%s' "$MAC_A" | tr '[:lower:]' '[:upper:]')"
if [ "$(DROPLET_ID_SOURCE_ROOT="$B2" _derive_device_id)" = "$(expect_id nic "$MAC_A")" ]; then
  ok "MAC case does not change the id"
else
  bad "MAC normalisation changed the id"
fi

# A non-Ethernet physical interface (type != 1) is skipped.
B3="$TMP/B3"; mk_nic "$B3" can0 "00:00:00:00:00:00" 1 0 280; mk_nic "$B3" eth0 "$MAC_A"
if [ "$(DROPLET_ID_SOURCE_ROOT="$B3" _derive_device_id)" = "$(expect_id nic "$MAC_A")" ]; then
  ok "non-Ethernet and all-zero interfaces are skipped"
else
  bad "a non-Ethernet / all-zero interface was used as the anchor"
fi

# Root C: no DMI, no NIC → machine-id (per install; documented as the fallback).
C="$TMP/C"; mk_mid "$C" "$MID_A"; mkdir -p "$C/sys/class/net"
got="$(DROPLET_ID_SOURCE_ROOT="$C" _derive_device_id)"
if [ "$got" = "$(expect_id machine "$MID_A")" ]; then
  ok "with no hardware identifier, /etc/machine-id anchors the id"
else
  bad "machine-id fallback not used: got $got"
fi

# Root D: nothing at all → a random but well-formed id, different each time,
# and a warning so nobody mistakes it for a hardware anchor.
D="$TMP/D"; mkdir -p "$D"
r1="$(DROPLET_ID_SOURCE_ROOT="$D" _derive_device_id 2>/dev/null)"
r2="$(DROPLET_ID_SOURCE_ROOT="$D" _derive_device_id 2>/dev/null)"
if printf '%s' "$r1" | grep -qE '^droplet-[0-9a-f]{12}$' && [ "$r1" != "$r2" ]; then
  ok "with no identifier at all the id is still unique and well-formed ($r1)"
else
  bad "empty host: expected two distinct droplet-<12 hex> ids, got '$r1' / '$r2'"
fi
if DROPLET_ID_SOURCE_ROOT="$D" _derive_device_id 2>&1 >/dev/null | grep -qi 'random'; then
  ok "…and it says so (random id is logged as a warning)"
else
  # log_warn writes to the log file / stderr depending on logging.sh; accept either.
  if grep -qi 'random id' "$LOG_FILE" 2>/dev/null; then
    ok "…and it says so (random id is logged as a warning)"
  else
    bad "a random id was seeded silently"
  fi
fi

# Every id has exactly the documented shape.
for r in "$A" "$B2" "$C"; do
  v="$(DROPLET_ID_SOURCE_ROOT="$r" _derive_device_id 2>/dev/null)"
  if printf '%s' "$v" | grep -qE '^droplet-[0-9a-f]{12}$'; then
    ok "id shape is droplet-<12 hex> ($v)"
  else
    bad "id shape is wrong: $v"
  fi
done

# --- PART 3 (behavioral): generate_env seeds it, migrate_env keeps/repairs it

# First seed: generate_env on a fresh repo writes the derived id.
export DROPLET_ID_SOURCE_ROOT="$A"
unset DROPLET_DEVICE_ID
if generate_env >/dev/null 2>&1 && [ -f "$REPO_ROOT/.env" ]; then
  seeded="$(grep -E '^DROPLET_DEVICE_ID=' "$REPO_ROOT/.env" | cut -d= -f2-)"
  if [ "$seeded" = "$(expect_id dmi "$UUID_A")" ]; then
    ok "generate_env seeds DROPLET_DEVICE_ID from the hardware ($seeded)"
  else
    bad "generate_env seeded '$seeded', expected $(expect_id dmi "$UUID_A")"
  fi
  if [ "$(grep -cE '^DROPLET_DEVICE_ID=' "$REPO_ROOT/.env")" = "1" ]; then
    ok "exactly one DROPLET_DEVICE_ID line"
  else
    bad "DROPLET_DEVICE_ID appears more than once"
  fi
else
  bad "generate_env failed"
fi

# A provisioning environment / manifest may hand an id in (factory-assigned,
# WARP-2067) — honoured; the unregistrable placeholder in the environment is not.
rm -f "$REPO_ROOT/.env"
if DROPLET_DEVICE_ID="droplet-factory00001" generate_env >/dev/null 2>&1 \
   && grep -qE '^DROPLET_DEVICE_ID=droplet-factory00001$' "$REPO_ROOT/.env"; then
  ok "an id handed in by the provisioning environment is honoured"
else
  bad "an environment-supplied id was not honoured"
fi
rm -f "$REPO_ROOT/.env"
if DROPLET_DEVICE_ID="droplet" generate_env >/dev/null 2>&1 \
   && grep -qE "^DROPLET_DEVICE_ID=$(expect_id dmi "$UUID_A")\$" "$REPO_ROOT/.env"; then
  ok "the placeholder 'droplet' in the environment is ignored in favour of the hardware id"
else
  bad "an environment DROPLET_DEVICE_ID=droplet leaked into .env"
fi

# migrate_env: absent → backfilled from the hardware.
sed -i.bak '/^DROPLET_DEVICE_ID=/d' "$REPO_ROOT/.env" && rm -f "$REPO_ROOT/.env.bak"
migrate_env >/dev/null 2>&1 || true
if grep -qE "^DROPLET_DEVICE_ID=$(expect_id dmi "$UUID_A")\$" "$REPO_ROOT/.env"; then
  ok "migrate_env backfills a missing DROPLET_DEVICE_ID from the hardware"
else
  bad "migrate_env did not backfill DROPLET_DEVICE_ID: $(grep -E '^DROPLET_DEVICE_ID=' "$REPO_ROOT/.env" || echo '<absent>')"
fi

# migrate_env: the image default `droplet` → replaced (it was never registrable).
sed -i.bak -E 's|^DROPLET_DEVICE_ID=.*$|DROPLET_DEVICE_ID=droplet|' "$REPO_ROOT/.env" && rm -f "$REPO_ROOT/.env.bak"
migrate_env >/dev/null 2>&1 || true
if grep -qE "^DROPLET_DEVICE_ID=$(expect_id dmi "$UUID_A")\$" "$REPO_ROOT/.env"; then
  ok "migrate_env replaces the unregistrable image default 'droplet'"
else
  bad "migrate_env left DROPLET_DEVICE_ID=droplet in place"
fi
if grep -q "Migrated .env: DROPLET_DEVICE_ID 'droplet'" "$LOG_FILE" 2>/dev/null; then
  ok "…and logs the migration"
else
  bad "the droplet→derived migration was not logged"
fi

# migrate_env: a real, different id is NEVER rewritten (it may be registered at HQ).
sed -i.bak -E 's|^DROPLET_DEVICE_ID=.*$|DROPLET_DEVICE_ID=droplet-0badc0ffee11|' "$REPO_ROOT/.env" && rm -f "$REPO_ROOT/.env.bak"
migrate_env >/dev/null 2>&1 || true
if grep -qE '^DROPLET_DEVICE_ID=droplet-0badc0ffee11$' "$REPO_ROOT/.env"; then
  ok "migrate_env keeps an existing real id verbatim (an HQ registration is never orphaned)"
else
  bad "migrate_env rewrote a real id: $(grep -E '^DROPLET_DEVICE_ID=' "$REPO_ROOT/.env")"
fi

# migrate_env: an id equal to the hostname is kept (registrable), with a warning.
host_now="$(hostname 2>/dev/null || echo droplet-host)"
if [ "$host_now" != "droplet" ]; then
  sed -i.bak -E "s|^DROPLET_DEVICE_ID=.*$|DROPLET_DEVICE_ID=${host_now}|" "$REPO_ROOT/.env" && rm -f "$REPO_ROOT/.env.bak"
  migrate_env >/dev/null 2>&1 || true
  if grep -qE "^DROPLET_DEVICE_ID=${host_now}\$" "$REPO_ROOT/.env"; then
    ok "migrate_env keeps a hostname-shaped id (it may be registered) and only warns"
  else
    bad "migrate_env rewrote a hostname-shaped id"
  fi
  if grep -q 'equals this host' "$LOG_FILE" 2>/dev/null; then
    ok "…and the warning names the hostname"
  else
    bad "no warning for a hostname-shaped id"
  fi
fi

# --- PART 4: the verify.sh predicate, run as verify.sh runs it ---------------
# Extract the exact `bash -c '…'` body from the gate so this cannot drift from
# what the bench actually executes.
predicate="$(sed -n "/check \"DROPLET_DEVICE_ID is registrable\"/{n;p}" "$VERIFY" | sed -E "s/^\s*bash -c '(.*)'.*$/\1/")"
if [ -n "$predicate" ]; then
  if DROPLET_DEVICE_ID="droplet" bash -c "$predicate"; then
    bad "verify predicate accepts DROPLET_DEVICE_ID=droplet"
  else
    ok "verify predicate rejects DROPLET_DEVICE_ID=droplet"
  fi
  if DROPLET_DEVICE_ID="" bash -c "$predicate"; then
    bad "verify predicate accepts an empty DROPLET_DEVICE_ID"
  else
    ok "verify predicate rejects an empty DROPLET_DEVICE_ID"
  fi
  if DROPLET_DEVICE_ID="$(expect_id dmi "$UUID_A")" bash -c "$predicate"; then
    ok "verify predicate accepts a hardware-anchored id"
  else
    bad "verify predicate rejects a hardware-anchored id"
  fi
else
  bad "could not extract the verify.sh predicate for the registrable check"
fi

printf '\n%d passed, %d failed\n\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
