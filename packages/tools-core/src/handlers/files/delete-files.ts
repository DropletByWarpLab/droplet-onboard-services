/**
 * WARP-2664 — `delete_files` (Write-tier + confirmation).
 *
 * Bulk delete for a cleanup: the junk and stale copies the user picked out of
 * an `analyze_file_cleanup` report, in one approved step instead of one
 * `delete_file` prompt per path. Everything goes to the Nextcloud trash, so a
 * wrong pick is recoverable from the dashboard. Emptying the trash — the only
 * irreversible step — is not a tool, on purpose (ADR-019's line).
 *
 * What makes this the SAFE bulk form rather than a loop over `delete_file`:
 *
 *   - the list is explicit and bounded (`DELETE_FILES_MAX_PATHS`), and the
 *     confirmation token is bound to that exact list, so one approval
 *     authorises exactly the paths the user saw;
 *   - every path is resolved in its parent's listing first, so this tool only
 *     ever deletes something it has positively seen;
 *   - THIS TOOL DELETES FILES ONLY. A directory is refused, always.
 *
 * ## Why directories are refused outright, and not merely "unless empty"
 *
 * The first cut of this handler accepted an `allow_folders` flag and deleted a
 * directory once a second listing came back empty. That guard cannot be made
 * sound at this layer, and an unsound guard on a recursive delete is worse
 * than no feature:
 *
 *   `GET /api/files` DEGRADES. When Nextcloud is unreachable or answers 5xx,
 *   `ncListFiles` throws, `handleFileError(err, res, next, [])` catches it, and
 *   the route answers **200 with `[]`** (routes/files.ts, and
 *   `isUpstreamUnavailable` matches any `: 5xx` message). An empty listing is
 *   therefore NOT evidence of an empty folder — it is equally consistent with a
 *   container restart, a proxy 502, or a PROPFIND timeout on a large folder.
 *
 * So the sequence "user approves deleting an empty folder → probe listing
 * degrades → folder reads as empty → DELETE" trashes a full directory tree
 * recursively, having satisfied every check. The check was satisfied BY the
 * outage. There is no positive signal available here to replace it: the parent
 * listing carries no child count, and a collection's `getcontentlength` is
 * absent, so `size` is 0 for every directory whether or not it holds anything.
 *
 * Deleting only files removes the inference, and with it the failure mode.
 * `analyze_file_cleanup` still REPORTS empty directories so the user knows they
 * are there; removing them is a Files-app action, where a human sees the folder
 * before it goes.
 *
 * The refusal deliberately does NOT name `delete_file` as the way around it.
 * That tool has been confirmation-gated since WARP-2669, but it is still
 * recursive for directories, and what a folder would take with it is exactly
 * what this layer cannot verify — the degrade above. A refusal that routes
 * the model to a recursive delete would make this handler's control a
 * signpost; the Files app is where a person sees the contents before the
 * folder goes.
 *
 * Confirmation is the generic interceptor's (`docs/tool-confirmation-contract.md`
 * §12): no `confirmed` boolean in the schema, so a token a human minted is the
 * only way through.
 */
import { posix as posixPath } from "node:path";
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { validateNcPath } from "./_paths.js";
import { ncHeaders } from "./_render.js";
import {
  DEGRADED_LISTING_CAVEAT,
  FILE_AUTH_REQUIRED_MESSAGE,
  readListing,
  unlessAborted,
  type Listing,
} from "./_cleanup.js";

export const DELETE_FILES_MAX_PATHS = 100;

const inputSchema = {
  type: "object",
  properties: {
    paths: {
      type: "array",
      items: { type: "string" },
      description: "Full paths of the FILES to delete (1-100). Directories are refused.",
    },
  },
  required: ["paths"],
  additionalProperties: false,
} as const;

function err(code: string, message: string): ToolResult {
  return { ok: false, status: "error", error: { code, message } };
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

  // Validate EVERYTHING before touching anything: a malformed entry at
  // index 40 must not leave the first 39 deleted.
  const targets: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const v = validateNcPath(raw[i]);
    if (!v.ok) return err("INVALID_PATH", `paths[${i}]: ${v.error}`);
    if (v.path === "/") {
      return err("INVALID_PATH", `paths[${i}]: refusing to delete the top-level folder`);
    }
    if (seen.has(v.path)) continue;
    seen.add(v.path);
    targets.push(v.path);
  }

  const headers = ncHeaders(ctx);

  // One listing per distinct parent: cleanup targets cluster by folder, so a
  // hundred paths usually cost a handful of reads.
  const listings = new Map<string, Listing>();
  /** `null` when the read was cut short by the caller's signal. */
  async function listDir(dir: string): Promise<Listing | null> {
    const cached = listings.get(dir);
    if (cached) return cached;
    const res = await unlessAborted(ctx.signal, () =>
      ctx.http.nextcloud.get(`/?path=${encodeURIComponent(dir)}`, { headers, signal: ctx.signal }),
    );
    if (!res) return null;
    const listing = await readListing(res);
    listings.set(dir, listing);
    return listing;
  }

  const deleted: string[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  const failed: Array<{ path: string; reason: string }> = [];
  let possiblyDegraded = false;

  for (const target of targets) {
    if (ctx.signal.aborted) {
      skipped.push({ path: target, reason: "not attempted: the request was cancelled" });
      continue;
    }
    const parent = posixPath.dirname(target);
    const listing = await listDir(parent);
    if (!listing) {
      skipped.push({ path: target, reason: "not attempted: the request was cancelled" });
      continue;
    }
    if (!listing.ok) {
      failed.push({
        path: target,
        reason: `could not read ${parent} (nextcloud returned ${listing.status})`,
      });
      continue;
    }
    if (listing.possiblyDegraded) possiblyDegraded = true;
    const entry = listing.entries.find((e) => e.path === target);
    if (!entry) {
      failed.push({ path: target, reason: "not found" });
      continue;
    }
    if (entry.isDirectory) {
      // No `allow_folders` escape hatch — see the header. Do not name a
      // less-guarded tool here.
      skipped.push({
        path: target,
        reason:
          "is a folder, and this tool deletes files only. Deleting a folder together with everything inside it is not something to do from a bulk list — ask the user to remove it from the Files app, where they can see the contents first.",
      });
      continue;
    }
    const res = await unlessAborted(ctx.signal, () =>
      ctx.http.nextcloud.delete(`/?path=${encodeURIComponent(target)}`, { headers, signal: ctx.signal }),
    );
    if (!res) {
      // Cut short mid-flight: the delete may or may not have reached the
      // server. Reported as failed, never as deleted.
      failed.push({
        path: target,
        reason: "cancelled while the delete was in flight; it may or may not be in the trash — re-run to check",
      });
      continue;
    }
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
      // A parent is only listed for a target inside it, so an empty listing
      // always means a "not found" that an outage would explain just as well.
      ...(possiblyDegraded ? { caveat: DEGRADED_LISTING_CAVEAT } : {}),
    },
  };
}

const tool: Tool = {
  name: "delete_files",
  description:
    "Delete several FILES to the Nextcloud trash in one step, up to 100 paths, so one approval covers the whole list. Folders are refused — this deletes files only. Each path must exist in its folder listing or it is reported as not found; nothing is deleted permanently. Pass exactly the paths the user agreed to, for example from analyze_file_cleanup. Asks the user for approval.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: true,
  handler,
};

export default tool;
