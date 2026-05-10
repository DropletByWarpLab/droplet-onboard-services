/**
 * WARP-225 — exhaustive coverage of the MIME → category classifier.
 *
 * The list mirrors `ALLOWED_MIMES` in routes/files-brain.ts (WARP-201..208):
 * any MIME the upload route accepts must classify into a non-`other` bucket
 * here, otherwise the dashboard donut would have a misleading "other" slice
 * for every uploaded file. We assert that property explicitly.
 */

import { describe, it, expect } from "vitest";
import { mimeToCategory, CATEGORY_ORDER } from "./mime-category.js";

describe("mimeToCategory", () => {
  // Every MIME the BrainMemoryItem upload route accepts must classify into
  // one of the 7 named buckets. If you add an extractor + MIME, add the
  // mapping in mime-category.ts AND the SQL migration AND a row here.
  const cases: Array<[string, string]> = [
    // WARP-197 audio
    ["audio/mpeg", "audio"],
    ["audio/mp4", "audio"],
    ["audio/wav", "audio"],
    ["audio/x-wav", "audio"],
    ["audio/ogg", "audio"],
    ["audio/flac", "audio"],
    ["audio/webm", "audio"],
    ["audio/aac", "audio"],
    // WARP-198 video
    ["video/mp4", "video"],
    ["video/quicktime", "video"],
    ["video/x-matroska", "video"],
    ["video/webm", "video"],
    ["video/x-msvideo", "video"],
    ["video/mpeg", "video"],
    // WARP-199 email
    ["message/rfc822", "email"],
    ["application/vnd.ms-outlook", "email"],
    ["application/x-msmail", "email"],
    // WARP-200 archive
    ["application/zip", "archive"],
    ["application/x-zip-compressed", "archive"],
    ["application/x-tar", "archive"],
    ["application/gzip", "archive"],
    ["application/x-gzip", "archive"],
    ["application/x-bzip2", "archive"],
    // WARP-201 pdf
    ["application/pdf", "pdf"],
    // WARP-201 image (Tesseract OCR)
    ["image/jpeg", "image"],
    ["image/png", "image"],
    ["image/heic", "image"],
    ["image/tiff", "image"],
    ["image/webp", "image"],
    // WARP-201 text-like docs
    [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "text",
    ],
    ["application/msword", "text"],
    ["text/plain", "text"],
    ["text/markdown", "text"],
    ["text/csv", "text"],
    ["text/html", "text"],
    ["text/x-markdown", "text"],
    ["application/json", "text"],
    ["application/xml", "text"],
  ];

  it.each(cases)("classifies %s as %s", (mime, expected) => {
    expect(mimeToCategory(mime)).toBe(expected);
  });

  it("falls back to 'other' for unknown MIMEs", () => {
    expect(mimeToCategory("application/octet-stream")).toBe("other");
    expect(mimeToCategory("foo/bar")).toBe("other");
  });

  it("collapses null / empty / undefined to 'other'", () => {
    expect(mimeToCategory(null)).toBe("other");
    expect(mimeToCategory(undefined)).toBe("other");
    expect(mimeToCategory("")).toBe("other");
  });

  it("never returns a category outside the canonical order", () => {
    for (const [mime] of cases) {
      expect(CATEGORY_ORDER).toContain(mimeToCategory(mime));
    }
  });

  it("CATEGORY_ORDER has exactly the 8 documented buckets", () => {
    expect([...CATEGORY_ORDER].sort()).toEqual([
      "archive",
      "audio",
      "email",
      "image",
      "other",
      "pdf",
      "text",
      "video",
    ]);
  });
});
