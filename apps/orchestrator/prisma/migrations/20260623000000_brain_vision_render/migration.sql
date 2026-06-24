-- Image vision: the file-indexer writes a normalized `vision.jpg` render next
-- to each uploaded image's original bytes (downscaled, web/cloud-safe JPEG).
-- This explicit column lets the chat route decide, without guessing, whether an
-- image attachment can be forwarded to a vision-capable model. Defaults false:
-- non-images, pre-feature uploads, and failed renders all stay false (→ the
-- existing OCR-text fallback path).
ALTER TABLE "BrainMemoryItem"
  ADD COLUMN "hasVisionRender" BOOLEAN NOT NULL DEFAULT false;
