#!/usr/bin/env bash
# WARP-3670 -- fail when a Dockerfile installs Python packages from a requirements
# file without `--require-hashes`.
#
# Why this exists: an unhashed `pip install -r requirements.txt` re-resolves on
# every build, so two builds of the same commit can ship different transitive
# packages, and whoever can publish (or hijack) a release on the index decides
# what goes into a signed OTA image. A hash-locked file (`uv pip compile
# --generate-hashes`) installed with `--require-hashes` turns any drift into a
# build error. Escape class closed: a new service, or an edit to an existing
# install line, quietly going back to an unhashed install. Procedure and the
# compile recipe: docs/SECURITY.md.
#
# Rule: every logical `RUN` command (continuation lines joined, comment lines
# dropped, split on `&&` `;` `|`) that runs `pip install` / `pip3 install` /
# `uv pip install` with `-r` / `--requirement` must also carry `--require-hashes`.
# Not covered on purpose: `pip install <name>` with no requirements file, and
# the body of a heredoc RUN (neither is how this repo installs dependencies).
#
# Run by the hadolint leg of .github/workflows/ci.yml, in the same step as
# check-dockerfile-base-pins.sh (same path filter, so no new job and no added
# minutes). Usage: scripts/check-dockerfile-hash-locks.sh [file...]
# (default: every tracked *Dockerfile*). Plain bash 3.2 + awk -- no GNU-isms,
# and no {n} regex intervals (the CI runner mawk predates them).
set -eu

# Dockerfiles allowed to install from a requirements file without hashes. One
# path per line, relative to the repo root. Add a line ONLY with a comment saying
# why the file cannot be hash-locked yet and the ticket that removes the line.
# Empty on purpose: every Python image in the tree is hash-locked.
EXEMPT='
'

if [ "$#" -gt 0 ]; then
  files=("$@")
else
  files=()
  while IFS= read -r f; do files+=("$f"); done < <(git ls-files '*Dockerfile*')
fi

bad=0
for f in "${files[@]}"; do
  case "$EXEMPT" in *"
$f
"*) continue ;; esac
  awk -v file="$f" '
    function judge(cmd, ln,   n, i, seg) {
      n = split(cmd, seg, /&&|;|\|/)
      for (i = 1; i <= n; i++) {
        if (seg[i] ~ /(^|[ \t])(pip3?|uv[ \t]+pip)[ \t]+install([ \t]|$)/ \
            && seg[i] ~ /[ \t](-r|--requirement)([ \t=]|[A-Za-z.\/])/ \
            && index(seg[i], "--require-hashes") == 0) {
          printf "%s:%d: installs from a requirements file without --require-hashes\n", file, ln
          bad = 1
        }
      }
    }
    { sub(/\r$/, "") }
    # A comment line inside a continued RUN is dropped by Docker, not a line break.
    /^[[:space:]]*#/ { next }
    cmd == "" && $1 != "RUN" { next }
    {
      if (cmd == "") start = NR
      line = $0
      cont = (line ~ /\\[[:space:]]*$/)
      sub(/\\[[:space:]]*$/, " ", line)
      cmd = cmd " " line
      if (!cont) { judge(cmd, start); cmd = "" }
    }
    END { if (cmd != "") judge(cmd, start); exit bad }
  ' "$f" || bad=1
done

if [ "$bad" -ne 0 ]; then
  echo "check-dockerfile-hash-locks: unhashed requirements install(s) above. Compile a hash lock (docs/SECURITY.md) and install it with pip install --require-hashes --no-deps -r <lock>." >&2
  exit 1
fi
echo "check-dockerfile-hash-locks: ${#files[@]} Dockerfile(s), every requirements install uses --require-hashes"
