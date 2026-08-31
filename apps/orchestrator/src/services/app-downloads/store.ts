/**
 * Client-app download store — the disk half of the download surface.
 *
 * Owns everything the parser (`catalog.ts`) deliberately does not: where
 * the baked-in artifacts live, whether the bytes on disk still match the
 * digests the catalog pinned, and handing an open read stream to the
 * route.
 *
 * ── Trust posture ────────────────────────────────────────────────────
 * Two gates, and it matters which one is load-bearing:
 *
 *   1. DIGEST (always on, fail-closed, the real gate). Before a single
 *      byte is served, the file is streamed through sha256 and compared
 *      to the catalog's pin. Mismatch, wrong size, or unreadable file →
 *      refusal, never a partial or "probably fine" download. This is
 *      what makes the surface honest: an operator staged these artifacts
 *      onto the box and the catalog pinned them at that moment, so the
 *      stage is the trust root, and the box's remaining job is proving
 *      the bytes it hands over are the bytes that were staged.
 *
 *   2. COSIGN over catalog.json (opt-in, off by default). Enforced only
 *      when `requireSignature` is set — which `config.ts` derives from
 *      DROPLET_APP_DOWNLOADS_REQUIRE_SIGNATURE. It is off by default on
 *      purpose: the OTA trust anchor is still the WARP-535 placeholder
 *      (`update-agent/verify.ts` refuses everything with
 *      `trust_anchor_placeholder`), so switching this on before the key
 *      ceremony turns every download into a 503. The flag exists so the
 *      ceremony can flip it without a code change — and so the "signed"
 *      claim in the API is never made unless it was actually checked.
 *
 * The Windows minisign `.sig` and `latest.json` are passengers: declared
 * in the catalog, digest-checked like everything else, served verbatim,
 * and never cryptographically interpreted here. Ed25519 is forbidden
 * on-box without a registered exception (docs/security/
 * fips-allowed-algorithms.md) and the box has no need to hold that
 * opinion — that signature is for the client's own updater and for a
 * customer verifying the download independently.
 *
 * Caching: the catalog is read once and memoised. The mount is read-only
 * from in here, so nothing this process does can change it — but the HOST
 * side is writable and an operator staging an app does change it under a
 * running container. That is a restart, not a bug: `stage.sh` restarts
 * this service for exactly this reason, and a stage without one leaves
 * the new installer on disk and invisible at /downloads. Do not "fix" it
 * by re-reading per request — the invalidation point is a deliberate
 * operator action, and per-request reads would buy nothing but I/O.
 * Digests are re-checked on EVERY download — the whole point is to
 * detect a file that changed after we last looked at it, so caching a
 * verification result would defeat the gate.
 *
 * COST of that choice, measured rather than assumed: verifying the real
 * 217 MB v0.2.0 Windows installer takes ~1.3 s before the first byte
 * goes out. That is paid per download, and a download happens once per
 * device, so it is the right trade against the alternative (memoising on
 * mtime+size, which stops detecting exactly the tampering the gate is
 * for). If a future artifact makes this painful, cache on
 * (ino, size, mtimeMs) — do NOT simply drop the check.
 */
import { createHash } from "node:crypto";
import { createReadStream, type ReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createLogger } from "../../lib/logger.js";
import { verifyReleaseSignature } from "../update-agent/verify.js";
import {
  assetByName,
  parseAppCatalog,
  platformEntry,
  type AppAsset,
  type AppCatalog,
  type AppPlatform,
  type AppPlatformEntry,
  type CatalogFailureReason,
} from "./catalog.js";

const logger = createLogger("app-downloads");

export const CATALOG_FILENAME = "catalog.json";
export const CATALOG_SIGNATURE_FILENAME = "catalog.json.sig";

/** Fallback when the catalog declares no contentType. Installers must
 *  download rather than render, so octet-stream is the right default. */
const DEFAULT_CONTENT_TYPE = "application/octet-stream";

/**
 * Ceiling on what we will hash and serve. A baked-in installer is tens
 * of MB; anything past this is a staging mistake, and hashing it would
 * pin a CPU for no good reason.
 */
export const MAX_ASSET_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

/** Everything that can go wrong between "route asked" and "bytes out". */
export type StoreFailureReason =
  | CatalogFailureReason
  | "catalog_missing"
  | "catalog_unreadable"
  | "signature_missing"
  | "signature_failed"
  | "asset_missing"
  | "asset_unreadable"
  | "asset_too_large"
  | "digest_mismatch"
  | "size_mismatch";

