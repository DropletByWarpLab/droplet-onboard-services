#!/usr/bin/env bash
#
# check-pinned-images.sh — WARP-3601.
#
# Fails when a third-party `image:` in the compose files is not pinned by
# digest (`name:tag@sha256:<64 hex>`).
#
# WHY THIS EXISTS
# ---------------
# Postgres, Redis, the MQTT broker, Nextcloud, the document server and
# Frigate hold customer data and secrets, and none of them pass through the
# signed OTA path (they are not built by our CI). A floating tag such as
# `redis:7-alpine` resolves to whatever the registry serves on the day of the
# pull, so a moved or poisoned tag changes what runs next to the data.
# Anything that can silently diverge gets an explicit gate (root CLAUDE.md §9).
#
# WHAT COUNTS AS PINNED
#   * `${VAR:-default}` is resolved to its default first, because the default
#     is what an install that sets nothing runs. Put the digest INSIDE the
#     default (`${FRIGATE_IMAGE:-repo:tag@sha256:...}`), and for a tag
#     variable inside it too (`repo:${TAG:-3.1.0@sha256:...}`).
#   * A service with a `build:` key is built from this repo, not pulled, and
#     is exempt (`droplet/openwrt-singlebox` is such an image).
#   * An operator who sets the variable in .env overrides the pin on purpose;
#     this gate only guards what the repository ships.
#
# To bump a pin: look the digest up for the exact tag (a multi-architecture
# index digest, so amd64 and arm64 both resolve), then change tag and digest
# together in one PR. Never edit only one of the two.
#
# Usage:
#   scripts/check-pinned-images.sh              # check the tracked compose files
#   scripts/check-pinned-images.sh --selfcheck  # prove the gate itself
set -eu

cd "$(dirname "$0")/.."

# Prints "<service>\t<image>\t<has-build 0|1>" per service that has an image.
extract() {
  awk '
    function flush() { if (name != "" && image != "") printf "%s\t%s\t%d\n", name, image, build }
    /^services:[[:space:]]*$/ { in_svc = 1; next }
    /^[A-Za-z_]/ { flush(); name = ""; image = ""; in_svc = 0; next }
    in_svc && /^  [A-Za-z0-9_.-]+:[[:space:]]*$/ {
      flush(); name = $1; sub(/:$/, "", name); image = ""; build = 0; next
    }
    in_svc && /^    build:/ { build = 1; next }
    in_svc && /^    image:/ {
      v = $0; sub(/^    image:[[:space:]]*/, "", v)
      sub(/[[:space:]]+#.*$/, "", v); gsub(/["\047]/, "", v); image = v; next
    }
    END { flush() }
  ' "$1"
}

check_file() { # $1=compose file; prints FAIL lines, returns the failure count
  local bad=0 name image build resolved
  while IFS="$(printf '\t')" read -r name image build; do
    [ -n "$name" ] || continue
    [ "$build" = "1" ] && continue
    resolved="$(printf '%s' "$image" \
      | sed -E 's/\$\{[A-Za-z_][A-Za-z0-9_]*:-([^}]*)\}/\1/g')"
    if ! printf '%s' "$resolved" | grep -Eq '@sha256:[0-9a-f]{64}$'; then
      printf 'FAIL: %s: service "%s" image "%s" is not pinned by digest (name:tag@sha256:<64 hex>)\n' \
        "$1" "$name" "$image" >&2
      bad=$((bad + 1))
    fi
  done < <(extract "$1")
  return "$bad"
}

if [ "${1:-}" = "--selfcheck" ]; then
  t="$(mktemp)"; trap 'rm -f "$t"' EXIT
  D=$(printf 'a%.0s' $(seq 1 64))
  run() { check_file "$t" >/dev/null 2>&1 && echo ok || echo bad; }
  want() { # $1=expected ok|bad $2=label ; compose body on stdin
    cat > "$t"
    [ "$(run)" = "$1" ] || { echo "self-test FAILED: $2" >&2; exit 1; }
  }
  want ok  "digest-pinned image"        <<< "services:
  db:
    image: pgvector/pgvector:pg16@sha256:$D"
  want bad "floating tag"               <<< "services:
  cache:
    image: redis:7-alpine"
  want bad "tag only, digest missing"   <<< "services:
  cache:
    image: \${CACHE_IMAGE:-redis:7-alpine}"
  want ok  "digest inside var default"  <<< "services:
  nvr:
    image: \${NVR_IMAGE:-frigate:0.17.1@sha256:$D}"
  want ok  "digest inside tag var"      <<< "services:
  stt:
    image: wh:\${TAG:-3.1.0@sha256:$D}"
  want ok  "built locally is exempt"    <<< "services:
  router:
    build:
      context: ../x
    image: droplet/openwrt-singlebox:24.10.2"
  want bad "one bad among good ones"    <<< "services:
  a:
    image: x:1@sha256:$D
  b:
    image: y:2"
  echo "check-pinned-images self-test: OK"
  exit 0
fi

fail=0 n=0
for f in docker/docker-compose.yml docker/docker-compose.dev.yml; do
  [ -f "$f" ] || { echo "FAIL: $f missing" >&2; fail=1; continue; }
  n=$((n + $(extract "$f" | wc -l)))
  check_file "$f" || fail=1
done
[ "$fail" -eq 0 ] || { echo "check-pinned-images: FAILED — see the FAIL lines above." >&2; exit 1; }
echo "check-pinned-images: OK — $n image reference(s) checked, every third-party one pinned by digest."
