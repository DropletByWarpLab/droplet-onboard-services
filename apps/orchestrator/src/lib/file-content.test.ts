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