/** How the catalog's authenticity was established, reported to the UI so
 *  the page can only claim what was actually checked. */
export type AttestationLevel = "signed" | "digest-only";

export interface AppDownloadsOptions {
  /** Staging root, bind-mounted read-only. An operator fills it with
   *  scripts/app-downloads/stage.sh; the image does not. */
  dir: string;
  /** Enforce the cosign signature over catalog.json. Default false. */
  requireSignature?: boolean;
  /** Trust anchor override. Defaults to the OTA anchor resolution. */
  publicKeyPath?: string;
  /** cosign binary override, for tests. */
  cosignBin?: string;
}

export type LoadCatalogResult =
  | { ok: true; catalog: AppCatalog; attestation: AttestationLevel }
  | { ok: false; failureReason: StoreFailureReason; detail: string };

export type OpenAssetResult =
  | {
      ok: true;
      stream: ReadStream;
      asset: AppAsset;
      size: number;
      contentType: string;
    }
  | { ok: false; failureReason: StoreFailureReason; detail: string };

/**
 * Stream a file through sha256 without ever holding it in memory.
 * Returns the digest and the byte count actually read, so callers can
 * check BOTH — a truncated file with a colliding prefix is not a real
 * threat, but a truncated file is a real bug and size is free to check.
 */
async function hashFile(
  filePath: string,
): Promise<{ sha256: string; bytes: number }> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    let bytes = 0;
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => {
      bytes += chunk.length;
      hash.update(chunk);
    });
    stream.on("error", reject);
    stream.on("end", () =>
      resolve({ sha256: hash.digest("hex"), bytes }),
    );
  });
}

/**
 * The store. One instance per process (see `app-downloads.singleton.ts`),
 * holding only the memoised catalog — no connections, no timers.
 */
export class AppDownloadsStore {
  private readonly dir: string;
  private readonly requireSignature: boolean;
  private readonly publicKeyPath?: string;
  private readonly cosignBin?: string;
  /** Memoised catalog load. The image is read-only; re-reading per
   *  request would be pure overhead. Digests are NOT memoised. */
  private cached: LoadCatalogResult | null = null;

  constructor(opts: AppDownloadsOptions) {
    this.dir = opts.dir;
    this.requireSignature = opts.requireSignature ?? false;
    this.publicKeyPath = opts.publicKeyPath;
    this.cosignBin = opts.cosignBin;
  }

  /** Drop the memoised catalog. Tests use this; production never needs
   *  it, because the staging directory cannot change under a running
   *  container. */
  invalidate(): void {
    this.cached = null;
  }

  /** Absolute path of an asset, built ONLY from a catalog-resolved
   *  entry's own name — never from a caller-supplied string. */
  private assetPath(platform: AppPlatform, asset: AppAsset): string {
    return path.join(this.dir, platform, asset.name);
  }

  async loadCatalog(): Promise<LoadCatalogResult> {
    if (this.cached) return this.cached;
    const result = await this.loadCatalogUncached();
    this.cached = result;
    return result;
  }

