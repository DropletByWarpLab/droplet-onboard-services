/**
 * WARP-3205 (WARP-2900 H5) — what an owner reviewing an extension's tool is
 * shown.
 *
 * The classification record keeps a HASH of what a person reviews of each
 * `ext-*` tool — `remoteToolReviewHash(description, inputSchemaHash)`, the
 * one the attach path records (recordDiscoveredRemoteTools, since
 * da53a4cff) — not the description or the schema. The review surface has to
 * show exactly what that hash names, because the owner's decision is sent
 * back with it (PATCH …/classifications, 409 STALE_REVIEW otherwise): a hash
 * the owner never saw the contents of is a review of nothing.
 *
 * So the tool is read from the extension's CURRENT signed manifest and its
 * schema and description attached ONLY when {@link reviewHashFor} of them
 * equals the row's hash. Anything else — a newer version promoted but not
 * yet attached, a reworded description, a tool the new version dropped, a
 * row with no hash, a manifest that does not parse — is `inputSchema: null`
 * and `declaredDescription: null`, and the surface offers no review for it.
 * Never the nearest schema under a hash that does not name it.
 *
 * `declaredDescription` is the signed manifest's description of that tool.
 * It is part of what the hash binds, and it is what the model is shown, so
 * the owner sees it too — as its author's words, which the dashboard labels
 * as such. Nothing decides anything from it. The row's `wireDescription` is
 * left on the row as recorded (a truncated copy the hash does not bind); the
 * dashboard's type for this response has no field for it.
 *
 * The row's `decision` is the record's own (`decideFromRecord`), which for
 * `ext-*` IS the dispatch policy (mcp-client.singleton's
 * `extensionRemoteCallPolicy`), so the page and a real call cannot disagree.
 * A vendor row is left exactly as the record has it: a compiled table
 * (Atlassian's) speaks for those, and the record alone would mislead.
 */
import type { PrismaClient } from "@prisma/client";
import { parseExtensionManifest } from "./extension-manifest.js";
import { extensionInputSchemaHash } from "./extension-mcp.port.js";
import { EXTENSION_SERVER_PREFIX } from "./extension-token.js";
import { namespacedToolName } from "./mcp-multiplexer.service.js";
import {
  decideFromRecord,
  remoteToolReviewHash,
  type RemoteToolClassificationRow,
} from "./remote-tool-classification.service.js";

export type ExtensionToolReviewPrisma = Pick<PrismaClient, "extension">;

/** What dispatch does with a call, in the runtime-tools route's shape. */
export interface ToolDispatchDecision {
  decision: "allow" | "deny";
  code: string | null;
}

export type ReviewedClassificationRow = RemoteToolClassificationRow & {
  /** `ext-*` rows only: the schema the row's hash names, or null when the box cannot show it. */
  inputSchema?: Record<string, unknown> | null;
  /** `ext-*` rows only: the signed description the row's hash names, beside a matched schema; else null. */
  declaredDescription?: string | null;
  /** `ext-*` rows only. */
  decision?: ToolDispatchDecision;
};

/** One tool as the signed manifest declares it. */
interface DeclaredTool {
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * The hash a row's review is bound to, recomputed from a declared tool. It
 * must be what the attach path records the row with
 * (extension-attach.service: the manifest tool's description and
 * `extensionInputSchemaHash` of its schema, through `remoteToolReviewHash`).
 */
function reviewHashFor(tool: DeclaredTool): string {
  return remoteToolReviewHash(tool.description, extensionInputSchemaHash(tool.inputSchema));
}

/** Tool name → the tool, from the extension's current signed manifest; null when there is none. */
async function currentTools(
  prisma: ExtensionToolReviewPrisma,
  slug: string,
): Promise<Map<string, DeclaredTool> | null> {
  const ext = await prisma.extension.findUnique({
    where: { id: slug },
    select: { currentVersion: { select: { manifestBytes: true } } },
  });
  const bytes = ext?.currentVersion?.manifestBytes;
  if (!bytes) return null;
  const parsed = parseExtensionManifest(bytes);
  if (!parsed.ok) return null;
  return new Map(
    parsed.manifest.provides.tools.map((t) => [
      t.name,
      { description: t.description, inputSchema: t.inputSchema as Record<string, unknown> },
    ]),
  );
}

export async function withExtensionToolReview(
  prisma: ExtensionToolReviewPrisma,
  rows: readonly RemoteToolClassificationRow[],
): Promise<ReviewedClassificationRow[]> {
  const bySlug = new Map<string, Map<string, DeclaredTool> | null>();
  for (const r of rows) {
    if (!r.serverId.startsWith(EXTENSION_SERVER_PREFIX)) continue;
    const slug = r.serverId.slice(EXTENSION_SERVER_PREFIX.length);
    if (!bySlug.has(slug)) bySlug.set(slug, await currentTools(prisma, slug));
  }
  return rows.map((r) => {
    if (!r.serverId.startsWith(EXTENSION_SERVER_PREFIX)) return r;
    const tool = bySlug.get(r.serverId.slice(EXTENSION_SERVER_PREFIX.length))?.get(r.toolName);
    const named = tool !== undefined && !!r.inputSchemaHash && reviewHashFor(tool) === r.inputSchemaHash;
    const d = decideFromRecord(r, namespacedToolName(r.serverId, r.toolName));
    return {
      ...r,
      inputSchema: named ? tool.inputSchema : null,
      declaredDescription: named ? tool.description : null,
      decision: d.kind === "allow" ? { decision: "allow", code: null } : { decision: "deny", code: d.code },
    };
  });
}
