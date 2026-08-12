import { describe, it, expect } from "vitest";
import {
  FileText,
  Image as ImageIcon,
  Headphones,
  Film,
  Mail,
  FileArchive,
} from "lucide-react";
import { iconForMime, mimeFromPath } from "@/lib/mime-icons";

describe("iconForMime", () => {
  it.each([
    ["audio/mpeg", Headphones],
    ["audio/mp4", Headphones],
    ["audio/wav", Headphones],
    ["audio/x-wav", Headphones],
    ["audio/ogg", Headphones],
    ["audio/flac", Headphones],
    ["audio/webm", Headphones],
    ["audio/aac", Headphones],
    ["video/mp4", Film],
    ["video/quicktime", Film],
    ["video/x-matroska", Film],
    ["video/webm", Film],
    ["video/x-msvideo", Film],
    ["video/mpeg", Film],
    ["message/rfc822", Mail],
    ["application/vnd.ms-outlook", Mail],
    ["application/x-msmail", Mail],
    ["application/zip", FileArchive],
    ["application/x-zip-compressed", FileArchive],
    ["application/x-tar", FileArchive],
    ["application/gzip", FileArchive],
    ["application/x-gzip", FileArchive],
    ["application/x-bzip2", FileArchive],
    ["image/png", ImageIcon],
    ["image/jpeg", ImageIcon],
    ["image/webp", ImageIcon],
    ["application/pdf", FileText],
    [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      FileText,
    ],
    ["text/plain", FileText],
    ["text/html", FileText],
  ])("returns the right icon for %s", (mime, expected) => {
    expect(iconForMime(mime)).toBe(expected);
  });

  it("falls back to FileText for unknown MIME", () => {
    expect(iconForMime("application/x-octet-stream")).toBe(FileText);
    expect(iconForMime("foo/bar")).toBe(FileText);
    expect(iconForMime("")).toBe(FileText);
  });
});

describe("mimeFromPath", () => {
  it.each([
    ["foo.zip", "application/zip"],
    ["bar.eml", "message/rfc822"],
    ["msg.msg", "application/vnd.ms-outlook"],
    ["clip.mp4", "video/mp4"],
    ["clip.mov", "video/quicktime"],
    ["track.mp3", "audio/mpeg"],
    ["pic.png", "image/png"],
    ["pic.JPG", "image/jpeg"],
    ["doc.pdf", "application/pdf"],
    ["notes.md", "text/markdown"],
    ["data.csv", "text/csv"],
    ["archive.tar", "application/x-tar"],
    ["bundle.tar.gz", "application/gzip"],
    // WARP-1877 additions — the rest of the Office/ODF set, the remaining
    // image formats, and 7z/rar.
    [
      "budget.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ],
    [
      "deck.pptx",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ],
    ["sheet.xls", "application/vnd.ms-excel"],
    ["talk.ppt", "application/vnd.ms-powerpoint"],
    ["notes.odt", "application/vnd.oasis.opendocument.text"],
    ["book.epub", "application/epub+zip"],
    ["memo.rtf", "application/rtf"],
    ["logo.svg", "image/svg+xml"],
    ["scan.tiff", "image/tiff"],
    ["dump.7z", "application/x-7z-compressed"],
    ["old.rar", "application/vnd.rar"],
  ])("maps %s -> %s", (path, expected) => {
    expect(mimeFromPath(path)).toBe(expected);
  });

  it("falls back to application/octet-stream for unknown extensions", () => {
    expect(mimeFromPath("noext")).toBe("application/octet-stream");
    expect(mimeFromPath("foo.unknownext")).toBe("application/octet-stream");
  });
});
