/**
 * WARP-3317 — the dashboard's fonts are self-hosted, so `next build` needs no network.
 *
 * `next/font/google` downloads the families from fonts.googleapis.com on every
 * build. On 2026-09-28 it failed the docker-build leg of the stage → main
 * promote (PR #2378) with a TypeError inside its loader, on code that had built
 * green earlier that day — and with no network it fails outright. The four
 * families are vendored under `app/fonts` and loaded with `next/font/local`;
 * this pins that shape:
 *
 *   1. nothing under `src/` imports `next/font/google` or points at Google's
 *      font hosts;
 *   2. every font file `layout.tsx` names exists (a wrong path only fails
 *      `next build`, after the slow compile);
 *   3. every vendored family ships its SIL OFL text — the license requires it
 *      to travel with the font files (see `app/fonts/README.md`).
 *
 * Paths come from `helpers/test-paths.ts` (WARP-2632), never from the cwd.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { packagePath, readPackageFile } from "./helpers/test-paths";

const SRC = packagePath("src");
const FONTS = packagePath("src/app/fonts");

// An import of the google loader (any of from/import()/require), or a URL on
// Google's font hosts. Prose that merely names them, like the comment in
// layout.tsx explaining why they are gone, is not a dependency.
const GOOGLE_FONTS =
  /(?:from|import|require)\s*\(?\s*["']@?next\/font\/google["']|(?:https?:)?\/\/fonts\.(?:googleapis|gstatic)\.com/;

/** Every script/stylesheet under `dir`, as absolute paths. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(?:[cm]?[jt]sx?|css)$/.test(name) ? [path] : [];
  });
}

describe("dashboard fonts are self-hosted (WARP-3317)", () => {
  it("nothing under src/ depends on Google Fonts", () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => file !== __filename) // this file has to name what it forbids
      .filter((file) => GOOGLE_FONTS.test(readFileSync(file, "utf8")))
      .map((file) => relative(SRC, file).split(sep).join("/"));
    expect(offenders, "these files fetch fonts from Google at build or run time").toEqual([]);
  });

  it("every font file layout.tsx loads exists", () => {
    const layout = readPackageFile("src/app/layout.tsx");
    const named = [...layout.matchAll(/["']\.\/fonts\/([^"']+\.woff2)["']/g)].map((m) => m[1]);
    expect(named.length, "layout.tsx should load its fonts from ./fonts").toBeGreaterThan(0);
    expect(named.filter((file) => !existsSync(join(FONTS, file)))).toEqual([]);
  });

  it("every vendored family ships its SIL Open Font License text", () => {
    const families = new Set(
      readdirSync(FONTS)
        .filter((file) => file.endsWith(".woff2"))
        .map((file) => file.replace(/-latin-.*$/, "")),
    );
    expect(families.size).toBeGreaterThan(0);
    for (const family of families) {
      const license = join(FONTS, `OFL-${family}.txt`);
      expect(existsSync(license), `${family}: no OFL-${family}.txt next to the font files`).toBe(true);
      expect(readFileSync(license, "utf8")).toMatch(/SIL OPEN FONT LICENSE Version 1\.1/i);
    }
  });
});
