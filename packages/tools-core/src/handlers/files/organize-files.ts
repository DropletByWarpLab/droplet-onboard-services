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
 *
 * ## Destination paths are re-validated, not trusted
 *
 * Caller-supplied paths go through `validateNcPath`; the DESTINATIONS this
 * handler builds are a second class of input, assembled from filenames the
 * LISTING supplied. Today's producer cannot emit a separator in a name
 * (`parseMultiStatus` takes the last path segment), so nothing hostile gets
 * through — but that is a property of a file two packages away, and an
 * invariant that holds only because of the current producer is the P11
 * anti-pattern in `droplet-pr-review-patterns`. Every destination is
 * therefore validated at the same chokepoint, immediately before the move,
 * so no path reaches the files API unchecked regardless of where it came from.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { validateNcPath } from "./_paths.js";
import { ncHeaders } from "./_render.js";
import {
  DEGRADED_LISTING_CAVEAT,
  FILE_AUTH_REQUIRED_MESSAGE,
  ORGANIZE_MAX_MOVES,
  ORGANIZE_RULES,
  isOrganizeRule,
  planOrganize,
  readListing,
  unlessAborted,
} from "./_cleanup.js";

/** Per-list caps on the result, so a 500-move run cannot blow the 8,000-char
 *  tool-result ceiling. Counts stay exact. */
const RESULT_SAMPLE = { moved: 20, skipped: 20 } as const;

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

  const headers = ncHeaders(ctx);
  const listed = await unlessAborted(ctx.signal, () =>
    ctx.http.nextcloud.get(`/?path=${encodeURIComponent(v.path)}`, { headers, signal: ctx.signal }),
  );
  if (!listed) return err("CANCELLED", "the request was cancelled before the folder was read");
  const listing = await readListing(listed);
  if (listing.status === 404) return err("NOT_FOUND", `folder not found: ${v.path}`);
  if (!listing.ok) return err("LIST_FAILED", `nextcloud returned ${listing.status}`);
  const entries = listing.entries;
  const plan = planOrganize(v.path, entries, rule, ORGANIZE_MAX_MOVES);

  // Destinations that already exist as a direct child, so `created_folders`
  // reports what this call actually made. `POST /files/mkdir` answers 200
  // either way — `ncCreateDirectory` treats WebDAV MKCOL 405 ("exists") as
  // success — so `mk.ok` alone cannot tell the two apart.
  const existingChildren = new Set(entries.filter((e) => e.isDirectory).map((e) => e.path));
  const collidesWithFile = new Set(entries.filter((e) => !e.isDirectory).map((e) => e.path));

  const created: string[] = [];
  const moved: Array<{ from: string; to: string }> = [];
  const skipped = [...plan.skipped];
  let movedCount = 0;
  let aborted = false;
  /**
   * Planned moves this call never got to, because it was cancelled. NOT the
   * same as skipped: a skipped file has a stated reason and no later run will
   * pick it up, so folding the two together would report a permanently
   * blocked file as "a second run will handle it".
   */
  let unattempted = 0;

  for (const folder of plan.folders) {
    if (ctx.signal.aborted) {
      aborted = true;
      break;
    }
    // A FILE already sitting where a destination folder needs to be: mkdir
    // would fail and every move into it would too. Report it once, here,
    // instead of once per file.
    if (collidesWithFile.has(folder)) {
      skipped.push({
        path: folder,
        reason: "a file already has this name, so the destination folder cannot be created",
      });
      continue;
    }
    const mk = await unlessAborted(ctx.signal, () =>
      ctx.http.nextcloud.post("/mkdir", { path: folder }, { headers, signal: ctx.signal }),
    );
    if (!mk) {
      aborted = true;
      break;
    }
    // Not fatal: the folder usually already exists on a re-run. A folder
    // that is truly missing fails the move into it, reported per file.
    if (mk.ok && !existingChildren.has(folder)) created.push(folder);
  }

  if (aborted) {
    unattempted = plan.moves.length;
  } else {
    for (let i = 0; i < plan.moves.length; i++) {
      const move = plan.moves[i];
      if (ctx.signal.aborted) {
        aborted = true;
        unattempted = plan.moves.length - i;
        break;
      }
      // P11 chokepoint: the destination was BUILT here, so it is validated
      // here, next to the call that uses it.
      const dest = validateNcPath(move.to);
      if (!dest.ok || dest.path !== move.to) {
        skipped.push({ path: move.from, reason: `unsafe destination path (${dest.ok ? "normalized away" : dest.error})` });
        continue;
      }
      if (collidesWithFile.has(move.folder)) {
        // The destination is blocked by a same-named FILE (reported once
        // above). Say so per file rather than letting them fall into
        // `remaining`, which would read as "a later run will pick these up"
        // when in fact nothing will until the collision is resolved.
        skipped.push({
          path: move.from,
          reason: `destination ${move.folder} is blocked by a file of the same name`,
        });
        continue;
      }
      const res = await unlessAborted(ctx.signal, () =>
        ctx.http.nextcloud.post(
          "/move",
          { from: move.from, to: dest.path, overwrite: false },
          { headers, signal: ctx.signal },
        ),
      );
      if (!res) {
        // Cut short mid-flight: the file is in one of the two places, and
        // this layer cannot say which — so it is neither moved nor remaining.
        aborted = true;
        unattempted = plan.moves.length - i - 1;
        skipped.push({
          path: move.from,
          reason: "cancelled while the move was in flight; it may or may not have moved — check both folders",
        });
        break;
      }
      if (res.ok) {
        movedCount++;
        if (moved.length < RESULT_SAMPLE.moved) moved.push({ from: move.from, to: dest.path });
      } else {
        skipped.push({
          path: move.from,
          reason: `move failed (nextcloud returned ${res.status}); the destination may already hold a file with that name`,
        });
      }
    }
  }

  const remaining = plan.remaining + unattempted;
  const hadNothingToMove = plan.moves.length === 0;
  return {
    ok: true,
    data: {
      path: v.path,
      rule,
      moved_count: movedCount,
      moved_shown: moved.length,
      moved,
      created_folders: created,
      skipped_count: skipped.length,
      skipped: skipped.slice(0, RESULT_SAMPLE.skipped),
      remaining,
      ...(aborted ? { cancelled: true } : {}),
      note: noteFor({ hadNothingToMove, movedCount, aborted, hiddenSkipped: plan.skipped.length }),
      // An empty listing is equally consistent with an outage, so "nothing
      // to organize" must not be reported as a tidy folder.
      ...(listing.possiblyDegraded ? { caveat: DEGRADED_LISTING_CAVEAT } : {}),
    },
  };
}

function noteFor(o: {
  hadNothingToMove: boolean;
  movedCount: number;
  aborted: boolean;
  hiddenSkipped: number;
}): string {
  if (o.aborted) {
    return "Cancelled partway. What moved is listed; nothing was deleted, and move_file puts any of it back.";
  }
  if (o.hadNothingToMove) {
    return o.hiddenSkipped > 0
      ? "Nothing to organize: the only files directly inside this folder are hidden ones, which are left alone."
      : "Nothing to organize: no files sit directly inside this folder.";
  }
  if (o.movedCount === 0) {
    return "Nothing moved — every file was skipped; see the reasons. Nothing was deleted.";
  }
  return "Files were moved, not copied, and nothing was deleted; move_file puts any of them back.";
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
