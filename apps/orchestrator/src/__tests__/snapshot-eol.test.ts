/**
 * WARP-1567 — vitest snapshots must be pinned to LF.
 *
 * Snapshot files are byte-compared by vitest: it reads the `.snap` off disk
 * and compares it to the serializer's output, which ALWAYS uses `\n` (the
 * serializer builds the string in JS; nothing platform-normalizes it). On a
 * Windows clone with `core.autocrlf=true` and no `.gitattributes` pin, git's
 * smudge filter materializes every committed `.snap` as CRLF — so the
 * on-disk bytes never equal the freshly-serialized bytes. The suite then
 * either fails on an "unchanged" snapshot or, when run with `-u`, rewrites
 * the whole file, and the clean filter turns it straight back to LF on
 * commit. Net effect: permanent phantom churn and snapshot assertions that
 * mean nothing on Windows.
 *
 * The fix is the same one the repo already applies to migration SQL, the
 * anchor codegen triplet and the host executables — pin the extension to LF
 * in `.gitattributes`. This test guards the pin (any platform) AND the
 * on-disk bytes (bites on Windows, where the smudge filter is what breaks).
 *
 * Mirrors the file-edit-session.schema.test.ts / vpn-peer-unique-ip.schema
 * .test.ts pattern: locate the repo tree from cwd, read the real bytes,
 * assert the contract.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, packagePath } from "./helpers/test-paths.js";

// Both roots are anchored to this test file, not searched for from the
// runner's cwd (WARP-2654): the old candidate lists accepted the first
// directory that happened to hold a `.gitattributes` or a `src`, which a
// second checkout of this repo does.
const ORCH_SRC = packagePath("src");

/** Every `__snapshots__/*.snap` under the orchestrator source tree. */
function snapshotFiles(): string[] {
  const entries = readdirSync(ORCH_SRC, { recursive: true, encoding: "utf8" });
  return entries
    .filter((rel) => rel.replace(/\\/g, "/").includes("/__snapshots__/"))
    .filter((rel) => rel.endsWith(".snap"))
    .map((rel) => join(ORCH_SRC, rel));
}

describe("WARP-1567 — vitest snapshots pinned to LF", () => {
  const gitattributes = readFileSync(join(REPO_ROOT, ".gitattributes"), "utf8");

  it("`.gitattributes` pins *.snap to LF", () => {
    const pinned = gitattributes
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .some((line) => /^\*\.snap\s+.*\btext\b.*\beol=lf\b/.test(line));

    expect(
      pinned,
      "`.gitattributes` must carry a `*.snap text eol=lf` rule — without it a " +
        "Windows checkout materializes committed snapshots as CRLF and every " +
        "snapshot assertion in the suite compares CRLF bytes against LF output.",
    ).toBe(true);
  });

  it("finds the committed snapshots (guard is not vacuously green)", () => {
    // If snapshots ever move, this test would silently pass over an empty
    // list — assert the fixture surface actually exists.
    expect(snapshotFiles().length).toBeGreaterThan(0);
  });

  it.each(snapshotFiles())("%s contains no CR bytes", (file) => {
    const bytes = readFileSync(file);
    const firstCr = bytes.indexOf(0x0d);
    expect(
      firstCr,
      `${file} has a CR byte at offset ${firstCr}. On Windows this is the ` +
        "autocrlf smudge filter, and it means the *.snap eol=lf pin is " +
        "missing or the file needs `git add --renormalize`.",
    ).toBe(-1);
  });
});
