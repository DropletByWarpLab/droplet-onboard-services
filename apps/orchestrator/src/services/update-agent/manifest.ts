/**
 * WARP-537 — OTA release-manifest parsing + schema validation.
 *
 * Second gate in the OTA trust chain. The composed flow
 * (verify.ts → `verifyAndParseRelease`) checks the cosign signature over
 * the raw bytes FIRST, then hands the same bytes here. This module is
 * pure: no I/O, no process state — it turns untrusted-but-authenticated
 * bytes into a typed `ReleaseManifest` or an exact `failureReason`.
 *
 * The schema is the v1 shape emitted by
 * `scripts/release/gen-release-manifest.py` (WARP-536) — the generator
 * and this parser are the two halves of one contract; change them
 * together.
 *
 * Version gates (both anti-footgun, different directions):
 *   - `schema_downgrade`   — schemaVersion BELOW what we support. A
 *     downgrade attack replays an old-format manifest; refuse outright
 *     (the generator side documents the same rule).
 *   - `schema_unsupported` — schemaVersion ABOVE what we support. We
 *     cannot safely interpret fields we don't know; refuse and wait for
 *     the orchestrator itself to be updated first.
 *   - `orchestrator_schema_unsupported` — the release demands a newer
 *     orchestrator DB schema (`release.minOrchestratorSchema`) than this
 *     build understands; applying it could run migrations we can't
 *     reason about (WARP-539 gates `prisma migrate deploy` on this).
 *
 * failureReason strings are canonical: they land verbatim in
 * `DeviceUpdate.failureReason` and in the `update.*` pino events
 * (WARP-541), so tests assert them exactly.
 */
import { z } from "zod";

/** Bump when the manifest format itself changes shape. */
export const SUPPORTED_SCHEMA_VERSION = 1;
/**
 * Bump when the orchestrator gains schema-relevant behavior releases
 * depend on. Mirrors MIN_ORCHESTRATOR_SCHEMA in
 * scripts/release/gen-release-manifest.py.
 */
export const SUPPORTED_ORCHESTRATOR_SCHEMA = 1;

/**
 * Every way the OTA verify/parse chain can refuse a release. The
 * signature/trust reasons live in verify.ts but share this union so
 * `DeviceUpdate.failureReason` has one canonical vocabulary.
 */
export type UpdateFailureReason =
  | "trust_anchor_placeholder"
  | "cosign_unavailable"
  | "signature_failed"
  | "malformed_manifest"
  | "schema_invalid"
  | "schema_downgrade"
  | "schema_unsupported"
  | "orchestrator_schema_unsupported";

export type ManifestFailureReason = Extract<
  UpdateFailureReason,
  | "malformed_manifest"
  | "schema_invalid"
  | "schema_downgrade"
  | "schema_unsupported"
  | "orchestrator_schema_unsupported"
>;

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const GIT_SHA_RE = /^[0-9a-f]{40}$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/**
 * Post-swap health probe for one service. `http` entries are the
 * service's own auth-exempt liveness endpoint on its container-internal
 * port; `none` means the service has no HTTP surface and is health-gated
 * elsewhere (mirrors scripts/release/services.json).
 */
const healthcheckSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("http"),
    port: z.number().int().min(1).max(65535),
    path: z.string().regex(/^\//, "healthcheck path must start with /"),
  }),
  z.object({ type: z.literal("none") }),
]);

const serviceSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    image: z.string().min(1),
    digest: z.string().regex(DIGEST_RE, "digest must be sha256:<64 hex>"),
    healthcheck: healthcheckSchema,
  })
  .refine((s) => s.image.endsWith(`@${s.digest}`), {
    message: "image must be pinned by its own digest (…@sha256:<64 hex>)",
    path: ["image"],
  });

const manifestSchema = z.object({
  schemaVersion: z.literal(SUPPORTED_SCHEMA_VERSION),
  release: z.object({
    gitSha: z.string().regex(GIT_SHA_RE, "gitSha must be a full 40-hex commit sha"),
    // ISO-8601 UTC as the generator writes it; parsed strictly enough to
    // refuse garbage, kept as a string so re-serialization is lossless.
    builtAt: z
      .string()
      .refine((v) => !Number.isNaN(Date.parse(v)), "builtAt must be an ISO-8601 timestamp"),
    channel: z.string().min(1),
    minOrchestratorSchema: z.number().int().min(1),
  }),
  services: z
    .array(serviceSchema)
    .min(1)
    .refine(
      (svcs) => new Set(svcs.map((s) => s.name)).size === svcs.length,
      "services must have unique names",
    ),
  configs: z.object({
    file: z.string().min(1),
    sha256: z.string().regex(SHA256_HEX_RE, "configs.sha256 must be 64 hex chars"),
  }),
});

export type ReleaseManifest = z.infer<typeof manifestSchema>;
export type ReleaseService = ReleaseManifest["services"][number];
export type ReleaseServiceHealthcheck = ReleaseService["healthcheck"];

export type ManifestParseResult =
  | { ok: true; manifest: ReleaseManifest }
  | { ok: false; failureReason: ManifestFailureReason; detail: string };

/**
 * Parse + schema-validate a `release.json` body. Pure function over the
 * raw bytes; the caller is responsible for having verified the cosign
 * signature over these exact bytes first (verify.ts).
 */
export function parseReleaseManifest(raw: string | Buffer): ManifestParseResult {
  const text = typeof raw === "string" ? raw : raw.toString("utf8");

  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      failureReason: "malformed_manifest",
      detail: `release.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    return {
      ok: false,
      failureReason: "malformed_manifest",
      detail: "release.json must be a JSON object",
    };
  }

  // Version gates BEFORE full shape validation: a downgraded/newer
  // manifest may legitimately differ in shape, and the version verdict
  // is the actionable one.
  const schemaVersion = (doc as Record<string, unknown>).schemaVersion;
  if (typeof schemaVersion !== "number" || !Number.isInteger(schemaVersion)) {
    return {
      ok: false,
      failureReason: "schema_invalid",
      detail: "schemaVersion must be an integer",
    };
  }
  if (schemaVersion < SUPPORTED_SCHEMA_VERSION) {
    return {
      ok: false,
      failureReason: "schema_downgrade",
      detail: `manifest schemaVersion ${schemaVersion} is older than supported version ${SUPPORTED_SCHEMA_VERSION} — refusing downgrade`,
    };
  }
  if (schemaVersion > SUPPORTED_SCHEMA_VERSION) {
    return {
      ok: false,
      failureReason: "schema_unsupported",
      detail: `manifest schemaVersion ${schemaVersion} is newer than supported version ${SUPPORTED_SCHEMA_VERSION} — update the orchestrator first`,
    };
  }

  const parsed = manifestSchema.safeParse(doc);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return { ok: false, failureReason: "schema_invalid", detail };
  }

  if (parsed.data.release.minOrchestratorSchema > SUPPORTED_ORCHESTRATOR_SCHEMA) {
    return {
      ok: false,
      failureReason: "orchestrator_schema_unsupported",
      detail: `release requires orchestrator schema ${parsed.data.release.minOrchestratorSchema}, this build supports ${SUPPORTED_ORCHESTRATOR_SCHEMA}`,
    };
  }

  return { ok: true, manifest: parsed.data };
}
