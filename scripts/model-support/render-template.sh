#!/usr/bin/env bash
# WARP-3411 — show exactly what a model on this box receives.
#
# Renders a request through the chat template of a model that Docker Model
# Runner is serving right now, using that llama-server's own read-only
# endpoints: POST /apply-template (render, no inference) and GET /props
# (build and template). Nothing is loaded, unloaded or generated. Run ON the
# box, as root (it uses `docker top` / `docker exec` on droplet-dmr):
#
#   sudo scripts/model-support/render-template.sh <model-tag> <request.json>
#   sudo scripts/model-support/render-template.sh <model-tag> --props
#   sudo scripts/model-support/render-template.sh <model-tag> --template
#
# request.json is what the gateway would send: {"messages": [...], and
# optionally "tools": [...], "chat_template_kwargs": {...}}. A message the
# template drops simply doesn't appear in the output; that's how WARP-3338
# (later system messages dropped on gpt-oss) was proven. See
# docs/model-support.md.
#
# The model must be LOADED (a llama-server exists only while it is). If it
# isn't, the script says so: make it the active model or send it one chat.
set -euo pipefail
TAG=${1:?usage: render-template.sh <model-tag> <request.json|--props|--template>}
WHAT=${2:?usage: render-template.sh <model-tag> <request.json|--props|--template>}
CT=${DMR_CONTAINER:-droplet-dmr}

# DMR lists models by content id (sha256:…) with their tags; the llama-server
# for a model carries that id on its command line.
SHA=$(docker exec "$CT" curl -s http://127.0.0.1:12434/models | python3 -c '
import json, sys
tag = sys.argv[1]
for m in json.load(sys.stdin):
    if tag in m.get("tags", []) or m.get("id") == tag:
        print(m["id"].split(":", 1)[-1][:12]); break' "$TAG")
[ -n "$SHA" ] || { echo "no model tagged $TAG in $CT" >&2; exit 2; }

SOCK=$(docker top "$CT" -eo pid,args | grep llama-server | grep "$SHA" \
  | grep -o 'inference-runner-[0-9]*\.sock' | head -1 || true)
if [ -z "$SOCK" ]; then
  echo "$TAG is not loaded right now (no llama-server for $SHA). Loaded runners:" >&2
  docker top "$CT" -eo pid,args | grep llama-server | cut -c1-160 >&2 || true
  exit 3
fi

call() { docker exec -i "$CT" curl -s --unix-socket "/app/$SOCK" "$@"; }
case "$WHAT" in
  --props)
    call http://x/props | python3 -c 'import json, sys, hashlib
d = json.load(sys.stdin); t = d.get("chat_template", "")
print("build:", d.get("build_info")); print("model:", d.get("model_path"))
print("template sha256:", hashlib.sha256(t.encode()).hexdigest()[:16], "chars:", len(t))' ;;
  --template)
    call http://x/props | python3 -c 'import json, sys; print(json.load(sys.stdin).get("chat_template", ""))' ;;
  *)
    [ -f "$WHAT" ] || { echo "no such request file: $WHAT" >&2; exit 2; }
    call -X POST http://x/apply-template -H 'Content-Type: application/json' --data-binary @- < "$WHAT" \
      | python3 -c 'import json, sys
d = json.load(sys.stdin)
print(d["prompt"] if "prompt" in d else json.dumps(d, indent=2))' ;;
esac
