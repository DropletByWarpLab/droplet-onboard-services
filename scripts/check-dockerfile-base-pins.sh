#!/usr/bin/env bash
# WARP-3670 -- fail when a Dockerfile pulls an image by a floating tag.
#
# Why this exists: a tag (node:22-bookworm-slim, python:3.12-slim) is a moving
# pointer, so two builds of the same commit can ship different base layers, and
# whoever controls the pointer controls what the signed OTA image contains. The
# signature covers the image digest, not how reproducible its contents were.
# Pinning `tag@sha256:<digest>` makes the base an input you can review; the
# `docker` ecosystem in .github/dependabot.yml then moves the pin by PR.
#
# Rule: every `FROM <image>` and every `COPY --from=<image>` must carry
# `@sha256:<64 hex>`. Exempt: `scratch` and a reference to an earlier build
# stage of the same file. A `FROM ${VAR}` is rejected too, because a pin the
# build can override is not a pin.
#
# Run by the hadolint leg of .github/workflows/ci.yml (same path filter, so no
# new job and no added minutes). Usage: scripts/check-dockerfile-base-pins.sh [file...]
# (default: every tracked *Dockerfile*). Plain bash 3.2 + awk -- no GNU-isms.
# Instructions are matched in upper case (the repo convention), so the text of a
# Python heredoc inside a RUN that happens to start with "from x import y" is
# not mistaken for a FROM.
set -eu

if [ "$#" -gt 0 ]; then
  files=("$@")
else
  files=()
  while IFS= read -r f; do files+=("$f"); done < <(git ls-files '*Dockerfile*')
fi

bad=0
for f in "${files[@]}"; do
  awk -v file="$f" '
    function check(img, line,   low, n) {
      low = tolower(img)
      if (low == "scratch" || (low in stage)) return
      # No {64} interval: the CI runner mawk predates repetition support.
      n = index(img, "@sha256:")
      if (n == 0 || length(img) - n - 7 != 64 || substr(img, n + 8) !~ /^[0-9a-f]+$/) {
        printf "%s:%d: image \"%s\" is not pinned by digest (want tag@sha256:<64 hex>)\n", file, line, img
        bad = 1
      }
    }
    { sub(/\r$/, "") }
    /^[[:space:]]*#/ { next }
    $1 == "FROM" {
      i = 2
      while (i <= NF && $i ~ /^--/) i++
      img = $i
      check(img, NR)
      if (tolower($(i + 1)) == "as") stage[tolower($(i + 2))] = 1
      next
    }
    $1 == "COPY" || $1 == "RUN" {
      for (j = 2; j <= NF; j++) {
        if ($j ~ /^--(from|mount=.*from)=/) {
          v = $j
          sub(/^.*from=/, "", v)
          sub(/,.*$/, "", v)
          if (v ~ /^[0-9]+$/) continue
          check(v, NR)
        }
      }
    }
    END { exit bad }
  ' "$f" || bad=1
done

if [ "$bad" -ne 0 ]; then
  echo "check-dockerfile-base-pins: unpinned base image(s) above. Look the digest up read-only (registry HEAD on the manifest) and write tag@sha256:<digest>." >&2
  exit 1
fi
echo "check-dockerfile-base-pins: ${#files[@]} Dockerfile(s), every image pinned by digest"
