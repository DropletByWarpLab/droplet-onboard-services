/**
 * WARP-1876 — dropping a FOLDER on the Files page.
 *
 * The upload route writes FLAT: it takes a target dir from `?path=` and a
 * basename from each part's `originalname` (apps/orchestrator/src/routes/
 * files.ts). It has no nested-path contract, so a folder tree has to be
 * decomposed on the client into (a) the directories to create and (b) a
 * per-directory file batch — composed from the endpoints that already
 * exist (POST /api/files/mkdir + POST /api/files/upload), never a
 * fabricated one.
 *
 * Before this ticket a dropped folder arrived as a single zero-byte entry
 * in `dataTransfer.files` and was uploaded as a junk file named after the
 * folder. These are the pure pieces that make it a real tree instead.
 */
import { describe, it, expect } from "vitest";
import {
  groupByDirectory,
  parentDir,
  readDroppedUploads,
  requiredDirectories,
  uploadsFromFileList,
  type DroppedUpload,
} from "./dropped-entries";

function up(relativePath: string, size = 1): DroppedUpload {
  const name = relativePath.split("/").pop() as string;
  return { file: new File(["x".repeat(size)], name), relativePath };
}

// ── The FileSystemEntry shapes the browser hands us on a folder drop ──

interface FakeEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (cb: (f: File) => void) => void;
  createReader?: () => { readEntries: (cb: (e: FakeEntry[]) => void) => void };
}

function fileEntry(name: string): FakeEntry {
  return {
    isFile: true,
    isDirectory: false,
    name,
    file: (cb) => cb(new File(["x"], name)),
  };
}

/**
 * A directory entry whose reader hands back its children in PAGES — the
 * real `readEntries` returns at most 100 per call and signals "done" with
 * an empty array. A reader that is called once loses every child past the
 * first page; that is the bug this shape exists to catch.
 */
function dirEntry(name: string, children: FakeEntry[], pageSize = 100): FakeEntry {
  let cursor = 0;
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => ({
      readEntries: (cb) => {
        const page = children.slice(cursor, cursor + pageSize);
        cursor += page.length;
        cb(page);
      },
    }),
  };
}

function dataTransferOf(entries: FakeEntry[]): DataTransfer {
  return {
    items: entries.map((entry) => ({
      kind: "file",
      webkitGetAsEntry: () => entry,
    })),
    files: [],
  } as unknown as DataTransfer;
}

describe("parentDir", () => {
  it("is empty for a file dropped at the root of the target dir", () => {
    expect(parentDir("invoice.pdf")).toBe("");
  });

  it("is the directory chain for a nested file", () => {
    expect(parentDir("Reports/2026/Q1/summary.docx")).toBe("Reports/2026/Q1");
  });
});

describe("requiredDirectories", () => {
  it("returns every ancestor, shallow first, de-duplicated", () => {
    const dirs = requiredDirectories([
      up("Reports/2026/Q1/a.txt"),
      up("Reports/2026/Q1/b.txt"),
      up("Reports/2026/Q2/c.txt"),
      up("loose.txt"),
    ]);
    // Shallow-first matters: MKCOL on "Reports/2026" fails if "Reports"
    // doesn't exist yet.
    expect(dirs).toEqual(["Reports", "Reports/2026", "Reports/2026/Q1", "Reports/2026/Q2"]);
  });

  it("is empty for a flat selection", () => {
    expect(requiredDirectories([up("a.txt"), up("b.txt")])).toEqual([]);
  });
});

describe("groupByDirectory", () => {
  it("batches files per directory so each group is one upload call", () => {
    const groups = groupByDirectory([
      up("a.txt"),
      up("Reports/b.txt"),
      up("Reports/c.txt"),
      up("d.txt"),
    ]);
    expect(groups.map((g) => g.dir)).toEqual(["", "Reports"]);
    expect(groups[0].files.map((f) => f.name)).toEqual(["a.txt", "d.txt"]);
    expect(groups[1].files.map((f) => f.name)).toEqual(["b.txt", "c.txt"]);
  });
});

describe("uploadsFromFileList", () => {
  it("keeps a plain multi-select flat", () => {
    const files = [new File(["x"], "one.txt"), new File(["x"], "two.txt")];
    expect(uploadsFromFileList(files).map((u) => u.relativePath)).toEqual([
      "one.txt",
      "two.txt",
    ]);
  });

  it("honors webkitRelativePath from a directory picker", () => {
    const f = new File(["x"], "a.txt");
    Object.defineProperty(f, "webkitRelativePath", { value: "Docs/Sub/a.txt" });
    expect(uploadsFromFileList([f])[0].relativePath).toBe("Docs/Sub/a.txt");
  });
});

describe("readDroppedUploads", () => {
  it("expands a dropped folder into its real tree", async () => {
    const dt = dataTransferOf([
      fileEntry("loose.txt"),
      dirEntry("Reports", [
        fileEntry("top.txt"),
        dirEntry("Q1", [fileEntry("jan.csv")]),
      ]),
    ]);

    const uploads = await readDroppedUploads(dt);

    expect(uploads.map((u) => u.relativePath).sort()).toEqual([
      "Reports/Q1/jan.csv",
      "Reports/top.txt",
      "loose.txt",
    ]);
  });

  it("keeps reading until the directory reader is exhausted", async () => {
    // 250 children over a 100-per-call reader: a single readEntries call
    // would silently drop 150 files.
    const children = Array.from({ length: 250 }, (_, i) => fileEntry(`f${i}.txt`));
    const dt = dataTransferOf([dirEntry("Bulk", children)]);

    const uploads = await readDroppedUploads(dt);

    expect(uploads).toHaveLength(250);
  });

  it("drops traversal-shaped names instead of sending them to the server", async () => {
    const dt = dataTransferOf([
      dirEntry("..", [fileEntry("escape.txt")]),
      fileEntry("ok.txt"),
    ]);

    const uploads = await readDroppedUploads(dt);

    expect(uploads.map((u) => u.relativePath)).toEqual(["ok.txt"]);
  });

  it("falls back to dataTransfer.files when the entries API is absent", async () => {
    const dt = {
      items: undefined,
      files: [new File(["x"], "plain.txt")],
    } as unknown as DataTransfer;

    const uploads = await readDroppedUploads(dt);

    expect(uploads.map((u) => u.relativePath)).toEqual(["plain.txt"]);
  });
});
