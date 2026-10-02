/**
 * WARP-2900 (ADR-056 slice H1): the extension manifest and the signed
 * extension statement.
 *
 * ## The manifest (extension-manifest.json, schemaVersion 1)
 *
 * What a Workshop proposal declares about itself: what it runs, what it
 * provides, how much memory it needs, and that it reaches nothing outside the
 * box. The schema is STRICT at every level: a key the schema does not name is
 * refused, not ignored. The one deliberate exception is a tool's
 * `inputSchema` (and a routine draft's opaque `steps`), which ARE JSON Schema
 * / ToolSpec documents with their own open vocabulary.
 *
 * docs/schemas/extension-manifest.schema.json is the language-neutral mirror
 * of `extensionManifestSchema`; extension-manifest.schema-drift.test.ts runs
 * one accept/refuse corpus through both. Checks JSON Schema cannot express
 * (duplicate tool names, duplicate routine slugs) live in
 * `parseExtensionManifest`, not in the structural schema, so the two stay
 * comparable.
 *
 * `summary` and every `description` are free text the extension author
 * wrote. Nothing the owner is asked to confirm is derived from them:
 * `deriveReadback` reads provides/resources/egress only.
 *
 * ## The statement (what the box key actually signs)
 *
 * A manifest cannot name the commit it lives in, so signing the manifest alone
 * would leave the code unsigned. The orchestrator instead builds a canonical
 * JSON statement that binds the manifest digest to the exact commit and tree:
 *
 *   {commit, extensionId, keyUsage:"extension", kind:"extension",
 *    manifestSha256, schemaVersion:1, tree, version, workspaceId}
 *
 * The sidecar signs EXTENSION_STATEMENT_PREFIX || statement with the box
 * extension key (services/device-identity-svc/extension_signing.py); Warp
 * Lab's release key may sign the raw statement with cosign for first-party
 * extensions. update-agent/extension-verify.ts is the verifier.
 */
import { createHash } from "node:crypto";
import { z } from "zod";

export const EXTENSION_MANIFEST_SCHEMA_VERSION = 1;
export const EXTENSION_STATEMENT_SCHEMA_VERSION = 1;
export const EXTENSION_KIND = "extension";
export const EXTENSION_RUNTIMES = ["node20", "python312"] as const;

/** Mirrors services/sandbox/gitstore.py WORKSPACE_ID. */
export const WORKSPACE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Mirrors services/sandbox/workspace.py _SEMVER (the proposal/<ver> tag). */
export const EXTENSION_VERSION_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
/**
 * A relative POSIX path whose every segment starts with a letter, digit or
 * underscore: no leading "/", no "." or ".." segment, no empty segment, no
 * backslash, no drive letter.
 */
export const ENTRYPOINT_PATTERN =
  /^[A-Za-z0-9_][A-Za-z0-9_.-]*(\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/;
/** snake_case; a subset of the multiplexer's wire-name pattern. */
export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
/** A plain JS/Python identifier: the named export the host shim calls. */
export const EXPORT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export const ROLE_OR_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const DOMAIN_PATTERN = /^[a-z][a-z0-9_:-]{0,63}$/;

export const EXTENSION_MEMORY_MB_MIN = 16;
export const EXTENSION_MEMORY_MB_MAX = 4096;

const toolSchema = z
  .object({
    name: z.string().regex(TOOL_NAME_PATTERN),
    description: z.string().min(1).max(1024),
    // A JSON Schema document: its own vocabulary is open by design.
    inputSchema: z.object({ type: z.literal("object") }).passthrough(),
    export: z.string().regex(EXPORT_NAME_PATTERN),
    classificationProposal: z
      .object({
        requiresWrite: z.boolean(),
        requiresConfirmation: z.boolean(),
      })
      .strict(),
  })
  .strict();

const routineDraftSchema = z
  .object({
    slug: z.string().regex(ROLE_OR_SLUG_PATTERN),
    name: z.string().min(1).max(120),
    description: z.string().max(1024).optional(),
    category: z.string().min(1).max(64).optional(),
    // ToolSpec steps; validated by the ToolSpec validator when a draft is
    // seeded (WARP-2897), opaque here.
    steps: z.array(z.object({}).passthrough()).min(1).max(32),
  })
  .strict();

const proposedGrantSchema = z
  .object({
    role: z.string().regex(ROLE_OR_SLUG_PATTERN),
    domain: z.string().regex(DOMAIN_PATTERN),
    level: z.enum(["view", "use"]).optional(),
  })
  .strict();

export const extensionManifestSchema = z
  .object({
    schemaVersion: z.literal(EXTENSION_MANIFEST_SCHEMA_VERSION),
    id: z.string().regex(WORKSPACE_ID_PATTERN),
    name: z.string().min(1).max(120),
    version: z.string().regex(EXTENSION_VERSION_PATTERN),
    kind: z.literal(EXTENSION_KIND),
    runtime: z.enum(EXTENSION_RUNTIMES),
    entrypoint: z.string().max(256).regex(ENTRYPOINT_PATTERN),
    provides: z
      .object({
        tools: z.array(toolSchema).min(1).max(32),
        routineDrafts: z.array(routineDraftSchema).max(16),
        proposedGrants: z.array(proposedGrantSchema).max(32),
      })
      .strict(),
    resources: z
      .object({
        memoryMb: z
          .number()
          .int()
          .min(EXTENSION_MEMORY_MB_MIN)
          .max(EXTENSION_MEMORY_MB_MAX),
        processes: z.literal(1),
      })
      .strict(),
    // v1 extensions reach nothing outside the box. There is no other value.
    egress: z.literal("none"),
    // Free text, never rendered in the readback.
    summary: z.string().max(2000).optional(),
  })
  .strict();

export type ExtensionManifest = z.infer<typeof extensionManifestSchema>;

export type ParseManifestResult =
  | { ok: true; manifest: ExtensionManifest }
  | { ok: false; detail: string };

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const v of values) (seen.has(v) ? dup : seen).add(v);
  return [...dup];
}

