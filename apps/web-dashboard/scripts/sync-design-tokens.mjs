#!/usr/bin/env node
/**
 * WARP-1277 — refresh the vendored design-token lock from the canon.
 *
 * Clones DropletByWarpLab/design-and-style (depth 1) and copies
 * dist/json/web-lock.json over src/lib/design-tokens.lock.json. Dev-side
 * only (needs GitHub org access); CI never runs this — it tests against the
 * vendored copy.
 *
 *   npm run tokens:sync
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEST = resolve(HERE, "..", "src", "lib", "design-tokens.lock.json");
const REPO = "https://github.com/DropletByWarpLab/design-and-style.git";

const tmp = mkdtempSync(join(tmpdir(), "design-and-style-"));
try {
  execFileSync("git", ["clone", "--depth", "1", REPO, tmp], { stdio: "inherit" });
  copyFileSync(join(tmp, "dist", "json", "web-lock.json"), DEST);
  console.log(`updated ${DEST}`);
  console.log("re-run `npm test` — if the gate now fails, globals.css needs the matching update.");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
