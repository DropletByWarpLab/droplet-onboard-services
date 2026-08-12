import { describe, it, expect } from "vitest";

import {
  folderOnlyOutcomeMessage,
  uploadOutcomeMessage,
  uploadProgressLabel,
} from "@/lib/upload-feedback";

/**
 * WARP-1876 / WARP-1506 — what an upload run says when it is over.
 *
 * The WARP-1666 / WARP-1843 copy is pinned verbatim in the page specs
 * (files-page.upload-partial-toast.test.tsx); this file owns the branch
 * table, including the two the review added:
 *
 *   · files the walk never got hold of — an online-only OneDrive/iCloud
 *     placeholder is the usual one. They used to fall out of `total`
 *     entirely, so a 200-document migration that moved 188 returned `null`
 *     and the office was told it had succeeded;
 *   · a drop that carried folders but no files at all, which said nothing.
 */

const RAW = new Error("Upload failed: multer LIMIT_FILE_SIZE at layer.js:71");

describe("uploadOutcomeMessage", () => {
  it("is silent when everything landed", () => {
    expect(uploadOutcomeMessage(12, 12, undefined)).toBeNull();
    expect(uploadOutcomeMessage(12, 12, undefined, 0)).toBeNull();
  });

  it("keeps the WARP-1843 partial copy for a run that lost batches", () => {
    expect(uploadOutcomeMessage(21, 41, RAW)).toBe(
      "Uploaded 21 of 41 files. 20 didn't upload — try again to finish.",
    );
  });

  it("falls back to the domain translator when nothing landed", () => {
    const message = uploadOutcomeMessage(0, 3, RAW);
    expect(message).not.toMatch(/Uploaded \d+ of \d+/);
    expect(message).not.toContain("multer");
  });

  it("counts the files it could not read into the total", () => {
    // The concrete case: 200 documents dragged off OneDrive, 12 of them
    // online-only placeholders, every readable one uploaded.
    expect(uploadOutcomeMessage(188, 200, undefined, 12)).toBe(
      "Uploaded 188 of 200 files. 12 items couldn't be read and weren't uploaded.",
    );
  });

  it("keeps unreadable files and failed uploads in separate sentences", () => {
    // 10 dropped: 6 landed, 1 unreadable, 3 lost by a failing batch. The
    // remedies differ, so the counts do not get merged.
    expect(uploadOutcomeMessage(6, 10, RAW, 1)).toBe(
      "Uploaded 6 of 10 files. 3 didn't upload — try again to finish." +
        " 1 item couldn't be read and wasn't uploaded.",
    );
  });

  it("does not invent a server failure when the only loss was unreadable files", () => {
    // No upload call ever ran, so there is no `cause` to translate — saying
    // "we couldn't load those files" here would be a fabricated error.
    const message = uploadOutcomeMessage(0, 2, undefined, 2);
    expect(message).toBe("2 items couldn't be read and weren't uploaded.");
  });

  it("never echoes the raw server message alongside the unreadable count", () => {
    const message = uploadOutcomeMessage(0, 5, RAW, 2);
    expect(message).toContain("2 items couldn't be read");
    expect(message).not.toContain("multer");
    expect(message).not.toContain("layer.js");
  });

  // WARP-1876 review round 2 — a LEAF folder holding no files is the one
  // piece of a dropped tree that can fail with every file still landing:
  // a folder that HAS files fails loudly, because the PUT into the missing
  // collection 409s and the upload accounting catches it. Left out of the
  // totals, a `Clients/` drop arrives short a folder and says nothing.
  it("names the folders it could not create even when every file landed", () => {
    expect(uploadOutcomeMessage(1, 1, RAW, 0, 1)).toBe(
      "Uploaded 1 of 1 files. 1 folder couldn't be created — try again to add it.",
    );
  });

  it("pluralises the folders it could not create", () => {
    expect(uploadOutcomeMessage(4, 4, RAW, 0, 3)).toBe(
      "Uploaded 4 of 4 files. 3 folders couldn't be created — try again to add them.",
    );
  });

  it("keeps lost folders, unreadable files and failed uploads in separate sentences", () => {
    expect(uploadOutcomeMessage(6, 10, RAW, 1, 2)).toBe(
      "Uploaded 6 of 10 files. 3 didn't upload — try again to finish." +
        " 1 item couldn't be read and wasn't uploaded." +
        " 2 folders couldn't be created — try again to add them.",
    );
  });

  it("speaks for a folders-only drop where the folders themselves failed", () => {
    // No files at all, so there is no upload count to lead with — the
    // folders are the whole story, and they are not a server message.
    const message = uploadOutcomeMessage(0, 0, RAW, 0, 3);
    expect(message).toBe("3 folders couldn't be created — try again to add them.");
    expect(message).not.toContain("multer");
  });

  it("stays silent when the folders landed too", () => {
    expect(uploadOutcomeMessage(12, 12, undefined, 0, 0)).toBeNull();
  });
});

describe("folderOnlyOutcomeMessage", () => {
  it("says what happened to a drop that had no files in it", () => {
    expect(folderOnlyOutcomeMessage(1)).toBe(
      "Created 1 folder. There were no files in it to upload.",
    );
    expect(folderOnlyOutcomeMessage(13)).toBe(
      "Created 13 folders. There were no files in them to upload.",
    );
  });

  // The failure half moved to `uploadOutcomeMessage`'s `directoriesFailed`
  // clause, which is the only branch that can see HOW MANY folders were
  // lost. This function is now reached only when every mkdir succeeded, so
  // "Created N folders" is always true when it is called.
});

describe("uploadProgressLabel", () => {
  it("counts files for a flat selection", () => {
    expect(uploadProgressLabel(1, 0)).toBe("Uploading 1 file...");
    expect(uploadProgressLabel(9, 0)).toBe("Uploading 9 files...");
  });

  it("names the folders a tree has to create", () => {
    expect(uploadProgressLabel(9, 2)).toBe("Uploading 9 files into 2 folders...");
  });

  it("does not announce zero files when the drop is folders only", () => {
    expect(uploadProgressLabel(0, 3)).toBe("Creating 3 folders...");
  });
});
