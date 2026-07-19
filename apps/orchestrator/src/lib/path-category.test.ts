/**
 * WARP-1394 — pathToCategory() unit tests.
 *
 * TS twin of the `path_ext_to_category()` SQL function (see the
 * WARP-1394 migration). Nextcloud-synced files carry no MIME type in
 * `FileIndexStatus`, so the dashboard's context-meter buckets them by
 * file extension instead. Same 8-category set as mime_to_category();
 * both implementations keep byte-identical decision trees.
 */

import { describe, it, expect } from "vitest";
import { pathToCategory } from "./path-category.js";

describe("pathToCategory", () => {
  const cases: Array<[string, string]> = [
    // audio
    ["/Music/song.mp3", "audio"],
    ["/voice/memo.m4a", "audio"],
    ["/a/b/clip.wav", "audio"],
    ["/pod.flac", "audio"],
    ["/pod.ogg", "audio"],
    ["/pod.opus", "audio"],
    // video
    ["/Movies/trip.mp4", "video"],
    ["/cam/front-door.mkv", "video"],
    ["/clip.mov", "video"],
    ["/clip.webm", "video"],
    ["/clip.avi", "video"],
    // pdf
    ["/Docs/report.pdf", "pdf"],
    ["/Docs/REPORT.PDF", "pdf"], // case-insensitive
    // image
    ["/Photos/cat.jpg", "image"],
    ["/Photos/cat.jpeg", "image"],
    ["/scan.png", "image"],
    ["/scan.tiff", "image"],
    ["/scan.heic", "image"],
    ["/scan.webp", "image"],
    // email
    ["/Mail/invoice.eml", "email"],
    ["/Mail/old.msg", "email"],
    // archive
    ["/backups/site.zip", "archive"],
    ["/backups/logs.tar", "archive"],
    ["/backups/logs.tar.gz", "archive"], // last extension wins
    ["/backups/logs.tgz", "archive"],
    ["/backups/logs.bz2", "archive"],
    // text-like documents
    ["/Notes/todo.txt", "text"],
    ["/Notes/readme.md", "text"],
    ["/Exports/2026-invoices.csv", "text"],
    ["/Exports/data.tsv", "text"],
    ["/config/settings.json", "text"],
    ["/config/feed.xml", "text"],
    ["/pages/index.html", "text"],
    ["/pages/index.htm", "text"],
    ["/Docs/letter.docx", "text"],
    ["/Docs/legacy.doc", "text"],
    ["/Docs/note.rtf", "text"],
    ["/ops/service.log", "text"],
    ["/ops/stack.yaml", "text"],
    ["/ops/stack.yml", "text"],
    ["/Docs/notes.markdown", "text"],
    // other: unknown, extensionless, dotfiles, trailing dot
    ["/bin/blob.xyz", "other"],
    ["/burrito", "other"],
    ["/home/.env", "other"],
    ["/weird/name.", "other"],
    ["", "other"],
  ];

  it.each(cases)("%s → %s", (path, category) => {
    expect(pathToCategory(path)).toBe(category);
  });

  it("only considers the basename (dots in directories don't classify)", () => {
    expect(pathToCategory("/v1.2/README")).toBe("other");
    expect(pathToCategory("/v1.2/notes.txt")).toBe("text");
  });
});
