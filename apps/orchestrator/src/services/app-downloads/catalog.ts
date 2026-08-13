/**
 * Client-app download catalog — parsing + schema validation.
 *
 * The box ships the Droplet client apps (Windows installer, Android APK,
 * iOS build) *inside the appliance image*, staged under
 * `DROPLET_APP_DOWNLOADS_DIR` alongside a `catalog.json` that names every
 * asset and pins its sha256. This module is the parser half of that
 * contract: pure, no I/O, no process state — it turns untrusted bytes
 * into a typed `AppCatalog` or an exact `failureReason`.
 *
 * The generator half is `scripts/app-downloads/gen-catalog.mjs`; the two
 * are one contract and change together.
 *
 * WHY A DIGEST AND NOT A SIGNATURE (read before "hardening" this):
 * the artifacts are baked into the appliance image, so the image IS the
 * trust root — they are not fetched from anywhere at runtime. What the
 * box still owes the customer is proof that the bytes it hands over are
 * the bytes that shipped, so `store.ts` re-hashes every asset against the
 * digest pinned here and refuses to serve on mismatch. That gate is real
 * and it works today.
 *
 * A cosign signature over the catalog is supported on top of that
 * (`store.ts`, `requireSignature`), but it is deliberately NOT the load-
 * bearing gate: the OTA trust anchor is still the WARP-535 placeholder
 * (`update-agent/verify.ts` → `trust_anchor_placeholder`), so making
 * signature verification mandatory today would fail-closed on every
 * download and ship a surface that can never serve a byte.
 *
 * The Windows bundle's own minisign `.sig` + `latest.json` (the Tauri
 * updater envelope, key `F5E6E366DCF9B85E`) ride along as opaque
 * passenger assets — declared here, served verbatim, never verified by
 * the box. Ed25519 is forbidden on-box by
 * `docs/security/fips-allowed-algorithms.md` without a registered
 * exception, and the box has no reason to hold that opinion: the
 * signature exists for the *client's* updater and for a customer who
 * wants to check the download independently.
 */
import { z } from "zod";

/** Bump when the catalog format itself changes shape. */
export const SUPPORTED_CATALOG_SCHEMA_VERSION = 1;

/** Platforms the download surface knows how to talk about. */
export const APP_PLATFORMS = [
  "windows",
  "macos",
  "linux",
  "android",
  "ios",
] as const;
export type AppPlatform = (typeof APP_PLATFORMS)[number];

/**
 * What an asset IS, which decides how the UI offers it.
 *
 * - `installer` — the thing a human runs. Exactly one per platform is
 *   marked `primary` and becomes the page's main button.
 * - `signature`  — a detached signature over a sibling installer (the
 *   Tauri minisign `.sig`). Offered as a secondary "verify this
 *   download" link, never as the primary action.
 * - `manifest`   — updater metadata (`latest.json`). Served so the
 *   installed client can self-update against the box instead of a
 *   cloud endpoint; not surfaced as a human download.
 */
