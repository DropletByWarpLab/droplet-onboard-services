/**
 * WARP-1877 — MIME → friendly type name.
 *
 * The Files detail panel used to print the raw MIME string, so a .docx read
 * as "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
 * — 71 characters of no use to a home user, and long enough to blow out of
 * its column. `labelForMime` is the single source of truth for the human
 * name; the raw string survives only in the tooltip.
 *
 * The fallback path matters as much as the table: a Nextcloud listing may
 * carry an empty mimeType, "application/octet-stream", or a type we've never
 * seen. None of those may render blank, and none of them may throw.
 */
import { describe, it, expect } from "vitest";
import { labelForMime } from "@/lib/mime-labels";

describe("labelForMime — known types", () => {
  it.each([
    // Office (OOXML)
    [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Word document",
    ],
    [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Excel spreadsheet",
    ],
    [
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "PowerPoint presentation",
    ],
    // Office (legacy binary)
    ["application/msword", "Word document"],
    ["application/vnd.ms-excel", "Excel spreadsheet"],
    ["application/vnd.ms-powerpoint", "PowerPoint presentation"],
    // OpenDocument
    ["application/vnd.oasis.opendocument.text", "OpenDocument text"],
    ["application/vnd.oasis.opendocument.spreadsheet", "OpenDocument spreadsheet"],
    [
      "application/vnd.oasis.opendocument.presentation",
      "OpenDocument presentation",
    ],
    // PDF
    ["application/pdf", "PDF document"],
    // Images
    ["image/png", "PNG image"],
    ["image/jpeg", "JPEG image"],
    ["image/gif", "GIF image"],
    ["image/webp", "WebP image"],
    ["image/heic", "HEIC image"],
    ["image/svg+xml", "SVG image"],
    // Text-ish
    ["text/plain", "Text file"],
    ["text/markdown", "Markdown document"],
    ["text/csv", "CSV spreadsheet"],
    ["text/html", "HTML document"],
    ["application/json", "JSON file"],
    ["application/xml", "XML file"],
    ["application/rtf", "Rich text document"],
    // Archives
    ["application/zip", "ZIP archive"],
    ["application/x-zip-compressed", "ZIP archive"],
    ["application/x-tar", "TAR archive"],
    ["application/gzip", "Gzip archive"],
    ["application/x-7z-compressed", "7z archive"],
    // Media
    ["audio/mpeg", "MP3 audio"],
    ["video/mp4", "MP4 video"],
    ["video/quicktime", "QuickTime video"],
    // Mail
    ["message/rfc822", "Email message"],
  ])("maps %s to %s", (mime, expected) => {
    expect(labelForMime(mime)).toBe(expected);
  });

  it("is case- and parameter-insensitive", () => {
    expect(labelForMime("TEXT/PLAIN")).toBe("Text file");
    expect(labelForMime("text/plain; charset=utf-8")).toBe("Text file");
    expect(labelForMime("  application/pdf  ")).toBe("PDF document");
  });

  it("never returns the raw MIME string for a mapped type", () => {
    const raw =
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    expect(labelForMime(raw)).not.toContain("openxmlformats");
  });
});

describe("labelForMime — fallbacks", () => {
  it("falls back to the type family for an unmapped subtype", () => {
    expect(labelForMime("image/x-canon-cr2")).toBe("Image");
    expect(labelForMime("audio/x-aiff")).toBe("Audio");
    expect(labelForMime("video/x-flv")).toBe("Video");
    expect(labelForMime("text/x-python")).toBe("Text file");
  });

  it("uses the file name when the MIME is missing or opaque", () => {
    expect(labelForMime("", "Freud Biography SR 1.28.docx")).toBe("Word document");
    expect(labelForMime(undefined, "budget.xlsx")).toBe("Excel spreadsheet");
    expect(labelForMime(null, "scan.pdf")).toBe("PDF document");
    expect(labelForMime("application/octet-stream", "clip.mp4")).toBe("MP4 video");
  });

  it("names an unrecognised extension rather than rendering nothing", () => {
    expect(labelForMime("", "firmware.bin")).toBe("BIN file");
    expect(labelForMime("application/x-droplet-thing", "thing.dpl")).toBe(
      "DPL file"
    );
  });

  it("never returns an empty string, and never throws", () => {
    for (const [mime, name] of [
      [undefined, undefined],
      [null, null],
      ["", ""],
      ["   ", "   "],
      ["not-a-mime", "no-extension-here"],
      ["/", "."],
      ["application/octet-stream", undefined],
    ] as Array<[string | null | undefined, string | null | undefined]>) {
      const label = labelForMime(mime, name ?? undefined);
      expect(typeof label).toBe("string");
      expect(label.trim().length).toBeGreaterThan(0);
    }
    expect(labelForMime(undefined)).toBe("Unknown");
  });
});
