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
});

describe("folderOnlyOutcomeMessage", () => {
  it("says what happened to a drop that had no files in it", () => {
    expect(folderOnlyOutcomeMessage(1, undefined)).toBe(
      "Created 1 folder. There were no files in it to upload.",
    );
    expect(folderOnlyOutcomeMessage(13, undefined)).toBe(
      "Created 13 folders. There were no files in them to upload.",
    );
  });

  it("reports the failure instead when the folders could not be created", () => {
    const message = folderOnlyOutcomeMessage(3, RAW);
    expect(message).not.toContain("Created 3 folders");
    expect(message).not.toContain("multer");
  });
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
