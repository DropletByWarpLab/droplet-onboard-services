/**
 * WARP-2664 — `delete_files` (Write-tier + confirmation).
 *
 * Bulk delete for a cleanup: the junk, stale copies and empty folders the
 * user picked out of an `analyze_file_cleanup` report, in one approved
 * step instead of one `delete_file` prompt per path. Everything goes to
 * the Nextcloud trash, exactly as `delete_file` does, so a wrong pick is
 * recoverable from the dashboard. Emptying the trash — the only
 * irreversible step — is not a tool, on purpose (ADR-019's line).
 *
 * What makes this the SAFE bulk form rather than a loop over `delete_file`:
 *
 *   - the list is explicit and bounded (`DELETE_FILES_MAX_PATHS`), and the
 *     confirmation token is bound to that exact list;
 *   - every path is looked up in its parent's listing first, so a folder
 *     passed where a file was meant is refused, not recursively trashed;
 *   - folders are only deleted when `allow_folders` is set AND they are
 *     empty. A folder with contents always points the model at
 *     `delete_file`, whose description says it is recursive.
 *
 * Confirmation is the generic interceptor's (`docs/tool-confirmation-
 * contract.md` §12): no `confirmed` boolean in the schema, so a token a
 * human minted is the only way through.
 */
import { posix as posixPath } from "node:path";
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { validateNcPath } from "./_paths.js";
import { FILE_AUTH_REQUIRED_MESSAGE, parseEntries, type CleanupEntry } from "./_cleanup.js";

export const DELETE_FILES_MAX_PATHS = 100;

const inputSchema = {
  type: "object",
  properties: {
    paths: {
      type: "array",
      items: { type: "string" },
      description:
        "Full paths to delete (1-100): files, or empty folders when allow_folders is true.",
    },
    allow_folders: {
      type: "boolean",
      description:
        "Also delete EMPTY folders in the list. Default false. A folder with contents is always skipped; use delete_file for that.",
    },
  },
  required: ["paths"],
  additionalProperties: false,
} as const;

function err(code: string, message: string): ToolResult {
  return { ok: false, status: "error", error: { code, message } };
}

interface Listing {
  ok: boolean;
  status: number;
  byPath: Map<string, CleanupEntry>;
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.userId || !ctx.ncToken) return err("AUTH_REQUIRED", FILE_AUTH_REQUIRED_MESSAGE);
  const raw = args.paths;
  if (!Array.isArray(raw) || raw.length === 0) {
    return err("INVALID_ARGS", "paths must be a non-empty array of strings");
  }
  if (raw.length > DELETE_FILES_MAX_PATHS) {
    return err("INVALID_ARGS", `at most ${DELETE_FILES_MAX_PATHS} paths per call`);
  }
  const allowFolders = args.allow_folders === true;

  // Validate EVERYTHING before touching anything: a malformed entry at
  // index 40 must not leave the first 39 deleted.
  const targets: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const v = validateNcPath(raw[i]);
    if (!v.ok) return err("INVALID_PATH", `paths[${i}]: ${v.error}`);
    if (v.path === "/") return err("INVALID_PATH", `paths[${i}]: refusing to delete the top-level folder`);
    if (seen.has(v.path)) continue;
    seen.add(v.path);
    targets.push(v.path);
  }

  const headers: Record<string, string> = {
    "X-Nextcloud-Token": ctx.ncToken,
    "X-Nextcloud-User": ctx.userId,
  };

  // One listing per distinct folder: cleanup targets cluster by parent, so
  // a hundred paths usually cost a handful of reads.
  const listings = new Map<string, Listing>();
  async function listDir(dir: string): Promise<Listing> {
    const cached = listings.get(dir);
    if (cached) return cached;
    const res = await ctx.http.nextcloud.get(`/?path=${encodeURIComponent(dir)}`, { headers });
    const byPath = new Map<string, CleanupEntry>();
    if (res.ok) {
      for (const e of parseEntries(await res.json().catch(() => null))) byPath.set(e.path, e);
    }
    const listing: Listing = { ok: res.ok, status: res.status, byPath };
    listings.set(dir, listing);
    return listing;
  }

  const deleted: string[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  const failed: Array<{ path: string; reason: string }> = [];

  for (const target of targets) {
    if (ctx.signal.aborted) {
      skipped.push({ path: target, reason: "not attempted: the request was cancelled" });
      continue;
    }
    const parent = posixPath.dirname(target);
    const listing = await listDir(parent);
    if (!listing.ok) {
      failed.push({ path: target, reason: `could not read ${parent} (nextcloud returned ${listing.status})` });
      continue;
    }
    const entry = listing.byPath.get(target);
    if (!entry) {
      failed.push({ path: target, reason: "not found" });
      continue;
    }
    if (entry.isDirectory) {
      if (!allowFolders) {
        skipped.push({
          path: target,
          reason:
            "is a folder; pass allow_folders: true to delete an empty folder, or use delete_file to delete a folder with its contents",
        });
        continue;
      }
      const inner = await listDir(target);
      if (!inner.ok) {
        failed.push({ path: target, reason: `could not read the folder (nextcloud returned ${inner.status})` });
        continue;
      }
      if (inner.byPath.size > 0) {
        skipped.push({
          path: target,
          reason: "folder is not empty; use delete_file to delete it with its contents",
        });
        continue;
      }
    }
    const res = await ctx.http.nextcloud.delete(`/?path=${encodeURIComponent(target)}`, { headers });
    if (res.ok) deleted.push(target);
    else failed.push({ path: target, reason: `nextcloud returned ${res.status}` });
  }

  return {
    ok: true,
    data: {
      deleted,
      skipped,
      failed,
      counts: { deleted: deleted.length, skipped: skipped.length, failed: failed.length },
      note: "Deleted items are in the Nextcloud trash and can be restored from the dashboard.",
    },
  };
}

const tool: Tool = {
  name: "delete_files",
  description:
    "Delete several files (and empty folders, with allow_folders) to the Nextcloud trash in one step, up to 100 paths. Refuses the top-level folder and any folder with contents (use delete_file for a folder and its contents). Pass exactly the paths the user agreed to, for example from analyze_file_cleanup. Asks the user for approval.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: true,
  handler,
};

export default tool;
