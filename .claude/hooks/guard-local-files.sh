#!/bin/bash
# PreToolUse guard (Edit|Write): force a confirmation before touching the
# untracked local-stack files that are required to run the stack on a dev
# machine and painful to recreate (docker-stack skill, "Running the stack
# locally on macOS"). data/secrets/audit.key loss breaks HMAC audit-chain
# continuity; the compose override has been accidentally deleted before.
set -euo pipefail

FILE_PATH=$(jq -r '.tool_input.file_path // empty')

case "$FILE_PATH" in
  */docker/docker-compose.override.yml|*/data/secrets/*)
    jq -n '{
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: "Untracked local-stack file (required to run the stack on this machine, painful to recreate — see the docker-stack skill). Confirm this edit is intentional."
      }
    }'
    ;;
esac
exit 0
