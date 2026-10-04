/**
 * WARP-3430 — the signed channel pointer: which release is current on one
 * channel, published at `<download base>/ota-index/channel-<channel>.json`
 * with a detached cosign signature beside it (`….json.sig`), made exactly
 * like `release.json.sig` and verified by the same code (verify.ts) against
 * the same baked-in trust anchor.
 *
 * It exists so a box can discover its release WITHOUT the GitHub REST API:
 * that API allows 60 unauthenticated requests/hour per IP, which a few
 * boxes behind one NAT exhaust, and ADR-045 forbids putting a token on a
 * box to lift the cap. The pointer is a plain file download; the poller then
 * fetches `<tag>/release.json` and requires its sha256 to equal
 * `manifestSha256` here (poller.ts).
 *
 * Pure like manifest.ts: no I/O, no process state. The caller must have
 * verified the signature over these exact bytes first.
 *
 * DOMAIN SEPARATION. The release key signs raw bytes with no domain prefix,
 * so the two document types are kept apart by their SHAPE, in both
 * directions, and channel-pointer.test.ts pins both:
 *   - a pointer is never a manifest: it carries `kind`, and
 *     parseReleaseManifest (manifest.ts) refuses any `kind` other than
 *     "release";
 *   - a manifest is never a pointer: it carries no `kind`, and this schema
 *     requires the literal below (and is strict, so it refuses a manifest's
 *     extra keys too).
 * An extension statement (`kind: "extension"`) fails the same literal.
 *
 * The schema is the v1 shape the publish workflow emits; the publisher and
 * this parser are two halves of one contract — change them together.
 */
import { z } from "zod";

/** The discriminator a pointer must carry. */
export const CHANNEL_POINTER_KIND = "droplet-ota-channel-pointer";
/** Bump when the pointer format itself changes shape. */
export const SUPPORTED_POINTER_SCHEMA_VERSION = 1;

/** `ota-<channel>-<run number>-g<sha7>` (publish-release.yml). Also the URL path segment. */
const TAG_RE = /^ota-([a-z0-9]+)-[0-9]+-g[0-9a-f]{7}$/;
const GIT_SHA_RE = /^[0-9a-f]{40}$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

const isoTimestamp = (what: string) =>
  z.string().refine((v) => !Number.isNaN(Date.parse(v)), `${what} must be an ISO-8601 timestamp`);

const pointerSchema = z
  .object({
    schemaVersion: z.literal(SUPPORTED_POINTER_SCHEMA_VERSION),
    kind: z.literal(CHANNEL_POINTER_KIND),
    channel: z.string().min(1),
    tag: z.string().regex(TAG_RE, "tag must look like ota-<channel>-<run>-g<sha7>"),
    gitSha: z.string().regex(GIT_SHA_RE, "gitSha must be a full 40-hex commit sha"),
    // Copied from the manifest by the publisher; kept a string, compared as an instant.
    builtAt: isoTimestamp("builtAt"),
    manifestSha256: z.string().regex(SHA256_HEX_RE, "manifestSha256 must be 64 hex chars"),
    publishedAt: isoTimestamp("publishedAt"),
  })
  // Unknown keys are refused, not stripped: a field this build does not know
  // is a field it cannot safely interpret (the manifest's own rule for a
  // newer schemaVersion). A new field is a new schemaVersion.
  .strict()
  // The tag is a URL path segment AND names a channel; the two must agree, so
  // a pointer cannot send a stage box to a stable tag's directory.
  .refine((p) => TAG_RE.exec(p.tag)?.[1] === p.channel, {
    message: "tag must carry the pointer's own channel (ota-<channel>-…)",
    path: ["tag"],
  });

export type ChannelPointer = z.infer<typeof pointerSchema>;

export type PointerParseResult =
  | { ok: true; pointer: ChannelPointer }
  | { ok: false; failureReason: "pointer_invalid"; detail: string };

/**
 * Parse + schema-validate a channel-pointer body. Whether it names THIS box's
 * channel is the caller's decision (poller.ts reports it as `channel_mismatch`,
 * like a manifest for another channel), not a schema one.
 */
export function parseChannelPointer(raw: string | Buffer): PointerParseResult {
  const text = typeof raw === "string" ? raw : raw.toString("utf8");

  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      failureReason: "pointer_invalid",
      detail: `channel pointer is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const parsed = pointerSchema.safeParse(doc);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return { ok: false, failureReason: "pointer_invalid", detail };
  }
  return { ok: true, pointer: parsed.data };
}
