/**
 * WARP-2899 (ADR-056 slice L, AC3a) — the REST profile registry is compiled
 * code and nothing else.
 *
 * A workshop run on the box can DRAFT a profile into the git store (the
 * `rest-profile` template). The draft reaches a customer only through a Warp
 * Lab PR that adds a file under src/rest/vendors/ and registers it here. So
 * the registry must have no second door:
 *
 *   - profiles.ts imports only ./profile.js and ./vendors/<id>.js — no
 *     filesystem, no network, no require, no dynamic import;
 *   - REST_VENDOR_PROFILES is exactly the vendor files on disk, one each — a
 *     profile cannot be registered from anywhere but a vendor file, and a
 *     vendor file cannot sit unregistered;
 *   - nothing under src/rest/ names the sandbox, the workspace store or the
 *     /git/ transport.
 *
 * The orchestrator half (the `lookupRestProfile` seam, the images, the
 * volumes) is apps/orchestrator/src/__tests__/connector-draft.no-runtime-path.test.ts.
 *
 * Mutations (each turns this red): `import { readFileSync } from "node:fs"` in
 * profiles.ts; a vendor file added without registering it; a registered
 * profile imported from outside vendors/; a bare `import "../workspace-…"` in
 * a src/rest file.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { packagePath, readPackageFile } from "./helpers/test-paths.js";
import { REST_VENDOR_PROFILES } from "../src/rest/profiles.js";

const PROFILES = readPackageFile("src", "rest", "profiles.ts");
const VENDORS_DIR = packagePath("src", "rest", "vendors");
const vendorFiles = readdirSync(VENDORS_DIR)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => f.replace(/\.ts$/, ""))
  .sort();

/** Code only: comments are prose and may name anything. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Every module specifier: `from "x"`, a bare `import "x"`, `import("x")`. */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe("the REST profile registry has no store-backed path", () => {
  it("profiles.ts imports only ./profile.js and ./vendors/<id>.js", () => {
    const specifiers = [...code(PROFILES).matchAll(SPECIFIER)].map((m) => m[1]!);
    expect(specifiers.length).toBeGreaterThan(1);
    for (const s of specifiers) {
      expect(s === "./profile.js" || /^\.\/vendors\/[a-z0-9-]+\.js$/.test(s), s).toBe(true);
    }
  });

  it("profiles.ts touches no filesystem, network, require or dynamic import", () => {
    const body = code(PROFILES);
    for (const token of ["node:fs", '"fs"', "'fs'", "fetch(", "require(", "import(", "readFile", "process.env"]) {
      expect(body.includes(token), token).toBe(false);
    }
  });

  it("REST_VENDOR_PROFILES is exactly the vendor files, each registered from its own file", () => {
    const listed = /REST_VENDOR_PROFILES[^=]*=\s*\[([\s\S]*?)\];/.exec(code(PROFILES))?.[1] ?? "";
    const ids = listed.split(",").map((s) => s.trim()).filter(Boolean).sort();
    expect(ids).toEqual(vendorFiles.map((f) => `${f.toUpperCase().replace(/-/g, "_")}_PROFILE`).sort());
    for (const f of vendorFiles) {
      const up = f.toUpperCase().replace(/-/g, "_");
      expect(code(PROFILES), f).toMatch(new RegExp(`import \\{[^}]*\\b${up}_PROFILE\\b[^}]*\\} from "\\./vendors/${f}\\.js"`));
    }
    // The runtime table agrees with the text: one profile per vendor file.
    expect(REST_VENDOR_PROFILES.map((p) => p.provider).sort()).toEqual(vendorFiles);
  });

  it("nothing under src/rest names the sandbox, the workspace store or the git transport", () => {
    const files = walk(packagePath("src", "rest"));
    expect(files.length).toBeGreaterThan(vendorFiles.length);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const needle of ["SANDBOX_URL", "workspace.service", "connector-draft", "extensions/templates", "/git/"]) {
        expect(text.includes(needle), `${file}: ${needle}`).toBe(false);
      }
      // AC3(b): the code names no sandbox and no workspace, in any case — an
      // import, a WORKSPACE_GIT_DIR read or a `sandbox` host alike.
      expect(/sandbox|workspace/i.exec(code(text))?.[0], file).toBeUndefined();
      for (const m of code(text).matchAll(SPECIFIER)) {
        expect(/sandbox|workspace/i.test(m[1]!), `${file} imports ${m[1]}`).toBe(false);
      }
    }
  });
});
