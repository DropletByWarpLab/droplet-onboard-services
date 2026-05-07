#!/usr/bin/env bash
# Generate gRPC stubs from proto definitions.
# Run from the repo root: ./scripts/generate-grpc.sh

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

PROTO_DIR="$REPO_ROOT/proto"
AI_GATEWAY_DIR="$REPO_ROOT/services/ai-gateway"
GRPC_OUT="$AI_GATEWAY_DIR/grpc_generated"

echo "==> Generating Python gRPC stubs..."
mkdir -p "$GRPC_OUT"
python3 -m grpc_tools.protoc \
  -I"$PROTO_DIR" \
  --python_out="$GRPC_OUT" \
  --grpc_python_out="$GRPC_OUT" \
  "$PROTO_DIR/inference.proto"

# Fix relative imports in generated code
sed -i.bak 's/^import inference_pb2/from grpc_generated import inference_pb2/' "$GRPC_OUT/inference_pb2_grpc.py" 2>/dev/null || \
  sed -i '' 's/^import inference_pb2/from grpc_generated import inference_pb2/' "$GRPC_OUT/inference_pb2_grpc.py"
rm -f "$GRPC_OUT"/*.bak

echo "==> Python gRPC stubs generated in $GRPC_OUT"

# ── TypeScript stubs (orchestrator) ────────────────────────────────────────
# Used by `EmbeddingClient` (apps/orchestrator/src/services/embedding.client.ts)
# to call the ai-gateway's EmbedText RPC. WARP-202.
TS_GRPC_OUT="$REPO_ROOT/apps/orchestrator/src/grpc-generated"
echo "==> Generating TS gRPC stubs..."
mkdir -p "$TS_GRPC_OUT"

# Resolve ts-proto + grpc-tools binaries. npm hoists them to the workspace root
# in this monorepo, but a non-hoisted install would land them under the
# orchestrator's local node_modules — check both.
ORCH_DIR="$REPO_ROOT/apps/orchestrator"
PROTOC_BIN=""
TS_PROTO_PLUGIN=""
for dir in "$ORCH_DIR/node_modules/.bin" "$REPO_ROOT/node_modules/.bin"; do
  if [[ -x "$dir/grpc_tools_node_protoc" && -x "$dir/protoc-gen-ts_proto" ]]; then
    PROTOC_BIN="$dir/grpc_tools_node_protoc"
    TS_PROTO_PLUGIN="$dir/protoc-gen-ts_proto"
    break
  fi
done

if [[ -z "$PROTOC_BIN" || -z "$TS_PROTO_PLUGIN" ]]; then
  echo "ERROR: missing ts-proto/grpc-tools devDeps. Run: npm install --workspace @droplet/orchestrator" >&2
  exit 1
fi

"$PROTOC_BIN" \
  --plugin=protoc-gen-ts_proto="$TS_PROTO_PLUGIN" \
  --ts_proto_out="$TS_GRPC_OUT" \
  --ts_proto_opt=outputServices=grpc-js,esModuleInterop=true,useExactTypes=false \
  --proto_path="$PROTO_DIR" \
  "$PROTO_DIR/inference.proto"

echo "==> TS gRPC stubs generated in $TS_GRPC_OUT"
echo "Done."
