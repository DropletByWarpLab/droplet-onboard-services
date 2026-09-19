/**
 * Client-app downloads — the browser-facing half of "get the Droplet app".
 *
 * Two routes, both behind the global `authMiddleware` (mounted with the
 * protected routers in app.ts):
 *
 *   GET /api/app-downloads
 *       The catalog the dashboard's /downloads page renders: every
 *       platform, its version, its assets with sizes + sha256, and how
 *       the catalog's authenticity was established. Never streams bytes.
 *
 *   GET /api/app-downloads/:platform/:asset
 *       The bytes, after the store re-hashes them against the catalog
 *       digest. Refuses on any mismatch.
 *
 * NO ROLE GATE, deliberately. Every authenticated principal — `family`
 * and `guest` included — needs the client app to use the box they were
 * invited to; gating the installer to owner/admin would lock a guest out
 * of the product while still letting them log into the dashboard. This
 * is a READ of an artifact an operator staged onto the box, not a
 * host mutation, so ADR-004's `requireRole("owner","admin")` convention
 * for administrative writes does not apply. The download is still LAN-
 * and-session-bound: nothing here is anonymous.
 *
 * Degraded states are honest rather than fatal. A box with no artifacts
 * staged (`catalog_missing` — every dev box, and any image built before
 * the staging step existed) answers 200 with `available: false` and a
 * reason, so the page can say "no apps are staged on this box" instead
 * of rendering a spinner over a 500. Refusals that mean something IS
 * wrong — a tampered artifact, a broken catalog — are 5xx and loud.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { createLogger } from "../lib/logger.js";
import { APP_PLATFORMS, type AppPlatform } from "../services/app-downloads/catalog.js";
import {
  AppDownloadsStore,
  type AttestationLevel,
  type StoreFailureReason,
} from "../services/app-downloads/store.js";

const logger = createLogger("app-downloads-route");

const platformParam = z.enum(APP_PLATFORMS);

/**
 * Asset names are echoed back into a Content-Disposition header, so they
 * are shape-checked here too — even though the store's catalog lookup is
 * the real gate. Anything with a quote, CR, or LF could split the header;
 * the catalog's own `ASSET_NAME_RE` already forbids those, and this keeps
 * the route independently safe if that ever loosens.
 */
const assetParam = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/);

/**
 * Which failures mean "this box simply has nothing staged" (a normal,
 * reportable state) versus "something is wrong" (an error).
 *
 * `catalog_missing` is the only benign one. Everything else — a catalog
 * that won't parse, a signature that won't verify, an artifact whose
 * bytes changed — is a real fault and must not be smoothed over into an
 * empty page.
 */
function isBenign(reason: StoreFailureReason): boolean {
  return reason === "catalog_missing";
}

/** HTTP status for a store refusal on the BYTES route. */
function statusForFailure(reason: StoreFailureReason): number {
  switch (reason) {
    // The caller asked for something that isn't there.
    case "asset_missing":
    case "catalog_missing":
      return 404;
    // The box is misconfigured or its artifacts are compromised. Not the
    // caller's fault, and explicitly not cacheable as a 404.
    case "digest_mismatch":
    case "size_mismatch":
    case "signature_failed":
    case "signature_missing":
    case "asset_unreadable":
    case "asset_too_large":
    case "catalog_unreadable":
    case "malformed_catalog":
    case "schema_invalid":
    case "schema_downgrade":
    case "schema_unsupported":
      return 503;
    default:
      return 503;
  }
}

export interface AppDownloadsRouterOptions {
  /** Injected in tests. Production builds one from `config`. */
  store?: AppDownloadsStore;
}

