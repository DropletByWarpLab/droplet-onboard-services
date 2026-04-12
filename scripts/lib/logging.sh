#!/usr/bin/env bash
# logging.sh — Colored output, log file, and progress helpers for setup scripts.
# Source this file; do not execute directly.

# --- Colors (disabled when not a TTY) ---
if [ -t 1 ]; then
  _RED='\033[0;31m'
  _GREEN='\033[0;32m'
  _YELLOW='\033[0;33m'
  _BLUE='\033[0;34m'
  _CYAN='\033[0;36m'
  _BOLD='\033[1m'
  _DIM='\033[2m'
  _RESET='\033[0m'
else
  _RED='' _GREEN='' _YELLOW='' _BLUE='' _CYAN='' _BOLD='' _DIM='' _RESET=''
fi

# --- Log file ---
LOG_FILE="${LOG_FILE:-${REPO_ROOT:-.}/.data/setup.log}"

_ensure_log_dir() {
  local log_dir
  log_dir="$(dirname "$LOG_FILE")"
  mkdir -p "$log_dir" 2>/dev/null || true
  # Reclaim a root-owned log file from a previous Docker/sudo run
  if [ -f "$LOG_FILE" ] && [ ! -w "$LOG_FILE" ]; then
    sudo rm -f "$LOG_FILE" 2>/dev/null || rm -f "$LOG_FILE" 2>/dev/null || true
  fi
}

_log_to_file() {
  _ensure_log_dir
  printf "[%s] %s\n" "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG_FILE" 2>/dev/null || true
}

# --- Public logging functions ---

log_info() {
  printf "${_BLUE}info${_RESET}  %s\n" "$*"
  _log_to_file "INFO  $*"
}

log_warn() {
  printf "${_YELLOW}warn${_RESET}  %s\n" "$*" >&2
  _log_to_file "WARN  $*"
}

log_error() {
  printf "${_RED}error${_RESET} %s\n" "$*" >&2
  _log_to_file "ERROR $*"
}

log_success() {
  printf "${_GREEN}ok${_RESET}    %s\n" "$*"
  _log_to_file "OK    $*"
}

# Numbered step indicator: log_step 1 7 "Installing Docker"
log_step() {
  local current="$1" total="$2"
  shift 2
  printf "\n${_BOLD}[%d/%d]${_RESET} ${_CYAN}%s${_RESET}\n" "$current" "$total" "$*"
  _log_to_file "STEP  [$current/$total] $*"
}

# Run a command, showing a spinner if --verbose is not set.
# Usage: run_with_spinner "Pulling postgres:16-alpine" docker pull postgres:16-alpine
run_with_spinner() {
  local label="$1"
  shift

  _log_to_file "RUN   $*"

  if [ "${VERBOSE:-false}" = "true" ]; then
    printf "${_DIM}  → %s${_RESET}\n" "$label"
    "$@" 2>&1 | tee -a "$LOG_FILE"
    return "${PIPESTATUS[0]}"
  fi

  printf "${_DIM}  → %s ... ${_RESET}" "$label"

  local output_file
  output_file=$(mktemp)
  if "$@" > "$output_file" 2>&1; then
    cat "$output_file" >> "$LOG_FILE" 2>/dev/null
    rm -f "$output_file"
    printf "${_GREEN}done${_RESET}\n"
    return 0
  else
    local rc=$?
    cat "$output_file" >> "$LOG_FILE" 2>/dev/null
    printf "${_RED}failed${_RESET}\n"
    # Show last 5 lines of output on failure
    tail -5 "$output_file" >&2
    rm -f "$output_file"
    return $rc
  fi
}

# Print a divider line
log_divider() {
  printf "${_DIM}%s${_RESET}\n" "────────────────────────────────────────────────────"
}
