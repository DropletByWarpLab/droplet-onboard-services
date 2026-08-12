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

describe("inlinePreviewContentType", () => {
  // The bug this whole safelist exists to fix: the preview modal embeds the
  // file in an <object>/<video>/<audio>, and those obey `Content-Disposition:
  // attachment` by DOWNLOADING. A PDF has to come back renderable or Preview
  // pops a Save-As dialog over an empty modal.
  it("grants inline to the media the preview modal actually embeds", () => {
    expect(inlinePreviewContentType("report.pdf")).toBe("application/pdf");
    expect(inlinePreviewContentType("clip.mp4")).toBe("video/mp4");
    expect(inlinePreviewContentType("voice.mp3")).toBe("audio/mpeg");
    expect(inlinePreviewContentType("photo.jpeg")).toBe("image/jpeg");
    expect(inlinePreviewContentType("notes.txt")).toBe("text/plain; charset=utf-8");
  });

  it("is case- and path-insensitive, matching on the extension alone", () => {
    expect(inlinePreviewContentType("SCAN.PDF")).toBe("application/pdf");
    expect(inlinePreviewContentType("My Report (final).PdF")).toBe("application/pdf");
  });

  // ── The security invariant ──
  // `contentTypeForFilename` DOES map these to renderable types, which is why
  // the safelist is a separate map rather than a filter over it. Serving a
  // user-uploaded .html or .svg inline on the dashboard origin is stored XSS
  // against the session cookie: both execute script when a browser renders
  // them. They must fall through to an attachment, forever.
  it("REFUSES inline for script-capable types even though they have a Content-Type", () => {
    expect(contentTypeForFilename("payload.html")).toBe("text/html; charset=utf-8");
    expect(inlinePreviewContentType("payload.html")).toBeNull();

    expect(contentTypeForFilename("payload.svg")).toBe("image/svg+xml");
    expect(inlinePreviewContentType("payload.svg")).toBeNull();

    expect(inlinePreviewContentType("payload.htm")).toBeNull();
    expect(inlinePreviewContentType("payload.xhtml")).toBeNull();
  });

  it("refuses inline for unknown and extensionless files rather than guessing", () => {
    expect(inlinePreviewContentType("archive.zip")).toBeNull();
    expect(inlinePreviewContentType("installer.exe")).toBeNull();
    expect(inlinePreviewContentType("Makefile")).toBeNull();
    expect(inlinePreviewContentType("")).toBeNull();
  });

  // An off-safelist type must never be *silently* downgraded to octet-stream
  // and rendered — the contract is null, which the route reads as "attachment".
  it("never falls back to octet-stream the way contentTypeForFilename does", () => {
    expect(contentTypeForFilename("archive.zip")).toBe("application/octet-stream");
    expect(inlinePreviewContentType("archive.zip")).toBeNull();
  });
});
