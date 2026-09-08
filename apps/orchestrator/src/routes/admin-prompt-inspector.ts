/**
 * WARP-2823 (ADR-002 admin console, slice 3) — two read-only endpoints that
 * show an admin what one person's assistant is actually handed.
 *
 * `GET /api/admin/prompt-inspect/:userId` — the assembled system prompt, block
 * by block, with each block's size, its budget, and whether the composer that
 * produces it threw.
 *
 * `GET /api/admin/tool-inspect/:userId` — one row per registered tool, with the
 * gate that withheld it and every other gate that would have.
 *
 * ── Read-only in the strong sense ──────────────────────────────────────────
 *
 * Neither endpoint takes an action, changes a grant, or touches the target's
 * session. They are also read-only about the ANSWER: every verdict comes from
 * importing the shipped predicate and calling it, never from a rule restated
 * here. See the two services for why that matters.
 *
 * ── Why the audit row is written AFTER the response ────────────────────────
 *
 * Reading somebody else's assembled prompt is a privileged look at their
 * working context, and it should leave a trace — WARP-2785 filed exactly this
 * defect against the audit export ("exporting the audit log leaves no trace in
 * the audit log"). But the trace must never be able to fail the read: the
 * precedent is `routes/logs.ts:188`, where the bundle is finalized first and
 * the row is written detached, because a slow database must not stall the
 * thing the admin asked for.
 *
 * Ids and counts only. Never a block's text, never a tool list — the prompt
 * can carry business context and durable memory facts, and an audit row that
 * copied them would put the content this endpoint exists to inspect into a
 * second table with a different retention story.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import type { PrismaClient } from "@prisma/client";

import { requireRole } from "../middleware/auth.js";
import { recordActivity } from "../services/activity.singleton.js";
import { actorFromRequest } from "../services/activity.service.js";
import { createLogger } from "../lib/logger.js";
import { inspectToolsForPerson } from "../services/tool-inspect.service.js";
import { inspectPromptForPerson } from "../services/prompt-inspect.service.js";

const logger = createLogger("admin-prompt-inspector");

/** `?flag=1` / `?flag=true`. Anything else, including absent, is false. */
function flag(req: Request, name: string): boolean {
  const v = req.query[name];
  return v === "1" || v === "true";
}

function messageOf(req: Request): string {
  const v = req.query.message;
  return typeof v === "string" ? v : "";
}

export function createAdminPromptInspectorRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get(
    "/admin/tool-inspect/:userId",
    requireRole("owner", "admin"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const result = await inspectToolsForPerson(prisma, {
          targetUserId: req.params.userId,
          message: messageOf(req),
          offLan: flag(req, "offLan"),
          interview: flag(req, "interview"),
          voice: flag(req, "voice"),
        });
        res.json(result);

        void recordActivity({
          kind: "system",
          severity: "info",
          sourceIcon: "shield",
          what: "Assistant tool reach inspected",
          sub: `${result.counts.advertised} of ${result.counts.registered} reach the model`,
          actor: actorFromRequest(req),
          refs: {
            by: req.user?.id ?? null,
            target: req.params.userId,
            advertised: result.counts.advertised,
            withheld: result.counts.withheld,
            unresolved: result.unresolved,
          },
        }).catch(() => {
          // recordActivity swallows its own failures; this guard exists only
          // so a rejected promise cannot reach the process as unhandled.
        });
      } catch (err) {
        logger.warn({ err, target: req.params.userId }, "tool_inspect_failed");
        next(err);
      }
    },
  );

  router.get(
    "/admin/prompt-inspect/:userId",
    requireRole("owner", "admin"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const offLan = flag(req, "offLan");
        const interview = flag(req, "interview");

        // 🔴 The tool set comes from the tool inspector, not from a second
        // derivation here. `composeToolGuidance` must be handed the tools this
        // person can actually call — naming a stripped tool is what sends a
        // small local model into the WARP-642 hallucinated-tool guard — and
        // the advertised set is exactly that list. Two derivations of one
        // answer is the drift this slice exists to make visible; shipping it
        // inside the slice would be its own punchline.
        const tools = await inspectToolsForPerson(prisma, {
          targetUserId: req.params.userId,
          message: messageOf(req),
          offLan,
          interview,
          voice: flag(req, "voice"),
        });
        // `undefined` is `buildBaseSystemPrompt`'s own encoding for "privileged
        // caller, every tool", and it is what the route passes for an owner. A
        // resolved-but-unnarrowed person must reach the composer as undefined,
        // not as a 139-name list, or the guidance is composed by a different
        // path than the turn's.
        const allowedToolNames =
          tools.unresolved === null && tools.noRoleNarrowing && tools.tier === "owner"
            ? undefined
            : tools.rows.filter((r) => r.advertised).map((r) => r.name);

        const result = await inspectPromptForPerson(prisma, {
          targetUserId: req.params.userId,
          allowedToolNames,
          offLan,
          interview,
        });
        res.json(result);

        void recordActivity({
          kind: "system",
          severity: "info",
          sourceIcon: "shield",
          what: "Assistant prompt inspected",
          sub: `${result.assembledChars} chars${
            result.erroredBlocks.length > 0
              ? ` · ${result.erroredBlocks.length} block(s) failed to compose`
              : ""
          }`,
          actor: actorFromRequest(req),
          refs: {
            by: req.user?.id ?? null,
            target: req.params.userId,
            chars: result.assembledChars,
            erroredBlocks: result.erroredBlocks.length,
            unresolved: result.unresolved,
          },
        }).catch(() => {
          // See above.
        });
      } catch (err) {
        logger.warn({ err, target: req.params.userId }, "prompt_inspect_failed");
        next(err);
      }
    },
  );

  return router;
}
