/**
 * WARP-2900 (ADR-056 slice H1): who may ask the box to sign an extension,
 * and who may not know about the box extension key at all.
 *
 * A file-text gate in the tool-scope-claim-trust.guard idiom: no DB, no
 * fixtures, default lane.
 *
 * ## Rule 1: one signer caller
 *
 * `signExtensionManifest` is the box vouching for code. Exactly one product
 * module may call it: services/extension-promotion.service.ts, which parses
 * the manifest, builds the canonical statement, checks provisioning and
 * re-verifies the signature before anything is stored. The client that
 * defines the method and the generated gRPC stub are the only other product
 * files allowed to contain the name. Scanned: every product .ts/.tsx under
 * apps/*\/src and packages/*\/src.
 *
 * ## Rule 2: the OTA release paths stay release-key-only
 *
 * The release verifier (verify.ts), the OTA poller and the app-downloads
 * catalog must never import the extension verifier or touch the box
 * extension key. The cryptographic half of this rule is
 * update-agent/release-paths-stay-release-only.test.ts.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { PACKAGE_ROOT, REPO_ROOT } from "./helpers/test-paths.js";

const SIGNER_ALLOWED = [
  "apps/orchestrator/src/services/extension-promotion.service.ts",
  // The definition, and the generated stub it wraps.
  "apps/orchestrator/src/services/device-identity.client.ts",
  "apps/orchestrator/src/grpc-generated/device_identity.ts",
];

const SKIP_DIRS = new Set(["node_modules", "dist", ".next", "coverage", "__tests__", "__fixtures__"]);

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

function productSources(): string[] {
  const roots: string[] = [];
  for (const group of ["apps", "packages"]) {
    for (const ws of readdirSync(path.join(REPO_ROOT, group))) {
      roots.push(path.join(REPO_ROOT, group, ws, "src"));
    }
  }
  return roots.flatMap((r) => walk(r));
}

const rel = (p: string): string => path.relative(REPO_ROOT, p).split(path.sep).join("/");

describe("WARP-2900 — the box extension signer has one caller", () => {
  const sources = productSources();

  it("scans a real tree (not vacuous)", () => {
    expect(sources.length).toBeGreaterThan(200);
    expect(sources.map(rel)).toContain("apps/orchestrator/src/services/extension-promotion.service.ts");
  });

  it("only the enumerated files mention signExtensionManifest", () => {
    const users = sources
      .filter((p) => readFileSync(p, "utf8").includes("signExtensionManifest"))
      .map(rel)
      .sort();
    expect(
      users,
      "a new module reaches the box extension signer. Promotion is the one " +
        "place that decides what the box vouches for: route the new caller " +
        "through services/extension-promotion.service.ts instead.",
    ).toEqual([...SIGNER_ALLOWED].sort());
  });

  it("the promotion service actually calls it (the allowlist is not stale)", () => {
    const svc = readFileSync(
      path.join(PACKAGE_ROOT, "src", "services", "extension-promotion.service.ts"),
      "utf8",
    );
    expect(svc).toMatch(/identity\.signExtensionManifest\(/);
  });
});

describe("WARP-2900 — the OTA release paths do not know the box extension key", () => {
  const RELEASE_PATHS = [
    "src/services/update-agent/verify.ts",
    "src/services/update-agent/poller.ts",
    "src/services/app-downloads/store.ts",
  ];
  const FORBIDDEN = [
    "extension-verify",
    "verifyExtensionStatement",
    "EXTENSION_STATEMENT_PREFIX",
    "getExtensionPublicKey",
    "signExtensionManifest",
    "extensionSpki",
    "boxKey",
  ];

  it.each(RELEASE_PATHS)("%s references nothing from the extension trust path", (file) => {
    const text = readFileSync(path.join(PACKAGE_ROOT, file), "utf8");
    for (const needle of FORBIDDEN) {
      expect(text.includes(needle), `${file} mentions ${needle}`).toBe(false);
    }
  });

  it("verifyReleaseSignature still takes exactly one trust anchor", () => {
    const verify = readFileSync(path.join(PACKAGE_ROOT, "src/services/update-agent/verify.ts"), "utf8");
    const iface = /export interface VerifyReleaseOptions \{([\s\S]*?)\n\}/.exec(verify);
    expect(iface).not.toBeNull();
    const fields = [...iface![1].matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]).sort();
    expect(fields).toEqual(["cosignBin", "manifestPath", "publicKeyPath", "signaturePath"]);
  });
});
