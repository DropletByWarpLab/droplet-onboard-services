/**
 * WARP-2664 — `organize_files` (Write-tier + confirmation).
 *
 * Sorts the files DIRECTLY inside one folder into subfolders by a rule
 * (`by_type` / `by_extension` / `by_month` / `by_year`). Subfolders and
 * everything in them are left alone — that is what makes a second run a
 * no-op instead of a re-shuffle — and hidden files are skipped.
 *
 * Confirmation is the generic interceptor's (`docs/tool-confirmation-
 * contract.md` §12): the flag on the descriptor is the whole integration,
 * and there is deliberately no `confirmed` boolean in the schema, so the
 * only way through is a token a human minted. The plan the user approves
 * is the one `analyze_file_cleanup` showed them; this handler recomputes
 * it from a FRESH listing at execution time rather than trusting a plan
 * the model carried across turns.
 *
 * Nothing is overwritten: every move is `overwrite: false`, and a
 * destination that already holds the name is reported as skipped. Nothing
 * is deleted. `move_file` puts any single file back.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { validateNcPath } from "./_paths.js";
import {
  FILE_AUTH_REQUIRED_MESSAGE,
  ORGANIZE_MAX_MOVES,
  ORGANIZE_RULES,
  isOrganizeRule,
  parseEntries,
  planOrganize,
} from "./_cleanup.js";

/** Moves echoed back in full; past this only the count grows. */
const RESULT_SAMPLE = 40;

const inputSchema = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "The folder whose files get sorted into subfolders, e.g. /Downloads.",
    },
    rule: {
      type: "string",
      description:
        "by_type (default: Documents, Images, Videos, Audio, Archives, Installers, Other), by_extension, by_month or by_year.",
    },
  },
  required: ["path"],
  additionalProperties: false,
} as const;

function err(code: string, message: string): ToolResult {
  return { ok: false, status: "error", error: { code, message } };
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.userId || !ctx.ncToken) return err("AUTH_REQUIRED", FILE_AUTH_REQUIRED_MESSAGE);
  const v = validateNcPath(args.path);
  if (!v.ok) return err("INVALID_PATH", v.error);
  if (v.path === "/") {
    return err(
      "INVALID_PATH",
      "refusing to organize the top-level folder; pick a folder such as /Downloads",
    );
  }
  const rule = args.rule === undefined ? "by_type" : args.rule;
  if (!isOrganizeRule(rule)) {
    return err("INVALID_ARGS", `rule must be one of: ${ORGANIZE_RULES.join(", ")}`);
  }

  const headers: Record<string, string> = {
    "X-Nextcloud-Token": ctx.ncToken,
    "X-Nextcloud-User": ctx.userId,
  };
  const listing = await ctx.http.nextcloud.get(`/?path=${encodeURIComponent(v.path)}`, {
    headers,
  });
  if (listing.status === 404) return err("NOT_FOUND", `folder not found: ${v.path}`);
  if (!listing.ok) return err("LIST_FAILED", `nextcloud returned ${listing.status}`);
  const entries = parseEntries(await listing.json().catch(() => null));
  const plan = planOrganize(v.path, entries, rule, ORGANIZE_MAX_MOVES);

  const created: string[] = [];
  const moved: Array<{ from: string; to: string }> = [];
  const skipped = [...plan.skipped];
  let movedCount = 0;
  let attempted = 0;

  if (plan.moves.length > 0) {
    for (const folder of plan.folders) {
      if (ctx.signal.aborted) break;
      const mk = await ctx.http.nextcloud.post("/mkdir", { path: folder }, { headers });
      // Not fatal: the folder usually already exists on a re-run. A folder
      // that is truly missing fails the move into it, reported per file.
      if (mk.ok) created.push(folder);
    }
    for (const move of plan.moves) {
      if (ctx.signal.aborted) break;
      attempted++;
      const res = await ctx.http.nextcloud.post(
        "/move",
        { from: move.from, to: move.to, overwrite: false },
        { headers },
      );
      if (res.ok) {
        movedCount++;
        if (moved.length < RESULT_SAMPLE) moved.push({ from: move.from, to: move.to });
      } else {
        skipped.push({
          path: move.from,
          reason: `move failed (nextcloud returned ${res.status}); the destination may already hold a file with that name`,
        });
      }
    }
  }

  const remaining = plan.remaining + (plan.moves.length - attempted);
  return {
    ok: true,
    data: {
      path: v.path,
      rule,
      moved_count: movedCount,
      moved,
      created_folders: created,
      skipped,
      remaining,
      note:
        movedCount === 0 && plan.moves.length === 0
          ? "Nothing to organize: no files directly inside this folder."
          : "Files were moved, not copied, and nothing was deleted; move_file puts any of them back.",
    },
  };
}

const tool: Tool = {
  name: "organize_files",
  description:
    "Sort the files directly inside one folder into subfolders by rule: by_type (Documents, Images, Videos, Audio, Archives, Installers, Other), by_extension, by_month or by_year. Subfolders and hidden files are left alone; a name clash is skipped, never overwritten. Preview with analyze_file_cleanup first. Asks the user for approval.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: true,
  handler,
};

export default tool;
