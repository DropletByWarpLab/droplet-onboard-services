/**
 * WARP-3209 — orchestrator TypeScript is pinned to LF.
 *
 * `.gitattributes` pinned `.py`/`.sh`/`.yml` but not `.ts`. On a Windows clone
 * with `core.autocrlf=true`, git leaves a file alone when the index copy
 * already has CRLF, so one CRLF-materialized edit was committed as CRLF:
 * `routes/workspace.ts` went to CRLF on review-fix d7bfd489 and a ~90-line
 * change showed up as a 1,590-line rewrite that broke `git blame` for the whole
 * router and would have conflicted with every open PR touching it. An explicit
 * `text eol=lf` attribute makes git normalize on add regardless of what the
 * index holds.
 *
 * The first test guards the pin (any platform); the second guards the bytes of
 * the file that regressed.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, packagePath } from "./helpers/test-paths.js";

describe("WARP-3209 — orchestrator TypeScript pinned to LF", () => {
  it("`.gitattributes` pins *.ts to LF", () => {
    const gitattributes = readFileSync(join(REPO_ROOT, ".gitattributes"), "utf8");
    const pinned = gitattributes
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .some((line) => /^\*\.ts\s+.*\btext\b.*\beol=lf\b/.test(line));

    expect(
      pinned,
      "`.gitattributes` must carry a `*.ts text eol=lf` rule — without it a " +
        "Windows checkout can commit a CRLF file and turn a small diff into a " +
        "whole-file rewrite.",
    ).toBe(true);
  });

  it("routes/workspace.ts contains no CR bytes", () => {
    const bytes = readFileSync(packagePath("src", "routes", "workspace.ts"));
    const firstCr = bytes.indexOf(0x0d);
    expect(
      firstCr,
      `routes/workspace.ts has a CR byte at offset ${firstCr}. Convert it back to LF ` +
        "(`git add --renormalize`) — a CRLF file rewrites every line in the diff.",
    ).toBe(-1);
  });
});
