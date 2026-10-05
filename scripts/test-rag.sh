#!/usr/bin/env bash
#
# test-rag.sh — local runner for the WARP-201..206 RAG integration suite.
#
# What it does:
#   1. Verifies Docker is running.
#   2. Brings up the Compose stack with the test override (publishes
#      orchestrator:3000, db:5432, ai-gateway:50051 to the host).
#   3. Waits for orchestrator + Nextcloud health.
#   4. Runs all six rag-*.integration.test.ts files via vitest with
#      RUN_RAG_INTEGRATION=1.
#   5. Tears the stack down on exit (success, failure, or Ctrl-C).
#
# Idempotent — re-running cleans up the previous run before starting.
# Safe to run repeatedly.
#
# WARP-3672: this is a DEVELOPMENT / CI tool. It refuses to run on a
# provisioned appliance (a relocated .env symlink, the encrypted /data mount,
# or the device-identity provisioned marker), before it touches anything, and
# it NEVER edits .env: authentication is switched off for the test stack only
# by docker/docker-compose.test.override.yml (orchestrator `environment:`
# beats the base file's `env_file:`), and the script verifies the effective
# value in the running container before the suite starts.
#
# Flags:
#   --help        Print usage and exit 0.
#   --dry-run     Print the commands that would run, don't execute.
#   --no-down     Skip the teardown on exit (useful for triage).
#   --only PAT    Only run test files matching PAT (passed to vitest).
#                 Example: --only end-to-end
#   --with-ragas  WARP-436: after the vitest run succeeds, install
#                 tests/retrieval-eval/ragas/requirements.txt into a
#                 .ragas-venv and run ragas_runner.py against the still-
#                 running stack. Writes results to
#                 tests/retrieval-eval/ragas/results.{json,md}.
#                 Judge LLM is chosen by RAGAS_JUDGE (default: local
#                 Ollama). For cloud judge, also set OPENAI_API_KEY.
#                 This flag is the local equivalent of the
#                 rag-eval-nightly GitHub Actions workflow.
#
# Prereqs:
#   - Docker Desktop or Docker Engine running with at least 4GB RAM
#     and 30GB free disk.
#   - First run pulls + builds ~5GB of images. Allow 5-10 min on cold.
#
# Typical run time:
#   - Cold:  20-30 min (Nextcloud bootstrap dominates).
#   - Warm:  5-12 min  (everything cached, just ingest + tests).
#
# Exit code: vitest's exit code on success/failure paths, non-zero on
# any of the boot-time guards failing.

set -euo pipefail

# ─── flag parsing ────────────────────────────────────────────────────
DRY_RUN=0
NO_DOWN=0
ONLY=""
WITH_RAGAS=0
# RAGAS_JUDGE: "local" (Ollama, default) or "cloud" (OpenAI; needs OPENAI_API_KEY).
RAGAS_JUDGE="${RAGAS_JUDGE:-local}"

usage() {
  sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h)    usage; exit 0 ;;
    --dry-run)    DRY_RUN=1; shift ;;
    --no-down)    NO_DOWN=1; shift ;;
    --only)       ONLY="${2:-}"; shift 2 ;;
    --with-ragas) WITH_RAGAS=1; shift ;;
    *)
      echo "Unknown flag: $1" >&2
      echo "Use --help for usage." >&2
      exit 64
      ;;
  esac
done

# ─── path setup ──────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_BASE="${REPO_ROOT}/docker/docker-compose.yml"
COMPOSE_OVERRIDE="${REPO_ROOT}/docker/docker-compose.test.override.yml"
COMPOSE_MACOS_OVERRIDE="${REPO_ROOT}/docker/docker-compose.test.macos.yml"
HOST_OS="$(uname -s)"
COMPOSE=(docker compose -f "${COMPOSE_BASE}" -f "${COMPOSE_OVERRIDE}")

# WARP-226: on macOS, Docker Desktop's File Sharing allow-list rejects the base
# Nextcloud /mnt/droplet bind-mount, so `compose up` dies before the stack is
# healthy. Layer a Darwin-only override that drops that (test-irrelevant) mount.
# Linux — CI runners and the Jetson appliance — is untouched; the mount stays.
if [[ "${HOST_OS}" == "Darwin" ]]; then
  COMPOSE+=(-f "${COMPOSE_MACOS_OVERRIDE}")
fi

# Services the integration suite touches. Listed explicitly so we
# don't accidentally bring up frigate / switch / camera-discovery.
SERVICES=(db cache broker ai-gateway file-indexer mcp-server orchestrator nextcloud)

# Test files. Same list as `.github/workflows/rag-tests.yml`.
DEFAULT_TESTS=(
  rag-extractors.integration.test.ts
  rag-search.integration.test.ts
  rag-brain-upload.integration.test.ts
  rag-knowledge.integration.test.ts
  rag-brain-export.integration.test.ts
  rag-end-to-end.integration.test.ts
)