  private async loadCatalogUncached(): Promise<LoadCatalogResult> {
    const catalogPath = path.join(this.dir, CATALOG_FILENAME);

    let raw: Buffer;
    try {
      raw = await readFile(catalogPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // A box with no client apps staged is a legitimate state (the
      // artifacts are baked in at image build; a dev box has none), so
      // this is reported, not thrown. The route turns it into an honest
      // "no downloads available" rather than a 500.
      if (code === "ENOENT") {
        return {
          ok: false,
          failureReason: "catalog_missing",
          detail: `no ${CATALOG_FILENAME} at ${catalogPath} — no client apps are staged in this image`,
        };
      }
      return {
        ok: false,
        failureReason: "catalog_unreadable",
        detail: `cannot read ${catalogPath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }

    // Signature BEFORE parse, so we never interpret unauthenticated
    // bytes when the operator asked us not to (the OTA chain's ordering,
    // for the same reason).
    let attestation: AttestationLevel = "digest-only";
    if (this.requireSignature) {
      const sigPath = path.join(this.dir, CATALOG_SIGNATURE_FILENAME);
      try {
        await stat(sigPath);
      } catch {
        return {
          ok: false,
          failureReason: "signature_missing",
          detail: `DROPLET_APP_DOWNLOADS_REQUIRE_SIGNATURE is on but ${CATALOG_SIGNATURE_FILENAME} is absent — refusing to serve unverified artifacts`,
        };
      }
      const verified = await verifyReleaseSignature({
        manifestPath: catalogPath,
        signaturePath: sigPath,
        publicKeyPath: this.publicKeyPath,
        cosignBin: this.cosignBin,
      });
      if (!verified.ok) {
        return {
          ok: false,
          failureReason: "signature_failed",
          detail: `${verified.failureReason}: ${verified.detail}`,
        };
      }
      attestation = "signed";
    }

    const parsed = parseAppCatalog(raw);
    if (!parsed.ok) {
      logger.error(
        { failureReason: parsed.failureReason, detail: parsed.detail },
        "app-download catalog rejected",
      );
      return {
        ok: false,
        failureReason: parsed.failureReason,
        detail: parsed.detail,
      };
    }

    return { ok: true, catalog: parsed.catalog, attestation };
  }

  /** One platform's entry, or null when the catalog omits it. */
  async platform(platform: AppPlatform): Promise<AppPlatformEntry | null> {
    const loaded = await this.loadCatalog();
    if (!loaded.ok) return null;
    return platformEntry(loaded.catalog, platform);
  }

  /**
   * Resolve, verify, and open an asset for streaming.
   *
   * Order is deliberate and each step is a refusal, not a warning:
   *   1. catalog loads (and, if required, verifies)
   *   2. the platform exists in it
   *   3. `name` matches an asset EXACTLY — an unknown string stops here
   *      and never touches the filesystem
   *   4. the file exists, is a regular file, and is not absurdly large
   *   5. its size matches the catalog
   *   6. its sha256 matches the catalog
   * Only then is a read stream opened.
   */
  async openAsset(
    platform: AppPlatform,
    name: string,
  ): Promise<OpenAssetResult> {
    const loaded = await this.loadCatalog();
    if (!loaded.ok) {
      return {
        ok: false,
        failureReason: loaded.failureReason,
        detail: loaded.detail,
      };
    }

    const entry = platformEntry(loaded.catalog, platform);
    if (!entry) {
      return {
        ok: false,
        failureReason: "asset_missing",
        detail: `platform ${platform} is not in the catalog`,
      };
    }

    // The traversal gate. `name` is caller-controlled; it is used ONLY
    // as a lookup key here. The path below is built from the catalog
    // entry's own validated name, so "../../etc/passwd" simply misses.
    const asset = assetByName(entry, name);
    if (!asset) {
      return {
        ok: false,
        failureReason: "asset_missing",
        detail: `no asset named "${name}" for platform ${platform}`,
      };
    }

    const filePath = this.assetPath(platform, asset);

    let stats: Awaited<ReturnType<typeof stat>>;
    try {
      stats = await stat(filePath);
    } catch (err) {
      return {
        ok: false,
        failureReason: "asset_missing",
        detail: `catalog lists ${asset.name} but it is not on disk: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }

    if (!stats.isFile()) {
      return {
        ok: false,
        failureReason: "asset_unreadable",
        detail: `${filePath} is not a regular file`,
      };
    }

    if (stats.size > MAX_ASSET_BYTES) {
      return {
        ok: false,
        failureReason: "asset_too_large",
        detail: `${asset.name} is ${stats.size} bytes, above the ${MAX_ASSET_BYTES}-byte ceiling`,
      };
    }

    if (stats.size !== asset.size) {
      return {
        ok: false,
        failureReason: "size_mismatch",
        detail: `${asset.name} is ${stats.size} bytes on disk, catalog says ${asset.size}`,
      };
    }

    let digest: { sha256: string; bytes: number };
    try {
      digest = await hashFile(filePath);
    } catch (err) {
      return {
        ok: false,
        failureReason: "asset_unreadable",
        detail: `cannot hash ${asset.name}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }

    if (digest.sha256 !== asset.sha256) {
      // The one that actually protects the customer: the bytes on disk
      // are not the bytes that shipped. Loud, and no download.
      logger.error(
        {
          platform,
          asset: asset.name,
          expected: asset.sha256,
          actual: digest.sha256,
        },
        "app-download asset failed its digest check — refusing to serve",
      );
      return {
        ok: false,
        failureReason: "digest_mismatch",
        detail: `${asset.name} does not match its catalog digest — refusing to serve`,
      };
    }

    return {
      ok: true,
      stream: createReadStream(filePath),
      asset,
      size: stats.size,
      contentType: asset.contentType ?? DEFAULT_CONTENT_TYPE,
    };
  }
}