/**
 * Bytes -> manifest: JSON, the strict schema, then the checks JSON Schema
 * cannot express. Never throws.
 */
export function parseExtensionManifest(bytes: Uint8Array): ParseManifestResult {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (err) {
    return { ok: false, detail: `manifest is not UTF-8 JSON: ${(err as Error).message}` };
  }
  const parsed = extensionManifestSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      detail: parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; "),
    };
  }
  const m = parsed.data;
  const dupTools = duplicates(m.provides.tools.map((t) => t.name));
  if (dupTools.length > 0) {
    return { ok: false, detail: `duplicate tool name(s): ${dupTools.join(", ")}` };
  }
  const dupDrafts = duplicates(m.provides.routineDrafts.map((d) => d.slug));
  if (dupDrafts.length > 0) {
    return { ok: false, detail: `duplicate routine draft slug(s): ${dupDrafts.join(", ")}` };
  }
  return { ok: true, manifest: m };
}

// ─── canonical JSON ──────────────────────────────────────────────────────

/**
 * Canonical JSON: object keys sorted by UTF-16 code unit at every depth, no
 * whitespace, JSON.stringify string/number encoding. Refuses anything JSON
 * cannot round-trip (undefined, functions, bigint, non-finite numbers), so
 * the bytes a verifier re-derives are the bytes that were signed.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new Error("canonicalJson: non-finite number");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).sort();
      return `{${keys
        .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
        .join(",")}}`;
    }
    default:
      throw new Error(`canonicalJson: cannot encode a ${typeof value}`);
  }
}

// ─── the statement ───────────────────────────────────────────────────────

/** "ext-" + slug must fit the multiplexer's 32-char server id. */
export const EXTENSION_SLUG_MAX_LENGTH = 27;
export const EXTENSION_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,26}$/;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export const extensionStatementSchema = z
  .object({
    kind: z.literal(EXTENSION_KIND),
    keyUsage: z.literal(EXTENSION_KIND),
    schemaVersion: z.literal(EXTENSION_STATEMENT_SCHEMA_VERSION),
    extensionId: z.string().regex(EXTENSION_SLUG_PATTERN),
    workspaceId: z.string().regex(WORKSPACE_ID_PATTERN),
    version: z.string().regex(EXTENSION_VERSION_PATTERN),
    commit: z.string().regex(GIT_SHA_PATTERN),
    tree: z.string().regex(GIT_SHA_PATTERN),
    manifestSha256: z.string().regex(SHA256_HEX_PATTERN),
  })
  .strict();

export type ExtensionStatement = z.infer<typeof extensionStatementSchema>;

export type ExtensionStatementFields = Omit<
  ExtensionStatement,
  "kind" | "keyUsage" | "schemaVersion"
>;

/**
 * "sha256:<hex>" over a key's SubjectPublicKeyInfo DER: the sidecar's
 * spki_fingerprint(), and what ExtensionVersion.keyFingerprint records.
 */