# ─── helpers ─────────────────────────────────────────────────────────
log() { printf '\033[1;34m[test-rag]\033[0m %s\n' "$*"; }
err() { printf '\033[1;31m[test-rag]\033[0m %s\n' "$*" >&2; }

run() {
  if [[ "${DRY_RUN}" == "1" ]]; then
    printf '\033[1;33m[dry-run]\033[0m %s\n' "$*"
  else
    "$@"
  fi
}

# WARP-3672: refuse on a provisioned appliance. MUST stay above the EXIT trap
# below: cleanup() runs `compose down -v`, which on a real box would delete the
# live stack's volumes. Nothing has been started or changed when this fires.
# Each marker has an env override so the refusal path is testable in a sandbox.
appliance_marker() {
  local data_mount="${DROPLET_DATA_MOUNT:-/data}"
  local mapper="${DROPLET_LUKS_MAPPER:-droplet-data-crypt}"
  local di_storage="${TPM_STORAGE:-${DROPLET_DI_STORAGE:-/var/lib/droplet/tpm}}"
  local src
  # .env relocated onto the encrypted /data (secrets.sh relocate_secrets_to_data).
  if [[ -L "${REPO_ROOT}/.env" ]]; then
    echo "${REPO_ROOT}/.env is a symlink onto the encrypted data volume"; return 0
  fi
  src="$(findmnt -n -o SOURCE "${data_mount}" 2>/dev/null || true)"
  if [[ "${src}" == *"${mapper}"* ]]; then
    echo "${data_mount} is the encrypted data mount"; return 0
  fi
  if [[ -f "${di_storage}/provisioned.json" ]]; then
    echo "${di_storage}/provisioned.json exists (device identity is provisioned)"; return 0
  fi
  return 1
}
if marker="$(appliance_marker)"; then
  err "Refusing to run on a provisioned Droplet appliance: ${marker}."
  err "This script is for development machines and CI runners only. Nothing was changed."
  exit 77  # EX_NOPERM
fi

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [[ "${NO_DOWN}" == "1" ]]; then
    log "Skipping teardown (--no-down). Stack still running."
  elif [[ "${DRY_RUN}" == "1" ]]; then
    log "Dry run — no teardown to perform."
  else
    log "Tearing down Compose stack..."
    "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  exit "${rc}"
}
trap cleanup EXIT INT TERM

# ─── prereqs ─────────────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  err "docker not found in PATH"
  exit 127
fi
if ! docker info >/dev/null 2>&1; then
  err "Docker daemon is not running. Start Docker Desktop / dockerd and retry."
  exit 1
fi
if [[ ! -f "${COMPOSE_BASE}" ]] || [[ ! -f "${COMPOSE_OVERRIDE}" ]]; then
  err "Compose files missing — expected ${COMPOSE_BASE} and ${COMPOSE_OVERRIDE}"
  exit 1
fi
if [[ "${HOST_OS}" == "Darwin" ]] && [[ ! -f "${COMPOSE_MACOS_OVERRIDE}" ]]; then
  err "macOS Compose override missing — expected ${COMPOSE_MACOS_OVERRIDE}"
  exit 1
fi

# Auto-generate .env if it's missing. setup.sh's secret generation is
# idempotent and safe here (scripts/setup.sh --skip-docker --skip-start
# is what the setup-e2e workflow uses for the same purpose).
if [[ ! -f "${REPO_ROOT}/.env" ]]; then
  log "No .env found — running setup.sh in secrets-only mode."
  run "${REPO_ROOT}/scripts/setup.sh" --skip-docker --skip-drivers --skip-start
fi

# WARP-227 R3 / WARP-3672: setup.sh writes AUTH_ENABLED=true (production
# default) into .env, but the test lane needs auth off. The test override's
# `environment: AUTH_ENABLED=false` wins over the base file's `env_file:` (the
# Compose precedence rule), so .env is left exactly as it is; the effective
# value is verified in the running orchestrator below.

# ─── boot ─────────────────────────────────────────────────────────────
log "Bringing up Compose stack: ${SERVICES[*]}"
run "${COMPOSE[@]}" up -d "${SERVICES[@]}"

# Wait for orchestrator's rolled-up health endpoint. 60s ceiling: if
# we can't reach it that fast, something is structurally broken
# (port collision, image broken) — fail fast rather than hang.
log "Waiting for orchestrator health on http://localhost:3000/api/orchestrator/health ..."
if [[ "${DRY_RUN}" != "1" ]]; then
  for _ in $(seq 1 30); do
    if curl -sf http://localhost:3000/api/orchestrator/health >/dev/null 2>&1; then
      log "Orchestrator healthy."
      break
    fi
    sleep 2
  done
  if ! curl -sf http://localhost:3000/api/orchestrator/health >/dev/null 2>&1; then
    err "Orchestrator never became healthy after 60s. Logs:"
    "${COMPOSE[@]}" logs orchestrator | tail -50 >&2 || true
    exit 1
  fi
