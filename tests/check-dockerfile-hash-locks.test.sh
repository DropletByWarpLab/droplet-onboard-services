#!/usr/bin/env bash
# WARP-3670 -- self-test for scripts/check-dockerfile-hash-locks.sh: the gate must
# pass hashed installs and installs that use no requirements file, and fail every
# unhashed requirements install, including one hidden in a continued RUN.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECK="$ROOT/scripts/check-dockerfile-hash-locks.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fails=0
expect() { # expect <pass|fail> <name> <dockerfile body>
  printf '%s\n' "$3" > "$TMP/Dockerfile"
  if bash "$CHECK" "$TMP/Dockerfile" >/dev/null 2>&1; then got=pass; else got=fail; fi
  if [ "$got" = "$1" ]; then echo "ok   - $2"; else echo "FAIL - $2 (wanted $1, got $got)"; fails=$((fails + 1)); fi
}

expect pass "hashed pip install"            "RUN pip install --no-cache-dir --require-hashes --no-deps -r requirements.lock"
expect pass "uv pip install, hashed"        "RUN uv pip install --system --no-cache --require-hashes -r requirements.lock"
expect pass "hashed, continued, cache mount" $'RUN --mount=type=cache,target=/root/.cache/pip \\\n    pip install --require-hashes --no-deps -r requirements.lock && \\\n    apt-get purge -y gcc'
expect pass "comment line inside continued RUN" $'RUN pip install --require-hashes --no-deps -r a.lock && \\\n    # a comment\n    pip install --require-hashes --no-deps -r b.lock'
expect pass "no requirements file"          "RUN pip install --no-cache-dir uv==0.12.23"
expect pass "pip word in a comment"         $'# RUN pip install -r requirements.txt\nFROM scratch'
expect pass "not a RUN"                     "COPY requirements.txt pip-install-r.txt"
expect fail "plain -r"                      "RUN pip install -r requirements.txt"
expect fail "--requirement"                 "RUN pip install --no-cache-dir --requirement requirements.txt"
expect fail "pip3"                          "RUN pip3 install -r requirements.txt"
expect fail "uv pip install, unhashed"      "RUN uv pip install --system -r requirements.txt"
expect fail "unhashed, continued"           $'RUN --mount=type=cache,target=/root/.cache/pip \\\n    pip install -r requirements.txt && \\\n    apt-get purge -y gcc'
expect fail "second install unhashed"       "RUN pip install --require-hashes -r a.lock && pip install -r b.txt"
expect fail "hashes only in a comment"      $'RUN pip install \\\n    # --require-hashes\n    -r requirements.txt'

# the real tree must be clean
if bash "$CHECK" >/dev/null 2>&1; then echo "ok   - every tracked Dockerfile hash-locks its requirements install"; else echo "FAIL - tracked Dockerfiles have unhashed requirements installs"; fails=$((fails + 1)); fi
[ "$fails" -eq 0 ]
