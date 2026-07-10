#!/bin/bash
# PostToolUse (Edit|Write): typecheck the edited TypeScript workspace.
# CI has no tsc gate (preflight skill §2), so edit-time tsc is the only
# automated one. Exit 2 feeds the errors back to the agent.
set -uo pipefail

FILE_PATH=$(jq -r '.tool_input.file_path // empty')
case "$FILE_PATH" in
  *.ts|*.tsx) ;;
  *) exit 0 ;;
esac

ROOT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
REL="${FILE_PATH#"$ROOT"/}"

WS=""
case "$REL" in
  apps/orchestrator/*)   WS="apps/orchestrator" ;;
  apps/web-dashboard/*)  WS="apps/web-dashboard" ;;
  packages/*)            WS="packages/$(echo "$REL" | cut -d/ -f2)" ;;
  services/mcp-server/*) WS="services/mcp-server" ;;
  *) exit 0 ;;
esac

[ -f "$ROOT/$WS/tsconfig.json" ] || exit 0
# Fresh worktree without node_modules: skip silently — preflight covers it.
[ -d "$ROOT/$WS/node_modules" ] || [ -d "$ROOT/node_modules" ] || exit 0

OUT=$(cd "$ROOT/$WS" && npx tsc --noEmit 2>&1)
if [ $? -ne 0 ]; then
  {
    echo "tsc --noEmit failed in $WS after editing $REL (CI will NOT catch this — no tsc gate):"
    echo "$OUT" | head -40
  } >&2
  exit 2
fi
exit 0
