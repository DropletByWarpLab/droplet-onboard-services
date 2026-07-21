/**
 * WARP-1456 — `list_file_versions` LLM tool (Tier 1, read-only).
 *
 * Lists the Nextcloud version history for a file via the orchestrator's
 * WARP-861 files API (`GET /api/files/versions?path=...`). The route
 * resolves the path to a fileId and PROPFINDs the versions DAV
 * collection; its payload is `{ fileId, versions: [{ versionId, size,
 * modifiedAt }] }`, most-recent first. An empty history is a normal
 * success (count 0) — most files simply have no prior versions yet.
 *
 * The `versionId` values returned here are what `restore_file_version`
 * takes as its `version` argument.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { validateNcPath } from "./_paths.js";

const inputSchema = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "Full path to the file whose version history to list.",
    },
  },
  required: ["path"],
  additionalProperties: false,
} as const;

interface VersionEntry {
  versionId: string;
  size: number;
  modifiedAt: string;
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.userId || !ctx.ncToken) {
    // The message is surfaced verbatim to the chat model, which relays it
    // to the user — say how to RECOVER, not just that auth is missing.
    // Sessions minted without a password (passkey/SSO), or whose stored
    // Nextcloud credential was lost (cache restart) or revoked (logout
    // elsewhere), can only be re-provisioned by a password sign-in.
    return {
      ok: false,
      status: "error",
      error: {
        code: "AUTH_REQUIRED",
        message:
          "File access isn't connected for this session. Ask the user to sign out of the Droplet dashboard and sign back in with their password — that reconnects file access and file tools will work again.",
      },
    };
  }
  const v = validateNcPath(args.path);
  if (!v.ok) {
    return {
      ok: false,
      status: "error",
      error: { code: "INVALID_PATH", message: v.error },
    };
  }
  const path = v.path;
  const headers: Record<string, string> = {
    "X-Nextcloud-Token": ctx.ncToken,
    "X-Nextcloud-User": ctx.userId,
  };
  const res = await ctx.http.nextcloud.get(
    `/versions?path=${encodeURIComponent(path)}`,
    { headers },
  );
  if (res.status === 404) {
    return {
      ok: false,
      status: "error",
      error: { code: "NOT_FOUND", message: `file not found: ${path}` },
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      status: "error",
      error: { code: "VERSIONS_UNAVAILABLE", message: `nextcloud returned ${res.status}` },
    };
  }
  const body = (await res.json().catch(() => null)) as { versions?: VersionEntry[] } | null;
  if (!body || !Array.isArray(body.versions)) {
    return {
      ok: false,
      status: "error",
      error: { code: "VERSIONS_UNAVAILABLE", message: "malformed versions response" },
    };
  }
  const versions = body.versions.map((entry) => ({
    versionId: entry.versionId,
    size: entry.size,
    modifiedAt: entry.modifiedAt,
  }));
  return {
    ok: true,
    data: { type: "list_file_versions", path, versions, count: versions.length },
  };
}

const tool: Tool = {
  name: "list_file_versions",
  description:
    "List the saved version history of a file on the Droplet's Nextcloud (most recent first). Each entry has a versionId, size, and modifiedAt timestamp; pass a versionId to restore_file_version to roll the file back. A file with no prior versions returns an empty list (count 0).",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
