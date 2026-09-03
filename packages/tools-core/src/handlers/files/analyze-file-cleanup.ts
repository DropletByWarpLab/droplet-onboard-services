/**
 * WARP-2664 — `analyze_file_cleanup` (Read-tier).
 *
 * The PREVIEW half of the cleanup flow. Walks a folder through the
 * orchestrator's `GET /api/files?path=` listing — the same hop `list_files`
 * uses, repeated per subfolder inside hard bounds — and reports what a
 * cleanup could act on: totals by category, the largest files, stale
 * files, junk an OS or editor left behind, duplicate candidates, empty
 * subfolders, and what `organize_files` would do.
 *
 * Nothing moves and nothing is deleted here. The writes are
 * `organize_files` and `delete_files`, each behind its own confirmation,
 * and each takes exactly what the user approved from this report — which
 * is why the report exists at all: a confirmation prompt for "organize
 * /Downloads" means nothing if the user has never seen the plan.
 *
 * ## Everything here is bounded, because the result has a hard ceiling
 *
 * The orchestrator caps a tool result at 8,000 chars
 * (`tool-result-bounding.ts` `MODEL_TOOL_RESULT_CAP_CHARS`) and reduces
 * anything larger by shortening the biggest values — which on a nested
 * report means whole sections get emptied, silently, including the very
 * path lists `delete_files` needs. A report that overflows is therefore not
 * "verbose", it is BROKEN: the model relays a partial cleanup as a complete
 * one.
 *
 * The first cut of this handler serialized to ~14,000 chars on a genuinely
 * messy folder. Two things fixed that, and both are also better reporting:
 *
 *   1. Every sampled list states `shown` and `of` explicitly, so a sample
 *      can never be read as the whole set.
 *   2. `organize_plan` carries a COUNT PER DESTINATION rather than example
 *      paths. "812 to Documents, 604 to Images" is a tenth the size of
 *      twenty sample paths and tells the user more about what will happen.
 *
 * `__tests__/handlers/files/analyze-file-cleanup.test.ts` pins the whole
 * result under the cap against a deliberately messy fixture.
 *
 * ## What this tool cannot know
 *
 * An empty listing is not proof of an empty folder — see
 * {@link DEGRADED_LISTING_CAVEAT}. Results that the degrade could explain
 * say so rather than reporting a clean drive during an outage.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { validateNcPath } from "./_paths.js";
import {
  DEGRADED_LISTING_CAVEAT,
  FILE_AUTH_REQUIRED_MESSAGE,
  ORGANIZE_MAX_MOVES,
  ORGANIZE_RULES,
  categoryOf,
  clampInt,
  destinationFolderFor,
  duplicateGroups,
  humanBytes,
  isOrganizeRule,
  isDotfile,
  junkReason,
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

/**
 * Sample sizes. Counts and byte totals are always COMPLETE and exact; only
 * the example lists are cut. Sized from a measurement against long
 * real-world paths, not guessed — see the header and the cap test.
 */
