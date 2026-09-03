/**
 * WARP-2664 — `analyze_file_cleanup` (Read-tier).
 *
 * The PREVIEW half of the cleanup flow. Walks a folder through the
 * orchestrator's `GET /api/files?path=` listing — the same hop `list_files`
 * uses, repeated per subfolder inside hard bounds — and reports what a
 * cleanup could act on: totals by category, the largest files, stale
 * files, junk an OS or editor left behind, duplicate candidates, empty
 * subfolders, and the exact move list `organize_files` would apply.
 *
 * Nothing moves and nothing is deleted here. The writes are
 * `organize_files` and `delete_files`, each behind its own confirmation,
 * and each takes exactly what the user approved from this report — which
 * is why the report exists at all: a confirmation prompt for "organize
 * /Downloads" means nothing if the user has never seen the plan.
 *
 * Every list is SAMPLED so the result fits the orchestrator's 8,000-char
 * tool-result cap (`tool-result-bounding.ts`) instead of being cut mid-
 * array; the counts and byte totals are always complete even when the
 * samples are not.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { validateNcPath } from "./_paths.js";
import {
  FILE_AUTH_REQUIRED_MESSAGE,
  ORGANIZE_MAX_MOVES,
  ORGANIZE_RULES,
  categoryOf,
  clampInt,
  duplicateGroups,
  humanBytes,
  isOrganizeRule,
  junkReason,
  planOrganize,
  walkTree,
  type CleanupEntry,
  type FileCategory,
} from "./_cleanup.js";

export const ANALYZE_DEFAULT_DEPTH = 3;
export const ANALYZE_MAX_DEPTH = 8;
/** Entry and listing bounds: a whole photo library is not a cleanup target. */
export const ANALYZE_MAX_ENTRIES = 5000;
export const ANALYZE_MAX_LISTINGS = 300;
export const ANALYZE_DEFAULT_STALE_DAYS = 365;

/** Sample sizes per section — counts stay exact, items are the head. */
const SAMPLE = { largest: 10, stale: 20, junk: 30, duplicates: 15, empty: 20, plan: 20 } as const;

const inputSchema = {
  type: "object",
  properties: {
    path: { type: "string", description: "Folder to analyze. Defaults to '/'." },
    max_depth: {
      type: "integer",
      description: "Folder levels to scan below path (0-8). Default 3.",
    },
    stale_days: {
      type: "integer",
      description: "Files not modified in this many days count as stale. Default 365.",
    },
    organize_rule: {
      type: "string",
      description:
        "Which organize_files plan to preview: by_type (default), by_extension, by_month, by_year.",
    },
  },
  additionalProperties: false,
} as const;

function err(code: string, message: string): ToolResult {
  return { ok: false, status: "error", error: { code, message } };
}