fi

# WARP-3672: prove the override took effect without touching .env. A stack
# that came up with auth on would fail every test with a 401 that looks like a
# product bug; fail here with the real cause instead.
if [[ "${DRY_RUN}" != "1" ]]; then
  effective_auth="$("${COMPOSE[@]}" exec -T orchestrator printenv AUTH_ENABLED 2>/dev/null | tr -d '\r' || true)"
  if [[ "${effective_auth}" != "false" ]]; then
    err "orchestrator AUTH_ENABLED is '${effective_auth}', expected 'false' from docker-compose.test.override.yml."
    err ".env was not modified. Check that the override file is layered (COMPOSE_OVERRIDE) and Compose is >= 2."
    exit 1
  fi
  log "Test lane: orchestrator runs with AUTH_ENABLED=false from the compose override (.env untouched)."
fi

# Nextcloud bootstrap — slow on cold. Don't block the suite if a
# user's only running rag-extractors / rag-knowledge (which don't
# need Nextcloud) but warn loudly. The end-to-end test will hang on
# its own poller if Nextcloud isn't up; that's acceptable feedback.
log "Waiting for Nextcloud bootstrap (up to 4 min on cold)..."
if [[ "${DRY_RUN}" != "1" ]]; then
  ok=0
  for _ in $(seq 1 120); do
    if "${COMPOSE[@]}" exec -T -u www-data nextcloud \
         php /var/www/html/occ status >/dev/null 2>&1; then
      ok=1
      break
    fi
    sleep 2
  done
  if [[ "${ok}" == "1" ]]; then
    log "Nextcloud bootstrapped."
  else
    log "WARNING: Nextcloud not yet bootstrapped after 4 min. Tests that need it will time out."
  fi
fi

# ─── run tests ────────────────────────────────────────────────────────
TESTS_TO_RUN=("${DEFAULT_TESTS[@]}")
if [[ -n "${ONLY}" ]]; then
  filtered=()
  for t in "${DEFAULT_TESTS[@]}"; do
    if [[ "${t}" == *"${ONLY}"* ]]; then
      filtered+=("${t}")
    fi
  done
  if [[ "${#filtered[@]}" -eq 0 ]]; then
    err "--only ${ONLY} matched no test files."
    exit 64
  fi
  TESTS_TO_RUN=("${filtered[@]}")
fi

log "Running RAG integration tests: ${TESTS_TO_RUN[*]}"
cd "${REPO_ROOT}/tests"

# vitest needs the workspace deps. `npm install` here is idempotent
# and fast on warm caches; the alternative (`npm ci`) wipes
# node_modules and re-installs every run.
if [[ "${DRY_RUN}" != "1" ]]; then
  if [[ ! -d node_modules ]]; then
    log "Installing tests/ deps..."
    npm install --no-fund --no-audit
  fi
fi

run env RUN_RAG_INTEGRATION=1 API_URL=http://localhost:3000 \
  npx vitest run --no-file-parallelism "${TESTS_TO_RUN[@]}"

# ─── optional RAGAS eval (WARP-436) ──────────────────────────────────
if [[ "${WITH_RAGAS}" == "1" ]]; then
  log "WARP-436: running RAGAS eval (judge=${RAGAS_JUDGE}) ..."
  if [[ "${RAGAS_JUDGE}" == "cloud" && -z "${OPENAI_API_KEY:-}" ]]; then
    err "--with-ragas with RAGAS_JUDGE=cloud requires OPENAI_API_KEY in env."
    exit 78  # EX_CONFIG
  fi

  RAGAS_DIR="${REPO_ROOT}/tests/retrieval-eval/ragas"
  VENV="${RAGAS_DIR}/.ragas-venv"
  if [[ ! -d "${VENV}" ]]; then
    log "Creating RAGAS venv at ${VENV} (first run is slow)..."
    run python3 -m venv "${VENV}"
  fi
  # shellcheck disable=SC1091
  if [[ "${DRY_RUN}" != "1" ]]; then
    source "${VENV}/bin/activate"
    pip install --quiet --upgrade pip
    pip install --quiet -r "${RAGAS_DIR}/requirements.txt"
  fi

  run python "${RAGAS_DIR}/ragas_runner.py" \
    --variant hybrid \
    --limit 10 \
    --judge "${RAGAS_JUDGE}" \
    --out "${RAGAS_DIR}/results.json" \
    --out-md "${RAGAS_DIR}/results.md"

  if [[ "${DRY_RUN}" != "1" && -f "${RAGAS_DIR}/results.md" ]]; then
    log "RAGAS results:"
    cat "${RAGAS_DIR}/results.md"
  fi
fi
