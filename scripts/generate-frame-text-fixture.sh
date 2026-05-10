#!/usr/bin/env bash
# Regenerate services/file-indexer/tests/fixtures/with-frame-text.mp4.
# Uses Docker so the build is reproducible regardless of host ffmpeg.
#
# Three on-screen slides; each is exact-string assertable by the
# WARP-224 e2e flow:
#   slide 1: BUDGET KICKOFF
#   slide 2: Q4 REVENUE TARGET
#   slide 3: ONE HUNDRED THOUSAND
#
# Output: ~30-50 KB MP4, 5 seconds, no audio, no subtitle stream.
# Frame-OCR is the only retrievable channel.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
FIXTURE_DIR="${REPO_ROOT}/services/file-indexer/tests/fixtures"
OUT="${FIXTURE_DIR}/with-frame-text.mp4"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Step 1 — render three PNG slides with PIL.
docker run --rm -v "${TMP}:/work" -w /work python:3.12-slim \
  bash -c '
    pip install --quiet --no-cache-dir Pillow &&
    python - <<PY
from PIL import Image, ImageDraw, ImageFont
slides = ["BUDGET KICKOFF", "Q4 REVENUE TARGET", "ONE HUNDRED THOUSAND"]
for i, line in enumerate(slides, start=1):
    im = Image.new("RGB", (1280, 720), "black")
    d = ImageDraw.Draw(im)
    f = ImageFont.load_default(size=80)
    bbox = d.textbbox((0, 0), line, font=f)
    x = (1280 - bbox[2]) / 2
    y = (720 - bbox[3]) / 2
    d.text((x, y), line, fill="white", font=f)
    im.save(f"/work/slide_{i}.png")
print("rendered", len(slides), "slides")
PY
'

# Step 2 — concat slides into an MP4 at 0.6 fps (≈1.66s per slide, 5s total).
docker run --rm -v "${TMP}:/work" -w /work jrottenberg/ffmpeg:7-alpine \
  -y -framerate 0.6 -i slide_%d.png \
  -c:v libx264 -t 5 -pix_fmt yuv420p -an \
  /work/out.mp4

mkdir -p "${FIXTURE_DIR}"
cp "${TMP}/out.mp4" "${OUT}"
ls -lh "${OUT}"
echo "OK: ${OUT}"