export function createAppDownloadsRouter(
  opts: AppDownloadsRouterOptions = {},
): Router {
  const router = Router();
  const store =
    opts.store ??
    new AppDownloadsStore({
      dir: config.DROPLET_APP_DOWNLOADS_DIR,
      requireSignature: config.DROPLET_APP_DOWNLOADS_REQUIRE_SIGNATURE,
    });

  /**
   * The catalog the page renders.
   *
   * Shape is stable whether or not anything is staged: `available` tells
   * the UI which branch to render, `platforms` is `[]` when nothing is.
   */
  router.get("/app-downloads", async (_req: Request, res: Response) => {
    const loaded = await store.loadCatalog();

    if (!loaded.ok) {
      if (isBenign(loaded.failureReason)) {
        res.json({
          available: false,
          reason: loaded.failureReason,
          detail: loaded.detail,
          attestation: null,
          platforms: [],
        });
        return;
      }
      logger.error(
        { failureReason: loaded.failureReason, detail: loaded.detail },
        "app-download catalog unavailable",
      );
      res.status(503).json({
        available: false,
        reason: loaded.failureReason,
        detail: loaded.detail,
        attestation: null,
        platforms: [],
      });
      return;
    }

    const attestation: AttestationLevel = loaded.attestation;
    res.json({
      available: true,
      reason: null,
      detail: null,
      // Reported so the page can only claim what was actually verified:
      // "signed" ONLY when a cosign signature over the catalog was
      // checked against a real anchor; "digest-only" otherwise (the
      // default, and still a real integrity guarantee at serve time).
      attestation,
      generatedAt: loaded.catalog.generatedAt ?? null,
      platforms: loaded.catalog.platforms.map((entry) => ({
        platform: entry.platform,
        version: entry.version,
        primary: entry.primary ?? null,
        storeUrl: entry.storeUrl ?? null,
        note: entry.note ?? null,
        minOsVersion: entry.minOsVersion ?? null,
        releasedAt: entry.releasedAt ?? null,
        assets: entry.assets.map((asset) => ({
          name: asset.name,
          kind: asset.kind,
          size: asset.size,
          // Surfaced so a customer can verify the file they downloaded
          // by hand. This is the whole point of pinning it.
          sha256: asset.sha256,
          signs: asset.signs ?? null,
          signatureAlgorithm: asset.signatureAlgorithm ?? null,
          url: `/api/app-downloads/${entry.platform}/${encodeURIComponent(asset.name)}`,
        })),
      })),
    });
  });

  /**
   * The bytes. Every refusal path returns BEFORE any byte is written, so
   * a failed digest check can never surface as a truncated download.
   */
  router.get(
    "/app-downloads/:platform/:asset",
    async (req: Request, res: Response) => {
      const platform = platformParam.safeParse(req.params.platform);
      if (!platform.success) {
        res.status(404).json({ error: "unknown platform" });
        return;
      }
      const asset = assetParam.safeParse(req.params.asset);
      if (!asset.success) {
        res.status(404).json({ error: "unknown asset" });
        return;
      }

      const opened = await store.openAsset(
        platform.data as AppPlatform,
        asset.data,
      );

      if (!opened.ok) {
        const status = statusForFailure(opened.failureReason);
        // A digest mismatch is the one worth paging on: an artifact on a
        // read-only mount is no longer what shipped with the image.
        const level = opened.failureReason === "digest_mismatch" ? "error" : "warn";
        logger[level](
          {
            platform: platform.data,
            asset: asset.data,
            failureReason: opened.failureReason,
            detail: opened.detail,
          },
          "app-download refused",
        );
        res
          .status(status)
          .json({ error: opened.failureReason, detail: opened.detail });
        return;
      }

      res.setHeader("Content-Type", opened.contentType);
      res.setHeader("Content-Length", String(opened.size));
      // `attachment` so an installer downloads instead of being rendered
      // or sniffed. The filename comes from the CATALOG entry, not the
      // request, so it cannot carry caller-controlled header bytes.
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${opened.asset.name}"`,
      );
      // The bytes are immutable for the life of the image, but a stale
      // cached copy would defeat the point of re-verifying on each hit.
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      // The digest we just confirmed, so a client can check the file it
      // received without a second round trip.
      res.setHeader("X-Droplet-Asset-Sha256", opened.asset.sha256);

      opened.stream.on("error", (err) => {
        logger.error(
          { platform: platform.data, asset: asset.data, err: String(err) },
          "app-download stream failed mid-flight",
        );
        // Headers are already out; destroying is the only honest signal
        // that the body is incomplete.
        res.destroy(err);
      });
      opened.stream.pipe(res);
    },
  );

  return router;
}
