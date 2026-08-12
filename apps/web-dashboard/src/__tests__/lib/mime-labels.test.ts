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
import { EXT_TO_MIME } from "@/lib/mime-icons";

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

  it("does not let the extension override an informative MIME family", () => {
    // `EXT_TO_MIME` is icon-oriented: it resolves the container extensions
    // toward audio, so ".ogg" reads as audio/ogg. When the server told us the
    // file is video, that guess must not win.
    expect(labelForMime("video/ogg", "movie.ogg")).toBe("Video");
    expect(labelForMime("video/webm", "clip.webm")).toBe("WebM video");
    expect(labelForMime("audio/ogg", "song.ogg")).toBe("Ogg audio");
  });

  it("documented limitation: no MIME means the container guess stands", () => {
    // With nothing but the name, ".webm" resolves through the icon table's
    // audio-leaning entry. Ordering cannot fix this — it is the accepted cost
    // of reusing one table for icons and labels. Pinned so the miss is a known
    // one rather than a surprise.
    expect(labelForMime("", "clip.webm")).toBe("WebM audio");
  });

  it("does not name a purely numeric last segment as an extension", () => {
    // Nextcloud sends "application/octet-stream" when getcontenttype is
    // absent, so these reach the file-name path in production. "01 file" is a
    // confident lie; "Unknown" is honest.
    expect(labelForMime("application/octet-stream", "Backup 2026.01")).toBe(
      "Unknown"
    );
    expect(labelForMime("application/octet-stream", "report 1.28")).toBe(
      "Unknown"
    );
    // Extensions containing a letter still resolve, including "7z".
    expect(labelForMime("application/octet-stream", "archive.7z")).toBe(
      "7z archive"
    );
    expect(labelForMime("", "Budget 2026.v2")).toBe("V2 file");
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

describe("labelForMime — the two tables agree", () => {
  // The extension path only produces a name if the MIME that `EXT_TO_MIME`
  // yields also has a `MIME_TO_LABEL` entry. Add an extension to mime-icons.ts
  // alone and the Files panel silently degrades to "XYZ file" — this is the
  // test that turns that into a red build.
  //
  // The assertion is that both routes to a type — the MIME and the file name —
  // land on the same words. Drop the label entry and they diverge: the name
  // route falls through to "XYZ file" while the MIME route lands on the family
  // fallback or "Unknown". (Asserting `not.toBe("XYZ file")` directly would
  // false-positive on json/xml, whose real labels are "JSON file"/"XML file".)
  it.each(Object.entries(EXT_TO_MIME))(
    "%s and %s resolve to the same label",
    (ext, mime) => {
      expect(labelForMime("", `x.${ext}`)).toBe(labelForMime(mime));
    }
  );
});
