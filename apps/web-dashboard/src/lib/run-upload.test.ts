/**
 * WARP-1912 — the run must account for WHICH files landed, not just how many.
 *
 * Undo needs the exact space-relative paths the run put on the box: every
 * file of a successful group, and — for a group that failed partway — the
 * group's files MINUS the typed `UploadBatchError.failedFiles`. A manifest
 * that over-claims would make Undo delete a file the user already had.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return {
    ...actual,
    createDirectory: vi.fn(),
    uploadFiles: vi.fn(),
  };
});

import { createDirectory, uploadFiles, UploadBatchError } from "./api";
import { runUpload } from "./run-upload";
import type { DroppedSelection } from "@/components/FileManager/dropped-entries";

const uploadFilesMock = vi.mocked(uploadFiles);
const createDirectoryMock = vi.mocked(createDirectory);

function selectionOf(paths: string[]): DroppedSelection {
  return {
    uploads: paths.map((relativePath) => ({
      file: new File(["x"], relativePath.split("/").pop() ?? relativePath),
      relativePath,
    })),
    directories: [],
    skipped: 0,
  };
}

beforeEach(() => {
  uploadFilesMock.mockReset().mockResolvedValue(undefined);
  createDirectoryMock.mockReset().mockResolvedValue(undefined);
});

describe("WARP-1912 — runUpload uploadedPaths manifest", () => {
  it("lists every landed file, space-relative to the drop target", async () => {
    const result = await runUpload(selectionOf(["a.txt", "b.txt"]), {
      basePath: "/",
      space: "personal",
    });

    expect(result.uploadedPaths).toEqual(["/a.txt", "/b.txt"]);
  });

  it("joins nested groups onto a non-root base path", async () => {
    const result = await runUpload(
      selectionOf(["a.txt", "Reports/q1.pdf"]),
      { basePath: "/Docs", space: "personal" },
    );

    expect(result.uploadedPaths).toEqual([
      "/Docs/a.txt",
      "/Docs/Reports/q1.pdf",
    ]);
  });

  it("excludes exactly the files the typed error says did not land", async () => {
    uploadFilesMock.mockRejectedValueOnce(
      new UploadBatchError(2, 3, new Error("boom"), ["b.txt"]),
    );

    const result = await runUpload(selectionOf(["a.txt", "b.txt", "c.txt"]), {
      basePath: "/",
      space: "personal",
    });

    expect(result.uploaded).toBe(2);
    expect(result.uploadedPaths).toEqual(["/a.txt", "/c.txt"]);
  });

  it("claims nothing for a group lost to an untyped failure", async () => {
    uploadFilesMock.mockRejectedValueOnce(new Error("socket hang up"));

    const result = await runUpload(selectionOf(["a.txt"]), {
      basePath: "/",
      space: "personal",
    });

    expect(result.uploadedPaths).toEqual([]);
  });
});
