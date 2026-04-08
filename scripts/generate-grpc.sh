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
echo "Done."
