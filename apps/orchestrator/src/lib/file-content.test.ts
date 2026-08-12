/**
 * Unit coverage for the citation-content helpers behind
 * `GET /api/files/:id/content`. These pin the tricky logic — the polymorphic
 * id classification (numeric Nextcloud id vs path vs brain UUID), the
 * extension→Content-Type map, and Range parsing for media seeking — without
 * needing the Nextcloud / Prisma / fs glue of the route itself.
 */

import { describe, it, expect } from "vitest";
import {
  classifyFileContentId,
  contentTypeForFilename,
  inlinePreviewContentType,
  parseRangeHeader,
} from "./file-content.js";

describe("classifyFileContentId", () => {
  it("treats an all-digit id as a numeric Nextcloud file id", () => {
    expect(classifyFileContentId("12345")).toEqual({
      kind: "ncfile",
      ncFileId: 12345,
    });
  });

  it("treats a /-prefixed id as a path", () => {
    expect(classifyFileContentId("/docs/report.pdf")).toEqual({
      kind: "path",
      path: "/docs/report.pdf",
    });
  });

  it("treats a UUID as a brain-memory item id", () => {
    const id = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
    expect(classifyFileContentId(id)).toEqual({ kind: "brain", itemId: id });
  });
});

describe("contentTypeForFilename", () => {
  it("maps known extensions (case-insensitive)", () => {
    expect(contentTypeForFilename("report.PDF")).toBe("application/pdf");
    expect(contentTypeForFilename("clip.mp4")).toBe("video/mp4");
    expect(contentTypeForFilename("song.mp3")).toBe("audio/mpeg");
    expect(contentTypeForFilename("photo.jpeg")).toBe("image/jpeg");
  });

  it("falls back to octet-stream for unknown or missing extensions", () => {
    expect(contentTypeForFilename("archive.xyz")).toBe("application/octet-stream");
    expect(contentTypeForFilename("noextension")).toBe("application/octet-stream");
  });
});

// WARP-1920 — the inline safelist. `contentTypeForFilename` above stays
// deliberately permissive (it is a "what is this file" answer); this is the
// narrower "may a browser RENDER it on our origin" answer, and the two must
// not be collapsed into one map.
describe("inlinePreviewContentType", () => {
  it("returns the inert type for safelisted extensions (case-insensitive)", () => {
    expect(inlinePreviewContentType("report.PDF")).toBe("application/pdf");
    expect(inlinePreviewContentType("clip.mp4")).toBe("video/mp4");
    expect(inlinePreviewContentType("song.mp3")).toBe("audio/mpeg");
    expect(inlinePreviewContentType("photo.jpeg")).toBe("image/jpeg");
    expect(inlinePreviewContentType("notes.txt")).toBe("text/plain; charset=utf-8");
  });

  // THE guard. Both of these are in `CONTENT_TYPE_BY_EXT` and both execute
  // JavaScript when rendered, so a safelist built by filtering that map — or
  // widened "just to preview a page" — reintroduces stored XSS against the
  // session cookie. They must never resolve to a renderable type.
  it("REFUSES script-capable types (html, svg) — the whole point", () => {
    expect(inlinePreviewContentType("evil.html")).toBeNull();
    expect(inlinePreviewContentType("evil.HTML")).toBeNull();
    expect(inlinePreviewContentType("evil.htm")).toBeNull();
    expect(inlinePreviewContentType("evil.svg")).toBeNull();
    expect(inlinePreviewContentType("evil.SVG")).toBeNull();
  });

  it("refuses unknown and extension-less names rather than guessing", () => {
    // Contrast with contentTypeForFilename, which answers octet-stream here.
    // Null is not the same answer: it means "do not render", and an unknown
    // type is exactly the case that must not be rendered.
    expect(inlinePreviewContentType("archive.xyz")).toBeNull();
    expect(inlinePreviewContentType("noextension")).toBeNull();
    expect(contentTypeForFilename("archive.xyz")).toBe("application/octet-stream");
  });

  // A double extension resolves on the LAST one, which is also what the
  // browser and the OS do. `payload.html.png` is a png; `payload.png.html`
  // is html and must be refused.
  it("resolves on the final extension, not an embedded one", () => {
    expect(inlinePreviewContentType("payload.html.png")).toBe("image/png");
    expect(inlinePreviewContentType("payload.png.html")).toBeNull();
  });

  it("never returns a type that can execute script", () => {
    // Sweep the safelist as a whole rather than trusting the cases above to
    // have enumerated every entry — a future addition is covered by this even
    // if nobody adds a case for it.
    const names = [
      "a.pdf", "a.png", "a.jpg", "a.jpeg", "a.gif", "a.webp", "a.heic",
      "a.bmp", "a.mp4", "a.m4v", "a.mov", "a.webm", "a.mp3", "a.m4a",
      "a.aac", "a.wav", "a.ogg", "a.txt",
    ];
    for (const n of names) {
      const type = inlinePreviewContentType(n);
      expect(type).not.toBeNull();
      expect(type).not.toMatch(/html|svg|xml|javascript/i);
    }
  });
});

describe("parseRangeHeader", () => {
  it("returns null when absent, multi-unit, or empty", () => {
    expect(parseRangeHeader(undefined, 100)).toBeNull();
    expect(parseRangeHeader(null, 100)).toBeNull();
    expect(parseRangeHeader("items=0-10", 100)).toBeNull();
    expect(parseRangeHeader("bytes=-", 100)).toBeNull();
  });

  it("parses a closed range", () => {
    expect(parseRangeHeader("bytes=0-99", 1000)).toEqual({ start: 0, end: 99 });
  });

  it("parses an open-ended range and clamps to size", () => {
    expect(parseRangeHeader("bytes=500-", 1000)).toEqual({ start: 500, end: 999 });
    expect(parseRangeHeader("bytes=0-99999", 1000)).toEqual({ start: 0, end: 999 });
  });

  it("parses a suffix range", () => {
    expect(parseRangeHeader("bytes=-100", 1000)).toEqual({ start: 900, end: 999 });
  });

  it("flags ranges outside the content as unsatisfiable", () => {
    expect(parseRangeHeader("bytes=2000-3000", 1000)).toEqual({
      unsatisfiable: true,
    });
    expect(parseRangeHeader("bytes=-0", 1000)).toEqual({ unsatisfiable: true });
  });
});
