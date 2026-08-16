/**
 * GET /api/app-downloads + /api/app-downloads/:platform/:asset.
 *
 * Covers the two things the route decides on its own (the store is
 * tested directly in services/app-downloads/store.test.ts):
 *
 *   1. Which store refusals are a NORMAL empty state (200, `available:
 *      false`) versus a fault (503). Getting this backwards would either
 *      alarm every dev box or hide a tampered artifact behind a friendly
 *      "nothing here".
 *   2. That the byte route sets download-safe headers and never emits a
 *      body on refusal.
 */
import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import express from "express";

// The router reads `config` only to construct its default store; every
// test injects one, so the mock just has to exist and be inert.
vi.mock("../config.js", () => ({
  config: {
    DROPLET_APP_DOWNLOADS_DIR: "/nonexistent",
    DROPLET_APP_DOWNLOADS_REQUIRE_SIGNATURE: false,
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

import { createAppDownloadsRouter } from "./app-downloads.js";
import type { AppDownloadsStore } from "../services/app-downloads/store.js";

const INSTALLER = Buffer.from("MZ fake installer payload");

/** Minimal store double — only what the router actually calls. */
function fakeStore(overrides: Partial<AppDownloadsStore>): AppDownloadsStore {
  return {
    loadCatalog: async () => ({
      ok: false as const,
      failureReason: "catalog_missing" as const,
      detail: "nothing staged",
    }),
    openAsset: async () => ({
      ok: false as const,
      failureReason: "asset_missing" as const,
      detail: "no such asset",
    }),
    platform: async () => null,
    invalidate: () => {},
    ...overrides,
  } as unknown as AppDownloadsStore;
}

function appWith(store: AppDownloadsStore) {
  const app = express();
  app.use("/api", createAppDownloadsRouter({ store }));
  return app;
}

const CATALOG_OK = {
  ok: true as const,
  attestation: "digest-only" as const,
  catalog: {
    schemaVersion: 1,
    generatedAt: "2026-08-13T10:00:00.000Z",
    platforms: [
      {
        platform: "windows" as const,
        version: "0.2.0",
        primary: "Droplet-setup.exe",
        assets: [
          {
            name: "Droplet-setup.exe",
            kind: "installer" as const,
            size: INSTALLER.length,
            sha256: "a".repeat(64),
          },
        ],
      },
    ],
  },
};

describe("GET /api/app-downloads", () => {
  it("returns the catalog with a per-asset download URL", async () => {
    const app = appWith(fakeStore({ loadCatalog: async () => CATALOG_OK }));
    const res = await request(app).get("/api/app-downloads");

    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
    expect(res.body.attestation).toBe("digest-only");
    expect(res.body.platforms[0].assets[0]).toMatchObject({
      name: "Droplet-setup.exe",
      sha256: "a".repeat(64),
      url: "/api/app-downloads/windows/Droplet-setup.exe",
    });
  });

  it("answers 200 available:false when the box simply has nothing staged", async () => {
    // The dev-box steady state. It must not read as an error, or every
    // developer sees a red surface for a correct configuration.
    const app = appWith(fakeStore({}));
    const res = await request(app).get("/api/app-downloads");

    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
    expect(res.body.reason).toBe("catalog_missing");
    expect(res.body.platforms).toEqual([]);
  });

  it.each([
    "malformed_catalog",
    "schema_invalid",
    "schema_downgrade",
    "schema_unsupported",
    "signature_failed",
    "signature_missing",
    "catalog_unreadable",
  ] as const)("answers 503 for the real fault %s", async (failureReason) => {
    const app = appWith(
      fakeStore({
        loadCatalog: async () => ({
          ok: false as const,
          failureReason,
          detail: "broken",
        }),
      }),
    );
    const res = await request(app).get("/api/app-downloads");

    // A broken or untrusted catalog is NOT the same as an empty box, and
    // must not be smoothed into one.
    expect(res.status).toBe(503);
    expect(res.body.available).toBe(false);
    expect(res.body.reason).toBe(failureReason);
  });

  it("never reports an attestation it did not establish", async () => {
    const app = appWith(fakeStore({}));
    const res = await request(app).get("/api/app-downloads");
    expect(res.body.attestation).toBeNull();
  });
});

describe("GET /api/app-downloads/:platform/:asset", () => {
  function streamingStore() {
    return fakeStore({
      loadCatalog: async () => CATALOG_OK,
      openAsset: async () => {
        const { Readable } = await import("node:stream");
        return {
          ok: true as const,
          stream: Readable.from([INSTALLER]) as never,
          asset: {
            name: "Droplet-setup.exe",
            kind: "installer" as const,
            size: INSTALLER.length,
            sha256: "a".repeat(64),
          },
          size: INSTALLER.length,
          contentType: "application/vnd.microsoft.portable-executable",
        };
      },
    });
  }

  it("streams the bytes with download-safe headers", async () => {
    const res = await request(appWith(streamingStore()))
      .get("/api/app-downloads/windows/Droplet-setup.exe")
      // superagent has no parser for an installer content-type and would
      // hand back `{}`; `blob` makes it buffer the raw bytes so the body
      // assertion below is actually comparing what was served.
      .responseType("blob");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(INSTALLER);
    expect(res.headers["content-type"]).toContain(
      "application/vnd.microsoft.portable-executable",
    );
    // `attachment` so an installer downloads rather than being rendered
    // or content-sniffed.
    expect(res.headers["content-disposition"]).toBe(
      'attachment; filename="Droplet-setup.exe"',
    );
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["cache-control"]).toBe("no-store");
    // The digest we just confirmed, so a client can re-check locally.
    expect(res.headers["x-droplet-asset-sha256"]).toBe("a".repeat(64));
  });

  it("404s an unknown platform without consulting the store", async () => {
    const openAsset = vi.fn();
    const app = appWith(fakeStore({ openAsset: openAsset as never }));

    const res = await request(app).get("/api/app-downloads/solaris/anything.exe");

    expect(res.status).toBe(404);
    expect(openAsset).not.toHaveBeenCalled();
  });

  it("404s an asset name with path characters before the store is asked", async () => {
    const openAsset = vi.fn();
    const app = appWith(fakeStore({ openAsset: openAsset as never }));

    // Encoded traversal — Express decodes the param, so the route's own
    // shape check is what stops it here.
    const res = await request(app).get(
      "/api/app-downloads/windows/..%2F..%2Fcatalog.json",
    );

    expect(res.status).toBe(404);
    expect(openAsset).not.toHaveBeenCalled();
  });

  it("503s a digest mismatch and sends NO bytes", async () => {
    const app = appWith(
      fakeStore({
        loadCatalog: async () => CATALOG_OK,
        openAsset: async () => ({
          ok: false as const,
          failureReason: "digest_mismatch" as const,
          detail: "does not match its catalog digest",
        }),
      }),
    );

    const res = await request(app).get(
      "/api/app-downloads/windows/Droplet-setup.exe",
    );

    // A tampered artifact is a fault, not a missing file: 503, never 404,
    // and never a partial body.
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("digest_mismatch");
    expect(res.headers["content-disposition"]).toBeUndefined();
  });

  it("404s an asset the catalog does not name", async () => {
    const app = appWith(fakeStore({ loadCatalog: async () => CATALOG_OK }));
    const res = await request(app).get(
      "/api/app-downloads/windows/not-in-catalog.exe",
    );
    expect(res.status).toBe(404);
  });
});