export const SAMPLE = {
  largest: 5,
  stale: 5,
  junk: 10,
  /** Duplicate groups shown, and copies listed within each group. */
  duplicateGroups: 5,
  duplicatePaths: 3,
  empty: 6,
  /** Destination folders named in the organize plan. */
  planFolders: 12,
} as const;

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
    .map(([category, c]) => ({ category, files: c.files, size_human: humanBytes(c.bytes) }))
    .sort((a, b) => b.files - a.files);

  const largest = [...files]
    .sort((a, b) => b.size - a.size)
    .slice(0, SAMPLE.largest)
    .map((f) => ({ path: f.path, size_human: humanBytes(f.size) }));

  const cutoff = Date.now() - staleDays * 86_400_000;
  // Oldest first: the point of the list is which files have gone longest
  // untouched, so the sample must be the most stale, not the least.
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
  const reclaimable = duplicates.reduce((n, g) => n + g.size * g.duplicates.length, 0);

  // The plan, from the same helper organize_files uses, so the preview and
  // the write cannot disagree about what would move.
  const planFiles = walk.entries.filter(
    (e) => !e.isDirectory && !isDotfile(e.name) && parentOf(e.path) === v.path,
  );
  const movesByFolder = new Map<string, number>();
  for (const f of planFiles) {
    const folder = destinationFolderFor(f, rule);
    movesByFolder.set(folder, (movesByFolder.get(folder) ?? 0) + 1);
  }
  const rankedFolders = [...movesByFolder.entries()].sort((a, b) => b[1] - a[1]);
  const moves_by_folder: Record<string, number> = {};
  for (const [folder, n] of rankedFolders.slice(0, SAMPLE.planFolders)) {
    moves_by_folder[folder] = n;
  }

  const organize_plan =
    v.path === "/"
      ? {
          rule,
          applicable: false,
          // organize_files refuses "/" outright, so a plan for it could never
          // be applied. Saying that beats handing over an approvable-looking
          // plan the very next call rejects.
          note: "organize_files does not act on the top-level folder. Analyze a specific folder such as /Downloads to get an applicable plan.",
        }
      : {
          rule,
          applicable: true,
          files_to_move: planFiles.length,
          moves_by_folder,
          folders_shown: Object.keys(moves_by_folder).length,
          folders_total: rankedFolders.length,
          ...(planFiles.length > ORGANIZE_MAX_MOVES
            ? { note_partial: `organize_files moves up to ${ORGANIZE_MAX_MOVES} files per call, so this needs more than one run.` }
            : {}),
          note: "Only files directly inside this folder move; subfolders and hidden files stay put. Apply with organize_files.",
        };

  // A result the outage could explain must not read as a clean drive.
  const nothingFound = walk.entries.length === 0;
  const someFolderRead = walk.emptyDirectories.length > 0;

  return {
    ok: true,
    data: {
      path: v.path,
      scanned: {
        files: files.length,
        directories,
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
        size_human: humanBytes(staleBytes),
        shown: Math.min(stale.length, SAMPLE.stale),
        items: stale
          .slice(0, SAMPLE.stale)
          .map((f) => ({ path: f.path, modified_at: f.modifiedAt.slice(0, 10) })),
      },
      junk: {
        count: junk.length,
        size_human: humanBytes(junkBytes),
        shown: Math.min(junk.length, SAMPLE.junk),
        items: junk.slice(0, SAMPLE.junk).map((j) => ({ path: j.path, reason: j.reason })),
      },
      duplicate_candidates: {
        groups: duplicates.length,
        reclaimable_human: humanBytes(reclaimable),
        shown: Math.min(duplicates.length, SAMPLE.duplicateGroups),
        items: duplicates.slice(0, SAMPLE.duplicateGroups).map((g) => ({
          size_human: humanBytes(g.size),
          keep: g.keep,
          delete_candidates: g.duplicates.slice(0, SAMPLE.duplicatePaths),
          copies: g.duplicates.length + 1,
        })),
        note: "Matched by name and size, not by content. `keep` is the copy to keep; the reclaimable figure assumes only the delete_candidates go. Confirm with the user before deleting any copy.",
      },
      empty_directories: {
        count: walk.emptyDirectories.length,
        shown: Math.min(walk.emptyDirectories.length, SAMPLE.empty),
        items: walk.emptyDirectories.slice(0, SAMPLE.empty),
        note: "Listed as empty, which is not proof — a folder that failed to read looks the same. delete_files will not remove folders; they are removed from the Files app.",
      },
      organize_plan,
      unreadable_directories: walk.errors,
      ...(nothingFound || someFolderRead ? { caveat: DEGRADED_LISTING_CAVEAT } : {}),
    },
  };
}

/** Parent of a posix path, without pulling in node:path for one call. */
function parentOf(p: string): string {
  const i = p.lastIndexOf("/");
  if (i <= 0) return "/";
  return p.slice(0, i);
}

const tool: Tool = {
  name: "analyze_file_cleanup",
  description:
    "Read-only cleanup report for a folder: totals by category, largest files, stale files, junk (temp, lock and thumbnail files), duplicate candidates (each naming the copy to keep), empty subfolders, and what organize_files would do. Lists are samples with shown/of counts; the totals are exact. Run this first and show the user what it found, then use organize_files or delete_files for the parts they approve.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