export const ASSET_KINDS = ["installer", "signature", "manifest"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

/** Every way catalog parsing can refuse. Canonical — tests assert these
 *  verbatim and they surface in the `/api/app-downloads` degraded body. */
export type CatalogFailureReason =
  | "malformed_catalog"
  | "schema_invalid"
  | "schema_downgrade"
  | "schema_unsupported";

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/**
 * Asset filenames are constrained to a flat, boring alphabet and — the
 * load-bearing part — may contain NO path separators and no `..`.
 *
 * `store.ts` never joins a caller-supplied string into a filesystem
 * path (it looks assets up by exact name in the parsed catalog), so this
 * is defence in depth rather than the only traversal gate. It still
 * matters: it means a *malicious catalog baked into a tampered image*
 * cannot point an asset at `../../etc/shadow` either.
 */
const ASSET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

const assetSchema = z
  .object({
    /** Basename as served and as written to disk. No directories. */
    name: z
      .string()
      .min(1)
      .max(255)
      .regex(ASSET_NAME_RE, "asset name must be a bare filename"),
    kind: z.enum(ASSET_KINDS),
    /** Bytes on disk. Cross-checked against the real file by store.ts. */
    size: z.number().int().nonnegative(),
    /** Lowercase hex sha256 of the file's bytes. The serve-time gate. */
    sha256: z.string().regex(SHA256_HEX_RE, "sha256 must be 64 lowercase hex"),
    /**
     * MIME type to serve with. Optional — store.ts falls back to
     * `application/octet-stream`, which is the right answer for every
     * installer anyway (it must download, never render).
     */
    contentType: z.string().min(1).max(128).optional(),
    /**
     * For `kind: "signature"`, the installer this signs, and with what.
     * Recorded so the UI can say "minisign signature for X" instead of
     * dangling an unexplained `.sig` link.
     */
    signs: z.string().min(1).max(255).regex(ASSET_NAME_RE).optional(),
    signatureAlgorithm: z.string().min(1).max(64).optional(),
  })
  .strict();

export type AppAsset = z.infer<typeof assetSchema>;

const platformSchema = z
  .object({
    platform: z.enum(APP_PLATFORMS),
    /** Human version string, e.g. "0.2.0". Displayed verbatim. */
    version: z.string().min(1).max(64),
    /**
     * `name` of the asset that is THE download for this platform. Must
     * name an `installer` asset present in `assets` — enforced below,
     * because a catalog whose primary points at nothing would render a
     * button that 404s.
     */
    primary: z.string().min(1).max(255).regex(ASSET_NAME_RE).optional(),
    /**
     * Where this platform actually ships, when that is not the box.
     * Android and iOS are store-distributed; a store URL makes the page
     * honest instead of pretending a sideload is the supported path.
     */
    storeUrl: z.string().url().max(512).optional(),
    /** Shown under the platform when it has no artifact and no store. */
    note: z.string().min(1).max(280).optional(),
    minOsVersion: z.string().min(1).max(64).optional(),
    releasedAt: z.string().datetime().optional(),
    assets: z.array(assetSchema).max(32),
  })
  .strict()
  .superRefine((entry, ctx) => {
    // Duplicate names would make `assetByName` ambiguous and let the
    // wrong bytes answer a request. Refuse the catalog outright.
    const seen = new Set<string>();
    for (const asset of entry.assets) {
      if (seen.has(asset.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate asset name "${asset.name}" in platform ${entry.platform}`,
        });
      }
      seen.add(asset.name);
    }

    // A `primary` that names a missing or non-installer asset is a
    // broken button, so it is a broken catalog.
    if (entry.primary !== undefined) {
      const target = entry.assets.find((a) => a.name === entry.primary);
      if (!target) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `platform ${entry.platform} primary "${entry.primary}" names no asset`,
        });
      } else if (target.kind !== "installer") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `platform ${entry.platform} primary "${entry.primary}" is kind "${target.kind}", expected "installer"`,
        });
      }
    }

    // A signature that signs nothing present is dangling metadata.
    for (const asset of entry.assets) {
      if (asset.kind !== "signature" || asset.signs === undefined) continue;
      if (!entry.assets.some((a) => a.name === asset.signs)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `signature "${asset.name}" signs "${asset.signs}", which is not in platform ${entry.platform}`,
        });
      }
    }
  });

export type AppPlatformEntry = z.infer<typeof platformSchema>;

const catalogSchema = z
  .object({
    schemaVersion: z.number().int(),
    /** When gen-catalog.mjs stamped this, for display + support. */
    generatedAt: z.string().datetime().optional(),
    platforms: z.array(platformSchema).max(APP_PLATFORMS.length),
  })
  .strict()
  .superRefine((catalog, ctx) => {
    const seen = new Set<string>();
    for (const entry of catalog.platforms) {
      if (seen.has(entry.platform)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate platform entry "${entry.platform}"`,
        });
      }
      seen.add(entry.platform);
    }
  });

export type AppCatalog = z.infer<typeof catalogSchema>;

export type ParseCatalogResult =
  | { ok: true; catalog: AppCatalog }
  | { ok: false; failureReason: CatalogFailureReason; detail: string };

/**
 * Parse + validate raw `catalog.json` bytes.
 *
 * Version gates mirror the OTA manifest parser's posture
 * (`update-agent/manifest.ts`), for the same reasons: a schemaVersion
 * BELOW ours is a downgrade we refuse to interpret, and one ABOVE ours
 * describes fields we cannot reason about. Neither is "serve anyway".
 */
export function parseAppCatalog(raw: string | Buffer): ParseCatalogResult {
  let json: unknown;
  try {
    json = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
  } catch (err) {
    return {
      ok: false,
      failureReason: "malformed_catalog",
      detail: err instanceof Error ? err.message : "catalog is not valid JSON",
    };
  }

  // Read schemaVersion before full validation so a downgrade/upgrade
  // reports as such rather than drowning in field-level schema errors
  // for a shape we were never going to accept.
  const declared = (json as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (typeof declared === "number" && Number.isInteger(declared)) {
    if (declared < SUPPORTED_CATALOG_SCHEMA_VERSION) {
      return {
        ok: false,
        failureReason: "schema_downgrade",
        detail: `catalog schemaVersion ${declared} is below supported ${SUPPORTED_CATALOG_SCHEMA_VERSION}`,
      };
    }
    if (declared > SUPPORTED_CATALOG_SCHEMA_VERSION) {
      return {
        ok: false,
        failureReason: "schema_unsupported",
        detail: `catalog schemaVersion ${declared} is above supported ${SUPPORTED_CATALOG_SCHEMA_VERSION}`,
      };
    }
  }

  const parsed = catalogSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      failureReason: "schema_invalid",
      detail: parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; "),
    };
  }

  return { ok: true, catalog: parsed.data };
}

/** Look up one platform's entry. Returns null when absent. */
export function platformEntry(
  catalog: AppCatalog,
  platform: AppPlatform,
): AppPlatformEntry | null {
  return catalog.platforms.find((p) => p.platform === platform) ?? null;
}

/**
 * Look up an asset by EXACT name within a platform.
 *
 * This is the traversal gate that matters: routes resolve a
 * caller-supplied string through here and use the returned catalog
 * entry's own `name` to build the path. A string that is not in the
 * catalog never reaches the filesystem at all.
 */
export function assetByName(
  entry: AppPlatformEntry,
  name: string,
): AppAsset | null {
  return entry.assets.find((a) => a.name === name) ?? null;
}
