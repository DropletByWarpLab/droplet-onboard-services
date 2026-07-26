#!/usr/bin/env bash
#
# check-schema-drift.sh — WARP-1542.
#
# Fails when `apps/orchestrator/prisma/schema.prisma` and the checked-in
# migration set stop describing the same database.
#
# WHY THIS EXISTS
# ---------------
# `prisma migrate deploy` replays the migration SQL; it never looks at
# schema.prisma. The Prisma *client* is generated from schema.prisma; it never
# looks at the migrations. So the two can drift apart silently and every test
# in the repo stays green: the pg-integration lane only exercises the handful
# of tables its pg-gated files touch, and the unit suite mocks Prisma
# entirely. The divergence only shows up on a real appliance, at runtime, on
# whichever column nobody covered.
#
# `prisma migrate diff --from-migrations --to-schema-datamodel` is the exact
# question: "replay every migration into an empty database — what would still
# have to change for it to match the datamodel?" Empty answer = no drift.
#
# THE BASELINE
# ------------
# main already carried drift when this gate was written (see the annotated
# header of prisma/schema-drift-baseline.sql), and some of it can never be
# closed — Prisma has no datamodel syntax for a GENERATED tsvector column or
# a GIN index, so `migrate diff` will report those forever. A gate that
# demanded an empty diff would therefore have reddened main on day one.
#
# Instead the KNOWN delta is frozen in schema-drift-baseline.sql and this
# script compares against it. Any new drift fails. Drift that gets FIXED also
# fails — with a "shrank" message — so the baseline can't quietly rot into a
# blanket exemption. Either way a human updates the file deliberately.
#
# USAGE
# -----
#   SHADOW_DATABASE_URL=postgresql://user:pw@localhost:5432/drift_shadow \
#     scripts/check-schema-drift.sh [--update]
#
# The shadow database must EXIST and be EMPTY — `migrate diff` replays the
# whole migration set into it. It must also be a pgvector build, because
# 20260412000000_add_file_content_index does `CREATE EXTENSION vector`.
# With the pg-integration container already up, that is:
#
#   docker exec droplet-ci-postgres dropdb  -U droplet_test --if-exists drift_shadow
#   docker exec droplet-ci-postgres createdb -U droplet_test drift_shadow
#
# `--update` rewrites the generated section of the baseline (the annotated
# header above the sentinel is preserved). Run it, then READ THE DIFF and
# write down what changed and why before committing.
#
# Exit 0 when the drift matches the baseline, 1 otherwise.

set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
ORCHESTRATOR_DIR="$REPO_ROOT/apps/orchestrator"
BASELINE="$ORCHESTRATOR_DIR/prisma/schema-drift-baseline.sql"
SENTINEL="-- ===== GENERATED BASELINE BELOW: regenerate with check-schema-drift.sh --update ====="

UPDATE=0
case "${1:-}" in
  --update) UPDATE=1 ;;
  "") ;;
  *) echo "usage: $0 [--update]" >&2; exit 2 ;;
esac

if [ -z "${SHADOW_DATABASE_URL:-}" ]; then
  echo "FAIL  SHADOW_DATABASE_URL is unset — see the usage block in $0" >&2
  exit 2
fi

# Compare SQL statements, not layout. Prisma's script renderer is free to
# move blank lines around between patch releases, and a reformat is not
# drift. Statement text itself is still compared byte-for-byte.
normalize() {
  tr -d '\r' | sed -e 's/[[:space:]]*$//' -e '/^$/d'
}

generated="$(mktemp)"
trap 'rm -f "$generated" "$generated.err" "$generated.norm" "$BASELINE.norm" 2>/dev/null || true' EXIT

# --script renders the delta as SQL and exits 0 whether or not the delta is
# empty (`--exit-code` would change that, but we want the SQL, not a boolean —
# the comparison against the baseline is what decides pass/fail). Capture the
# exit code by hand anyway so a real failure (bad URL, non-empty shadow DB,
# missing pgvector) surfaces as itself instead of an empty "no drift".
set +e
(
  cd "$ORCHESTRATOR_DIR"
  npx --no-install prisma migrate diff \
    --from-migrations ./prisma/migrations \
    --to-schema-datamodel ./prisma/schema.prisma \
    --shadow-database-url "$SHADOW_DATABASE_URL" \
    --script
) > "$generated" 2> "$generated.err"
rc=$?
set -e
if [ "$rc" -ne 0 ]; then
  echo "FAIL  prisma migrate diff exited $rc" >&2
  cat "$generated.err" >&2
  rm -f "$generated.err"
  exit 1
fi
rm -f "$generated.err"

if [ "$UPDATE" -eq 1 ]; then
  if [ ! -f "$BASELINE" ]; then
    echo "FAIL  $BASELINE is missing — restore its annotated header first" >&2
    exit 1
  fi
  # awk with a plain string compare — the sentinel contains `/` and `.`, so a
  # sed address would need escaping and would silently mis-anchor if it drifts.
  if ! grep -Fxq -e "$SENTINEL" "$BASELINE"; then
    echo "FAIL  sentinel line not found in $BASELINE" >&2
    exit 1
  fi
  header="$(awk -v s="$SENTINEL" '{ print } $0 == s { exit }' "$BASELINE")"
  { printf '%s\n' "$header"; cat "$generated"; } > "$BASELINE.new"
  mv "$BASELINE.new" "$BASELINE"
  echo "  OK  baseline regenerated — review the diff before committing"
  exit 0
fi

if [ ! -f "$BASELINE" ]; then
  echo "FAIL  $BASELINE is missing" >&2
  exit 1
fi

if ! grep -Fxq -e "$SENTINEL" "$BASELINE"; then
  echo "FAIL  sentinel line not found in $BASELINE" >&2
  exit 1
fi

# Everything below the sentinel is the frozen delta.
awk -v s="$SENTINEL" 'f { print } $0 == s { f = 1 }' "$BASELINE" \
  | normalize > "$BASELINE.norm"
normalize < "$generated" > "$generated.norm"

if diff -q "$BASELINE.norm" "$generated.norm" >/dev/null 2>&1; then
  if [ -s "$generated.norm" ]; then
    echo "  OK  schema drift matches the documented baseline ($(wc -l < "$generated.norm") statement lines)"
  else
    echo "  OK  no drift between schema.prisma and the migration set"
  fi
  exit 0
fi

baseline_lines="$(wc -l < "$BASELINE.norm" | tr -d ' ')"
actual_lines="$(wc -l < "$generated.norm" | tr -d ' ')"

echo "FAIL  schema.prisma and the migration set drifted away from the documented baseline." >&2
echo "" >&2
echo "  baseline: $baseline_lines statement lines" >&2
echo "  actual:   $actual_lines statement lines" >&2
echo "" >&2
echo "  --- $BASELINE (documented)" >&2
echo "  +++ prisma migrate diff (actual)" >&2
diff -u "$BASELINE.norm" "$generated.norm" | tail -n +3 | sed 's/^/  /' >&2 || true
echo "" >&2
if [ "$actual_lines" -gt "$baseline_lines" ]; then
  echo "  NEW DRIFT. A schema.prisma change landed without the matching migration" >&2
  echo "  (or a migration landed without the matching schema.prisma change). Fix the" >&2
  echo "  source of truth — do NOT just re-baseline." >&2
else
  echo "  The drift SHRANK — someone closed part of the known delta. That is good;" >&2
  echo "  re-baseline deliberately so the file stops claiming drift that is gone:" >&2
  echo "    scripts/check-schema-drift.sh --update" >&2
fi
exit 1
