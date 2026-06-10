/**
 * WARP-844 follow-up — `GET /api/admin/chat-feedback`.
 *
 * Surfaces the thumbs ratings users leave on assistant turns
 * (ChatMessage.feedback) for the admin retrieval-eval loop: real user
 * judgments sit alongside the RAGAS scores on /admin/rag-eval, and
 * thumbs-down turns are the natural seed list for new eval goldens.
 *
 * Privacy posture: this is an ADMIN surface that intentionally crosses
 * the per-user chat boundary (same rationale as the activity feed) —
 * owner/admin only, and only RATED turns are exposed (a rating is an
 * explicit user signal, not passive content). Snippets are bounded.
 */
import { Router, type Request } from "express";
import type { PrismaClient } from "@prisma/client";
import { requireRole } from "../middleware/auth.js";

const SNIPPET_CHARS = 280;
const MAX_LIMIT = 100;

function snippet(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > SNIPPET_CHARS ? `${t.slice(0, SNIPPET_CHARS - 1)}…` : t;
}

export function createAdminChatFeedbackRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get(
    "/admin/chat-feedback",
    requireRole("owner", "admin"),
    async (req: Request, res, next) => {
      try {
        const limit = Math.min(
          Number.parseInt(String(req.query.limit ?? "50"), 10) || 50,
          MAX_LIMIT,
        );
        const feedbackFilter =
          req.query.feedback === "up" || req.query.feedback === "down"
            ? (req.query.feedback as "up" | "down")
            : undefined;

        const [rated, upCount, downCount] = await Promise.all([
          prisma.chatMessage.findMany({
            where: {
              feedback: feedbackFilter ?? { not: null },
              role: "assistant",
            },
            orderBy: { createdAt: "desc" },
            take: limit,
            include: {
              session: { select: { id: true, title: true, model: true } },
            },
          }),
          prisma.chatMessage.count({ where: { feedback: "up" } }),
          prisma.chatMessage.count({ where: { feedback: "down" } }),
        ]);

        // Pair each rated assistant row with its turn's user prompt —
        // that's what makes a thumbs-down actionable as an eval golden.
        const turnKeys = rated
          .filter((m) => m.turnId)
          .map((m) => ({ sessionId: m.sessionId, turnId: m.turnId! }));
        const prompts =
          turnKeys.length > 0
            ? await prisma.chatMessage.findMany({
                where: {
                  role: "user",
                  OR: turnKeys,
                },
                select: { sessionId: true, turnId: true, content: true },
              })
            : [];
        const promptByTurn = new Map(
          prompts.map((p) => [`${p.sessionId}|${p.turnId}`, p.content]),
        );

        res.json({
          counts: { up: upCount, down: downCount },
          items: rated.map((m) => ({
            messageId: m.id,
            conversationId: m.sessionId,
            conversationTitle: m.session?.title ?? null,
            model: m.session?.model ?? null,
            feedback: m.feedback,
            userPrompt: m.turnId
              ? snippet(promptByTurn.get(`${m.sessionId}|${m.turnId}`) ?? "")
              : "",
            answer: snippet(m.content),
            createdAt: m.createdAt.toISOString(),
          })),
        });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
