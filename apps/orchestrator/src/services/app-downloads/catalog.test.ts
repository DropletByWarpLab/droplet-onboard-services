/**
 * App-download catalog parsing.
 *
 * The parser is the only thing standing between a malformed or
 * downgraded catalog and a download button, so every refusal below is
 * asserted by its canonical `failureReason` — those strings are the
 * contract the route and the dashboard copy key off.
 */
import { describe, it, expect } from "vitest";
import {
  SUPPORTED_CATALOG_SCHEMA_VERSION,
  assetByName,
  parseAppCatalog,
  platformEntry,
} from "./catalog.js";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

/** A minimal, valid catalog. Tests mutate clones of this so each case
 *  differs from a passing baseline by exactly one thing. */
function validCatalog() {
  return {
    schemaVersion: SUPPORTED_CATALOG_SCHEMA_VERSION,
    generatedAt: "2026-08-13T10:00:00.000Z",
    platforms: [
      {
        platform: "windows",
        version: "0.2.0",
        primary: "Droplet_0.2.0_x64-setup.exe",
        assets: [
          {
            name: "Droplet_0.2.0_x64-setup.exe",
            kind: "installer",
            size: 217505079,
            sha256: DIGEST_A,
          },
          {
            name: "Droplet_0.2.0_x64-setup.exe.sig",
            kind: "signature",
            size: 200,
            sha256: DIGEST_B,
            signs: "Droplet_0.2.0_x64-setup.exe",
            signatureAlgorithm: "minisign-ed25519",
          },
        ],
      },
    ],
  };
}

const json = (v: unknown) => JSON.stringify(v);

describe("parseAppCatalog — the happy path", () => {
  it("accepts a well-formed catalog and preserves its assets", () => {
    const result = parseAppCatalog(json(validCatalog()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const win = platformEntry(result.catalog, "windows");
    expect(win?.version).toBe("0.2.0");
    expect(win?.assets).toHaveLength(2);
    expect(assetByName(win!, "Droplet_0.2.0_x64-setup.exe")?.kind).toBe(
      "installer",
    );
  });

  it("accepts a Buffer as readily as a string (the store passes bytes)", () => {
    const result = parseAppCatalog(Buffer.from(json(validCatalog()), "utf8"));
    expect(result.ok).toBe(true);
  });

  it("accepts a store-distributed platform that stages no assets", () => {
    const catalog = validCatalog();
    catalog.platforms.push({
      platform: "android",
      version: "1.0.0",
      storeUrl: "https://play.google.com/store/apps/details?id=ai.warplab.droplet",
      assets: [],
    } as never);

    const result = parseAppCatalog(json(catalog));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(platformEntry(result.catalog, "android")?.assets).toEqual([]);
  });
});

describe("parseAppCatalog — refusals", () => {
  it("refuses bytes that are not JSON at all", () => {
    const result = parseAppCatalog("<html>404</html>");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failureReason).toBe("malformed_catalog");
  });

  it("refuses a schemaVersion below ours as a downgrade", () => {
    const catalog = { ...validCatalog(), schemaVersion: 0 };
    const result = parseAppCatalog(json(catalog));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failureReason).toBe("schema_downgrade");
  });

  it("refuses a schemaVersion above ours rather than guessing", () => {
    const catalog = {
      ...validCatalog(),
      schemaVersion: SUPPORTED_CATALOG_SCHEMA_VERSION + 1,
    };
    const result = parseAppCatalog(json(catalog));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failureReason).toBe("schema_unsupported");
  });

  it("refuses a digest that is not 64 lowercase hex", () => {
    const catalog = validCatalog();
    catalog.platforms[0].assets[0].sha256 = "NOT-A-DIGEST";
    const result = parseAppCatalog(json(catalog));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failureReason).toBe("schema_invalid");
  });

  it("refuses an UPPERCASE digest — the store compares lowercase hex", () => {
    const catalog = validCatalog();
    catalog.platforms[0].assets[0].sha256 = DIGEST_A.toUpperCase();
    const result = parseAppCatalog(json(catalog));
    expect(result.ok).toBe(false);
  });

  it("refuses a `primary` that names no asset — that is a 404 button", () => {
    const catalog = validCatalog();
    catalog.platforms[0].primary = "does-not-exist.exe";
    const result = parseAppCatalog(json(catalog));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failureReason).toBe("schema_invalid");
    expect(result.detail).toContain("names no asset");
  });

  it("refuses a `primary` pointing at a manifest — that would hand over JSON", () => {
    const catalog = validCatalog();
    catalog.platforms[0].assets.push({
      name: "latest.json",
      kind: "manifest",
      size: 400,
      sha256: DIGEST_B,
    } as never);
    catalog.platforms[0].primary = "latest.json";

    const result = parseAppCatalog(json(catalog));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain('expected "installer"');
  });

  it("refuses a signature that signs an asset which is not present", () => {
    const catalog = validCatalog();
    catalog.platforms[0].assets[1].signs = "some-other-installer.exe";
    const result = parseAppCatalog(json(catalog));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain("which is not in platform");
  });

  it("refuses duplicate asset names — lookup would be ambiguous", () => {
    const catalog = validCatalog();
    catalog.platforms[0].assets.push({
      ...catalog.platforms[0].assets[0],
      size: 1,
    });
    const result = parseAppCatalog(json(catalog));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain("duplicate asset name");
  });

  it("refuses duplicate platform entries", () => {
    const catalog = validCatalog();
    catalog.platforms.push(structuredClone(catalog.platforms[0]));
    const result = parseAppCatalog(json(catalog));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain("duplicate platform");
  });

  it("refuses an unknown platform rather than carrying it through", () => {
    const catalog = validCatalog();
    catalog.platforms[0].platform = "solaris" as never;
    const result = parseAppCatalog(json(catalog));
    expect(result.ok).toBe(false);
  });

  it("refuses unknown top-level keys (strict) so typos cannot pass silently", () => {
    const catalog = { ...validCatalog(), platfroms: [] };
    const result = parseAppCatalog(json(catalog));
    expect(result.ok).toBe(false);
  });
});

describe("parseAppCatalog — asset names cannot describe a path", () => {
  // The store never joins a caller string into a path, so this is defence
  // in depth. It still matters: it means a TAMPERED CATALOG cannot point
  // an asset at something outside its platform directory either.
  it.each([
    "../../etc/passwd",
    "windows/nested.exe",
    "..",
    "./relative.exe",
    "back\\slash.exe",
    "",
  ])("refuses the asset name %j", (name) => {
    const catalog = validCatalog();
    catalog.platforms[0].assets[0].name = name;
    catalog.platforms[0].primary = name;

    const result = parseAppCatalog(json(catalog));
    expect(result.ok).toBe(false);
  });
});

describe("assetByName", () => {
  it("matches only on an exact name", () => {
    const result = parseAppCatalog(json(validCatalog()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const win = platformEntry(result.catalog, "windows")!;

    expect(assetByName(win, "Droplet_0.2.0_x64-setup.exe")).not.toBeNull();
    // No prefix, suffix, or case-insensitive matching — an approximate
    // match here would be a way to reach an asset the catalog didn't name.
    expect(assetByName(win, "Droplet_0.2.0_x64-setup")).toBeNull();
    expect(assetByName(win, "droplet_0.2.0_x64-setup.exe")).toBeNull();
  });

  it("returns null for a platform the catalog omits", () => {
    const result = parseAppCatalog(json(validCatalog()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(platformEntry(result.catalog, "linux")).toBeNull();
  });
});