function fileItem(e: CleanupEntry) {
  return { path: e.path, size: e.size, size_human: humanBytes(e.size), modified_at: e.modifiedAt };
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.userId || !ctx.ncToken) return err("AUTH_REQUIRED", FILE_AUTH_REQUIRED_MESSAGE);
  const requested = typeof args.path === "string" && args.path.length > 0 ? args.path : "/";
  const v = validateNcPath(requested);
  if (!v.ok) return err("INVALID_PATH", v.error);
  const maxDepth = clampInt(args.max_depth, 0, ANALYZE_MAX_DEPTH, ANALYZE_DEFAULT_DEPTH);
  const staleDays = clampInt(args.stale_days, 1, 36_500, ANALYZE_DEFAULT_STALE_DAYS);
  const rule = args.organize_rule === undefined ? "by_type" : args.organize_rule;
  if (!isOrganizeRule(rule)) {
    return err("INVALID_ARGS", `organize_rule must be one of: ${ORGANIZE_RULES.join(", ")}`);
  }

  const headers: Record<string, string> = {
    "X-Nextcloud-Token": ctx.ncToken,
    "X-Nextcloud-User": ctx.userId,
  };
  const walk = await walkTree(
    v.path,
    (dir) => ctx.http.nextcloud.get(`/?path=${encodeURIComponent(dir)}`, { headers }),
    { maxDepth, maxEntries: ANALYZE_MAX_ENTRIES, maxListings: ANALYZE_MAX_LISTINGS },
  );
  if (walk.rootStatus === 404) return err("NOT_FOUND", `folder not found: ${v.path}`);
  if (walk.rootStatus < 200 || walk.rootStatus >= 300) {
    return err("LIST_FAILED", `nextcloud returned ${walk.rootStatus}`);
  }

  const files = walk.entries.filter((e) => !e.isDirectory);
  const directories = walk.entries.length - files.length;
  const totalBytes = files.reduce((n, f) => n + f.size, 0);

  const categories = new Map<FileCategory, { files: number; bytes: number }>();
  for (const f of files) {
    const category = categoryOf(f.name, f.mimeType);
    const current = categories.get(category) ?? { files: 0, bytes: 0 };
    current.files++;
    current.bytes += f.size;
    categories.set(category, current);
  }
  const by_category = [...categories.entries()]
    .map(([category, c]) => ({ category, files: c.files, bytes: c.bytes, size_human: humanBytes(c.bytes) }))
    .sort((a, b) => b.bytes - a.bytes);

  const largest = [...files].sort((a, b) => b.size - a.size).slice(0, SAMPLE.largest).map(fileItem);

  const cutoff = Date.now() - staleDays * 86_400_000;
  const stale = files
    .filter((f) => {
      const t = Date.parse(f.modifiedAt);
      return Number.isFinite(t) && t < cutoff;
    })
    .sort((a, b) => Date.parse(a.modifiedAt) - Date.parse(b.modifiedAt));
  const staleBytes = stale.reduce((n, f) => n + f.size, 0);

  const junk = files.flatMap((f) => {
    const reason = junkReason(f.name);
    return reason ? [{ path: f.path, size: f.size, reason }] : [];
  });
  const junkBytes = junk.reduce((n, f) => n + f.size, 0);

  const duplicates = duplicateGroups(files);
  const reclaimable = duplicates.reduce((n, g) => n + g.size * (g.paths.length - 1), 0);

  const plan = planOrganize(v.path, walk.entries, rule, ORGANIZE_MAX_MOVES);

  return {
    ok: true,
    data: {
      path: v.path,
      scanned: {
        files: files.length,
        directories,
        bytes: totalBytes,
        size_human: humanBytes(totalBytes),
        max_depth: maxDepth,
        directories_listed: walk.listed,
        truncated: walk.truncated,
      },
      by_category,
      largest,
      stale: {
        older_than_days: staleDays,
        count: stale.length,
        bytes: staleBytes,
        size_human: humanBytes(staleBytes),
        items: stale.slice(0, SAMPLE.stale).map(fileItem),
      },
      junk: {
        count: junk.length,
        bytes: junkBytes,
        size_human: humanBytes(junkBytes),
        items: junk.slice(0, SAMPLE.junk),
      },
      duplicate_candidates: {
        groups: duplicates.length,
        reclaimable_bytes: reclaimable,
        reclaimable_human: humanBytes(reclaimable),
        items: duplicates.slice(0, SAMPLE.duplicates).map((g) => ({
          name: g.name,
          size: g.size,
          size_human: humanBytes(g.size),
          paths: g.paths,
        })),
        note: "Matched by name and size, not by content. Ask before deleting a copy.",
      },
      empty_directories: {
        count: walk.emptyDirectories.length,
        items: walk.emptyDirectories.slice(0, SAMPLE.empty),
      },
      organize_plan: {
        rule,
        files_to_move: plan.moves.length + plan.remaining,
        folders: plan.folders,
        sample: plan.moves.slice(0, SAMPLE.plan).map(({ from, to }) => ({ from, to })),
        note: "Only files directly inside path move; subfolders stay put. Apply with organize_files.",
      },
      unreadable_directories: walk.errors,
    },
  };
}

const tool: Tool = {
  name: "analyze_file_cleanup",
  description:
    "Read-only cleanup report for a folder: totals by category, largest files, stale files, junk (temp, lock and thumbnail files), duplicate candidates (same name and size), empty subfolders, and the exact plan organize_files would apply. Run this first and show the user what it found, then use organize_files or delete_files for the parts they approve.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