export function extensionKeyFingerprint(spkiDer: Uint8Array): string {
  return `sha256:${createHash("sha256").update(spkiDer).digest("hex")}`;
}

/** Lowercase hex sha256 of the exact manifest bytes. */
export function manifestSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The canonical statement bytes the box signs. Throws on any field outside
 * the statement schema: nothing malformed ever reaches the sidecar.
 */
export function buildExtensionStatement(fields: ExtensionStatementFields): Buffer {
  const statement = extensionStatementSchema.parse({
    ...fields,
    kind: EXTENSION_KIND,
    keyUsage: EXTENSION_KIND,
    schemaVersion: EXTENSION_STATEMENT_SCHEMA_VERSION,
  });
  return Buffer.from(canonicalJson(statement), "utf8");
}

/** Hex chars of sha256(workspaceId) a hashed slug ends with (40 bits). */
export const EXTENSION_SLUG_HASH_HEX = 10;
const HASHED_SLUG_TAIL = new RegExp(`-[0-9a-f]{${EXTENSION_SLUG_HASH_HEX}}$`);

/**
 * Stable extension slug for a workspace id. The multiplexer caps server ids
 * at 32 characters ("ext-" + slug) and workspace ids may be 64.
 *
 * Two disjoint shapes, so no workspace can take another's slug by spelling:
 *   - a short id that does NOT end in "-" + 10 hex is its own slug;
 *   - every other id (longer than the cap, or already ending in "-" + 10
 *     hex) becomes <head> + "-" + the first 10 hex of its sha256.
 * Every hashed slug ends in "-" + 10 hex and no identity slug does, so a
 * short id spelled like another id's hashed slug is itself hashed. Two
 * hashed slugs collide only on a 40-bit hash prefix with the same head; the
 * store's unique slug (H2) refuses the promotion if that ever happens.
 * The slug is inside the signed statement: changing this is a re-promote.
 */
export function deriveExtensionSlug(workspaceId: string): string {
  if (!WORKSPACE_ID_PATTERN.test(workspaceId)) {
    throw new Error(`not a workspace id: ${JSON.stringify(workspaceId)}`);
  }
  if (workspaceId.length <= EXTENSION_SLUG_MAX_LENGTH && !HASHED_SLUG_TAIL.test(workspaceId)) {
    return workspaceId;
  }
  const suffix = createHash("sha256")
    .update(workspaceId)
    .digest("hex")
    .slice(0, EXTENSION_SLUG_HASH_HEX);
  const head = workspaceId
    .slice(0, EXTENSION_SLUG_MAX_LENGTH - EXTENSION_SLUG_HASH_HEX - 1)
    .replace(/-+$/, "");
  return `${head}-${suffix}`;
}

// ─── the promote readback ────────────────────────────────────────────────

export interface ExtensionReadback {
  tools: {
    total: number;
    /** Every extension tool imports as write + confirm (WARP-2426). */
    startsAsWriteWithConfirmation: number;
    /** How many the author proposes as read-only; a proposal, not a grant. */
    proposedReadOnly: number;
  };
  routineDrafts: number;
  proposedGrants: number;
  memoryMb: number;
  egress: "reaches nothing outside the box";
  /** The sentences the confirm step shows, in order. */
  lines: string[];
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/**
 * What the owner confirms at promote, derived ONLY from provides, resources
 * and egress. It never reads name, summary or any description: those are
 * the author's words, and the readback exists to say what the code will get,
 * not what its author claims.
 */
export function deriveReadback(m: ExtensionManifest): ExtensionReadback {
  const total = m.provides.tools.length;
  const proposedReadOnly = m.provides.tools.filter(
    (t) => !t.classificationProposal.requiresWrite,
  ).length;
  const drafts = m.provides.routineDrafts.length;
  const grants = m.provides.proposedGrants.length;
  const egress = "reaches nothing outside the box" as const;
  return {
    tools: { total, startsAsWriteWithConfirmation: total, proposedReadOnly },
    routineDrafts: drafts,
    proposedGrants: grants,
    memoryMb: m.resources.memoryMb,
    egress,
    lines: [
      `${total} ${plural(total, "tool", "tools")}, ${plural(
        total,
        "which starts as write with confirmation until you review it",
        "which start as write with confirmation until you review them",
      )}`,
      `${drafts} routine ${plural(drafts, "draft", "drafts")} seeded`,
      `${grants} access ${plural(grants, "grant", "grants")} proposed`,
      egress,
      `memory budget ${m.resources.memoryMb} MB`,
    ],
  };
}
