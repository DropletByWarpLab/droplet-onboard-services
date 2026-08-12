/**
 * WARP-304 — server-side persistence for the /chat page.
 *
 * The pre-WARP-104 design had ai-gateway own a separate "sessions" CRUD
 * (which the legacy `/llm/sessions/*` routes still proxy to). That layer is
 * the wrong place because:
 *   - The agent loop runs on the orchestrator, so tool-call metadata only
 *     ever exists here.
 *   - Per-user RBAC is enforced by the orchestrator auth middleware.
 *   - The local Postgres is the source of truth for everything else on
 *     the device — keeping chats here means one backup story, one schema.
 *
 * This service uses the local `ChatSession` / `ChatMessage` Prisma models.
 * The legacy `/llm/sessions/*` routes will be retired in WARP-311.
 */
import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";

/**
 * Title length cap. Titles auto-generate from the first user message; we
 * truncate to fit a sensible width in the sidebar without storing the whole
 * prompt twice (the message itself is the source of truth).
 */
const TITLE_MAX_LEN = 64;

export interface PersistedToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  ok?: boolean;
  status?: string;
  message?: string;
  data?: unknown;
  /**
   * WARP-640 — the one-click re-issue handle for a confirmation the chat chip
   * can complete itself (e.g. `run_scene`). Persisted so that reloading a
   * conversation while a chip is still in `confirmation_required` keeps the
   * "Approve & run" button. A `confirmation_required` result carries the token
   * on this field, NOT on `data`, so it has to be persisted explicitly. The
   * single-use token is allowed to round-trip: it stays valid server-side for
   * its TTL, and a consumed/expired token is rejected with 403 by
   * `approveScene`, so replay-on-reload is safe. (review #497)
   */
  confirmation?: {
    kind: string;
    sceneId?: string;
    confirmationToken: string;
  };
}

export interface PersistedMessageInput {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: PersistedToolCall[] | null;
  toolCallId?: string | null;
  /**
   * Client-supplied idempotency key. If a row already exists for this
   * `(sessionId, turnId)` the insert is skipped — protects against double
   * submits when the user retries a transient network failure.
   */
  turnId?: string | null;
}

export interface PersistedConversationSummary {
  id: string;
  title: string | null;
  model: string | null;
  provider: string | null;
  /** WARP-845 — owning project, or null when ungrouped. */
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PersistedConversationDetail extends PersistedConversationSummary {
  /** WARP-844 — persisted caller system prompt, or null. */
  systemPrompt: string | null;
  messages: Array<{
    id: string;
    role: string;
    content: string;
    toolCalls: PersistedToolCall[] | null;
    toolCallId: string | null;
    turnId: string | null;
    status: "pending" | "streaming" | "completed" | "failed" | "aborted";
    createdAt: string;
    /**
     * WARP-458 — concatenated deep-reasoning trace for this assistant
     * message, or `null` when the model produced no reasoning (the
     * overwhelming majority of pre-WARP-458 historical rows). The
     * dashboard renders this as a collapsible "thinking" timeline above
     * the visible content.
     */
    reasoning: string | null;
    /** WARP-844 — thumbs rating, or null when unrated. */
    feedback: "up" | "down" | null;
    /**
     * WARP-904 — the model/provider actually used for THIS turn (may
     * differ from `ChatSession.model`/`provider` once the user has
     * quick-switched mid-conversation). NULL on rows persisted before
     * this column existed, or when the caller never supplied one.
     */
    model: string | null;
    provider: string | null;
  }>;
}

function deriveTitle(firstUserContent: string): string {
  const trimmed = firstUserContent.trim().replace(/\s+/g, " ");
  if (trimmed.length <= TITLE_MAX_LEN) return trimmed;
  // Cut at the last word boundary inside the budget so we don't slice
  // mid-word; fall back to a hard cut if the prompt has no spaces.
  const slice = trimmed.slice(0, TITLE_MAX_LEN);
  const lastSpace = slice.lastIndexOf(" ");
  return (lastSpace > TITLE_MAX_LEN / 2 ? slice.slice(0, lastSpace) : slice) + "…";
}

export class ChatPersistenceService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Look up an existing conversation by id, scoped to the calling user.
   * Returns `null` if the conversation does not exist OR belongs to another
   * user — callers must not distinguish these cases (avoids id-enumeration).
   */
  async getConversationForUser(
    conversationId: string,
    userId: string,
  ): Promise<PersistedConversationDetail | null> {
    const row = await this.prisma.chatSession.findFirst({
      where: { id: conversationId, userId },
      include: {
        messages: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
      },
    });
    if (!row) return null;
    return {
      id: row.id,
      title: row.title,
      model: row.model,
      provider: row.provider,
      projectId: row.projectId ?? null,
      systemPrompt: row.systemPrompt,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      messages: row.messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        toolCalls: (m.toolCalls as unknown as PersistedToolCall[] | null) ?? null,
        toolCallId: m.toolCallId,
        turnId: m.turnId,
        status: m.status as "pending" | "streaming" | "completed" | "failed" | "aborted",
        createdAt: m.createdAt.toISOString(),
        // WARP-458 — surface the reasoning trace on rehydrate so the
        // dashboard's chat surface can render the "thinking" timeline
        // without re-running inference. `null` when the model produced
        // no reasoning on this turn.
        reasoning: m.reasoning ?? null,
        // WARP-844 — thumbs rating, restored so the toolbar shows state.
        feedback: (m.feedback as "up" | "down" | null) ?? null,
        // WARP-904 — per-message audit trail (see PersistedConversationDetail).
        model: m.model ?? null,
        provider: m.provider ?? null,
      })),
    };
  }

  /**
   * WARP-1921 — the distinct tool names already used in a conversation, for
   * the agent-budgets §3 CONTINUITY rule ("the domains of any tools already
   * called earlier in the conversation stay advertised").
   *
   * Why this exists rather than reading `tool_calls` off the replayed
   * messages: `chatRequestSchema` declares only `{role, content,
   * tool_call_id}`, so zod strips `tool_calls` from every replayed assistant
   * turn. Continuity therefore only ever worked WITHIN a single turn's
   * iterations — never across HTTP requests — which is the exact prerequisite
   * the spec's §6 outcome named before `TOOL_SELECTION_MODE` could flip.
   *
   * Reading the persisted trace rather than trusting the request body is
   * deliberate: the client cannot claim to have used a tool it never used.
   * That matters less than it sounds (selection only ever SUBSETS the
   * RBAC-narrowed pool, so a lie could never widen reach past the user's own
   * permissions) but a server-authoritative answer costs nothing extra here
   * and removes the question entirely.
   *
   * Deliberately NOT `getConversationForUser`: that loads every message and
   * its full content to answer a question about a handful of names. This
   * selects one nullable JSON column off the `(sessionId, createdAt)` index.
   *
   * Scoped by `userId` via the session relation, so a guessed conversation id
   * from another household member reveals nothing — same rule as
   * `getConversationForUser`. Returns `[]` for unknown/foreign ids rather
   * than throwing: continuity is an optimisation, and a turn must never fail
   * because we could not enrich it.
   */
  async getConversationToolNames(
    conversationId: string,
    userId: string,
  ): Promise<string[]> {
    const rows = await this.prisma.chatMessage.findMany({
      where: {
        sessionId: conversationId,
        session: { userId },
        role: "assistant",
        // Prisma's canonical "JSON column is not SQL NULL" filter.
        toolCalls: { not: Prisma.DbNull },
      },
      select: { toolCalls: true },
      orderBy: { createdAt: "desc" },
      // A conversation only has so many distinct domains; the most recent
      // turns are the ones continuity is for. Bounds the read on a long thread.
      take: 50,
    });
    const names = new Set<string>();
    for (const row of rows) {
      const calls = row.toolCalls as unknown as PersistedToolCall[] | null;
      if (!Array.isArray(calls)) continue;
      for (const c of calls) {
        if (c && typeof c.name === "string" && c.name.length > 0) names.add(c.name);
      }
    }
    return [...names];
  }

  /**
   * List a user's conversations newest-first. Used by the dashboard sidebar
   * (when reintroduced) and any future "resume" flow.
   */
  async listConversationsForUser(
    userId: string,
    limit: number,
    offset: number,
    /** WARP-844 — optional search needle. Matches the session title OR
     *  any message's content, case-insensitively. Whitespace-only is
     *  treated as absent (back-compat unfiltered list). */
    q?: string,
    /** WARP-845 — restrict to one project's chats (the sidebar fetches a
     *  folder's full contents on expand, independent of the main list's
     *  pagination window). */
    projectId?: string,
  ): Promise<PersistedConversationSummary[]> {
    const search = q?.trim();
    const rows = await this.prisma.chatSession.findMany({
      where: {
        userId,
        ...(projectId ? { projectId } : {}),
        ...(search
          ? {
              OR: [
                { title: { contains: search, mode: "insensitive" as const } },
                {
                  messages: {
                    some: {
                      content: {
                        contains: search,
                        mode: "insensitive" as const,
                      },
                    },
                  },
                },
              ],
            }
          : {}),
      },
      orderBy: { updatedAt: "desc" },
      take: Math.min(Math.max(limit, 1), 100),
      skip: Math.max(offset, 0),
    });
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      model: r.model,
      provider: r.provider,
      projectId: r.projectId ?? null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  /**
   * WARP-844 — truncate a conversation from a message onward (the message
   * itself plus everything after it, in the same `createdAt, id` order
   * the GET endpoint renders). Backs the dashboard's edit-and-resend:
   * the client truncates server-side BEFORE re-sending the edited
   * prompt, so the persisted thread never diverges from what the user
   * sees.
   *
   * Returns the number of deleted rows, or null when the conversation
   * isn't owned by the user or the message isn't in it (no existence
   * leak — callers 404 both cases identically).
   */
  async truncateConversationFromMessage(
    conversationId: string,
    userId: string,
    messageId: string,
  ): Promise<number | "not_found" | "in_flight"> {
    const session = await this.prisma.chatSession.findFirst({
      where: { id: conversationId, userId },
    });
    if (!session) return "not_found";
    // Fetch ids in render order and slice from the target onward. The
    // slice alone is NOT sufficient: createdAt ties within a turn (user
    // + assistant rows are written in one transaction at TIMESTAMP(3)
    // precision) and the `id asc` tiebreak is over random uuids, so the
    // edited user row's assistant sibling can sort BEFORE it and survive
    // the slice (reproduced ~1 in 3 turns on Postgres 16). Same-turn rows
    // are one logical unit — extend the doomed set with every row sharing
    // the target's turnId.
    const ordered = await this.prisma.chatMessage.findMany({
      where: { sessionId: conversationId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, turnId: true, status: true },
    });
    const idx = ordered.findIndex((m) => m.id === messageId);
    if (idx === -1) return "not_found";
    const doomed = new Set(ordered.slice(idx).map((m) => m.id));
    const targetTurnId = ordered[idx]!.turnId;
    if (targetTurnId) {
      for (const m of ordered) {
        if (m.turnId === targetTurnId) doomed.add(m.id);
      }
    }
    // Refuse while any doomed row is mid-stream (a second tab/device can
    // edit a conversation whose turn is streaming in another tab — the
    // same-tab edit affordance is gated client-side only). Deleting the
    // row out from under the agent loop leaves the streaming tab showing
    // a reply the server discarded and publishes turn-completed for a
    // dead messageId. The route maps this to 409.
    if (ordered.some((m) => doomed.has(m.id) && m.status === "streaming")) {
      return "in_flight";
    }
    const r = await this.prisma.chatMessage.deleteMany({
      where: { id: { in: Array.from(doomed) }, sessionId: conversationId },
    });
    return r.count;
  }

  /**
   * WARP-844 — set (or clear, with null) the thumbs rating on a message.
   * Ownership is enforced through the session row; returns false for
   * cross-user or unknown targets (callers 404 both identically).
   */
  async setMessageFeedback(
    conversationId: string,
    userId: string,
    messageId: string,
    feedback: "up" | "down" | null,
  ): Promise<boolean> {
    const session = await this.prisma.chatSession.findFirst({
      where: { id: conversationId, userId },
      select: { id: true },
    });
    if (!session) return false;
    const r = await this.prisma.chatMessage.updateMany({
      // role-gated: only assistant turns are ratable — a rated user row
      // would inflate the admin feedback counts while never being
      // listable (the admin surface pairs assistant turns with prompts).
      where: { id: messageId, sessionId: conversationId, role: "assistant" },
      data: { feedback },
    });
    return r.count > 0;
  }

  /**
   * WARP-845 — move a conversation into (or out of, with null) one of
   * the user's projects. Returns false when the conversation isn't
   * owned by the caller or the target project isn't theirs.
   */
  async setConversationProject(
    conversationId: string,
    userId: string,
    projectId: string | null,
  ): Promise<boolean> {
    if (projectId) {
      const project = await this.prisma.chatProject.findFirst({
        where: { id: projectId, userId },
        select: { id: true },
      });
      if (!project) return false;
    }
    const r = await this.prisma.chatSession.updateMany({
      where: { id: conversationId, userId },
      data: { projectId },
    });
    return r.count > 0;
  }

  /** Delete a conversation owned by the user. No-op when it doesn't exist. */
  async deleteConversationForUser(
    conversationId: string,
    userId: string,
  ): Promise<boolean> {
    const result = await this.prisma.chatSession.deleteMany({
      where: { id: conversationId, userId },
    });
    return result.count > 0;
  }

  /**
   * Rename a conversation owned by the user. Trims and clamps to
   * `TITLE_MAX_LEN` to match the auto-derived title cap. Returns the
   * final stored title, or `null` if no row matched the (id, userId)
   * pair (other user, or doesn't exist — callers map both to 404).
   *
   * Uses raw SQL deliberately: `ChatSession.updatedAt` carries Prisma's
   * `@updatedAt` decorator, which would auto-bump the column on any
   * `chatSession.update()` call. Rename is a metadata edit — we don't
   * want the renamed chat jumping to the top of the sidebar. New-
   * activity recency comes from sends, not from typing in the title.
   * The single UPDATE is also atomic, closing the read-modify race
   * the prior findFirst → update pattern had.
   */
  async renameConversationForUser(
    conversationId: string,
    userId: string,
    rawTitle: string,
  ): Promise<string | null> {
    const trimmed = rawTitle.trim();
    if (trimmed.length === 0) {
      throw new Error("title_required");
    }
    const next = trimmed.slice(0, TITLE_MAX_LEN);
    const rowsAffected = await this.prisma.$executeRaw`
      UPDATE "ChatSession"
      SET title = ${next}
      WHERE id = ${conversationId} AND "userId" = ${userId}
    `;
    return rowsAffected > 0 ? next : null;
  }

  /**
   * Resolve (find or create) the conversation a turn belongs to. The first
   * user message of a brand-new conversation seeds the title. Returns the
   * row so the route can include the id in the response.
   */
  async ensureConversation(args: {
    conversationId: string | null | undefined;
    userId: string;
    model: string;
    provider?: string | null;
    firstUserContent: string | null;
    /** WARP-844 — the caller's system message for this turn (latest
     *  wins; null clears). `undefined` leaves the stored value alone so
     *  callers that don't track prompts can't accidentally wipe it. */
    systemPrompt?: string | null;
    /** WARP-845 — project to file a NEWLY-created conversation under.
     *  Ownership-validated here (the project must belong to the same
     *  user; anything else is silently ignored). Existing conversations
     *  are never moved by a chat turn — membership changes go through
     *  the conversation PATCH. */
    projectId?: string | null;
  }): Promise<{ id: string; created: boolean }> {
    if (args.conversationId) {
      const existing = await this.prisma.chatSession.findFirst({
        where: { id: args.conversationId, userId: args.userId },
        select: { id: true, systemPrompt: true },
      });
      if (existing) {
        if (
          args.systemPrompt !== undefined &&
          existing.systemPrompt !== args.systemPrompt
        ) {
          await this.prisma.chatSession.update({
            where: { id: existing.id },
            data: { systemPrompt: args.systemPrompt },
          });
        }
        return { id: existing.id, created: false };
      }
      // The client sent an id we don't own (different user, deleted, or
      // forged). Don't trust it — start a fresh conversation. Returning
      // 404 would also be acceptable but silently rolling forward keeps
      // the chat surface from going blank in the face of a stale URL.
    }
    const title = args.firstUserContent ? deriveTitle(args.firstUserContent) : null;
    // WARP-845: only stamp a project the caller actually owns.
    let projectId: string | null = null;
    if (args.projectId) {
      const project = await this.prisma.chatProject.findFirst({
        where: { id: args.projectId, userId: args.userId },
        select: { id: true },
      });
      projectId = project?.id ?? null;
    }
    const created = await this.prisma.chatSession.create({
      data: {
        userId: args.userId,
        title,
        model: args.model,
        provider: args.provider ?? null,
        systemPrompt: args.systemPrompt ?? null,
        projectId,
      },
      select: { id: true },
    });
    return { id: created.id, created: true };
  }

  /**
   * WARP-329: persist the user message + assistant placeholder for one turn
   * BEFORE the agent loop runs. The user message lands as `status=completed`
   * (it's already final the moment the route receives it); the assistant
   * message lands as `status=streaming` with empty content, ready to be
   * updated as SSE deltas arrive.
   *
   * Idempotency: if a row with the same `(sessionId, turnId, role)` already
   * exists (client retried the same turn), we return the existing IDs and
   * skip the insert. Callers MUST handle the "this turn already finalized"
   * case — if the assistant row is already `completed`, it's safe to no-op
   * the entire route.
   *
   * Returns the row IDs so the route can:
   *   - put `X-Assistant-Message-Id` on the response header (lets the
   *     client tie the in-flight stream to a persisted row), and
   *   - reference the assistant ID for streaming updates + final flush.
   */
  async createTurnRows(args: {
    conversationId: string;
    userContent: string;
    turnId: string | null;
    /**
     * WARP-904 — the model/provider the user had selected when they sent
     * this turn. Stamped onto BOTH rows at creation time; the assistant
     * row's may be overwritten at {@link finalizeAssistantMessage} if
     * vision auto-routing changed the model that actually ran. Optional
     * so existing callers (tests, any future caller that doesn't track
     * model per turn) keep working — omitted means both columns stay
     * NULL, exactly like before this column existed.
     */
    model?: string;
    provider?: string | null;
  }): Promise<{
    userMessageId: string;
    assistantMessageId: string;
    assistantAlreadyFinal: boolean;
  }> {
    return this.prisma.$transaction(async (tx) => {
      const findRow = async (role: "user" | "assistant") =>
        args.turnId
          ? tx.chatMessage.findFirst({
              where: {
                sessionId: args.conversationId,
                turnId: args.turnId,
                role,
              },
              select: { id: true, status: true },
            })
          : null;

      const existingUser = await findRow("user");
      const userRow =
        existingUser ??
        (await tx.chatMessage.create({
          data: {
            sessionId: args.conversationId,
            role: "user",
            content: args.userContent,
            turnId: args.turnId,
            status: "completed",
            completedAt: new Date(),
            model: args.model ?? null,
            provider: args.provider ?? null,
          },
          select: { id: true, status: true },
        }));

      const existingAssistant = await findRow("assistant");
      const assistantRow =
        existingAssistant ??
        (await tx.chatMessage.create({
          data: {
            sessionId: args.conversationId,
            role: "assistant",
            content: "",
            turnId: args.turnId,
            status: "streaming",
            model: args.model ?? null,
            provider: args.provider ?? null,
          },
          select: { id: true, status: true },
        }));

      await tx.chatSession.update({
        where: { id: args.conversationId },
        data: { updatedAt: new Date() },
      });

      return {
        userMessageId: userRow.id,
        assistantMessageId: assistantRow.id,
        assistantAlreadyFinal:
          assistantRow.status === "completed" ||
          assistantRow.status === "failed" ||
          assistantRow.status === "aborted",
      };
    });
  }

  /**
   * WARP-329: flush the current accumulated content of a streaming
   * assistant row. Called on a debounced timer from the chat route so a
   * mid-turn refresh sees up-to-date content without thrashing Postgres.
   *
   * Only updates `content`; leaves `status` alone. Use
   * {@link finalizeAssistantMessage} for the terminal transition.
   */
  async updateAssistantStreaming(
    messageId: string,
    content: string,
  ): Promise<void> {
    await this.prisma.chatMessage.update({
      where: { id: messageId },
      data: { content },
    });
  }

  /**
   * WARP-329: terminal write for an assistant turn. Locks the final
   * `content` + `toolCalls` and flips `status` + `completedAt`.
   *
   * Also bumps `updatedAt` on the session so a sidebar sorted by recency
   * surfaces the freshly-completed thread.
   *
   * WARP-458: `reasoning` (optional) carries the concatenated
   * `<reasoning>…</reasoning>` trace + provider-native reasoning field
   * the agent loop extracted from the model's output. ALWAYS persisted
   * when present, regardless of the route's `captureReasoning` flag —
   * the flag gates emission on the SSE wire, not durability. Passing
   * `null` clears the column (the model on this turn produced no
   * reasoning); passing `undefined` is a no-op (leave whatever's there).
   */
  async finalizeAssistantMessage(args: {
    conversationId: string;
    messageId: string;
    content: string;
    toolCalls: PersistedToolCall[];
    status: "completed" | "failed" | "aborted";
    reasoning?: string | null;
    /**
     * WARP-904 — the model/provider that actually produced this turn.
     * Overwrites the tentative value {@link createTurnRows} stamped at
     * turn start, which matters when vision auto-routing swapped in a
     * different model mid-turn. Same undefined-skip contract as
     * `reasoning`: omit to leave whatever createTurnRows already set.
     */
    model?: string;
    provider?: string | null;
  }): Promise<void> {
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const data: Prisma.ChatMessageUpdateInput = {
        content: args.content,
        // Prisma's Json column accepts arrays via InputJsonValue but its
        // inferred type doesn't surface the array shape — cast through
        // `unknown` so the array literal flows through.
        toolCalls:
          args.toolCalls.length > 0
            ? (args.toolCalls as unknown as Prisma.InputJsonValue)
            : Prisma.JsonNull,
        status: args.status,
        completedAt: now,
      };
      // WARP-458: only touch the reasoning column when the caller
      // supplied a value (or explicit null to clear). `undefined`
      // means "leave it alone" — important when a retried turn lands
      // on an already-persisted row.
      if (args.reasoning !== undefined) {
        data.reasoning = args.reasoning;
      }
      // WARP-904: same undefined-skip contract for the audit columns.
      if (args.model !== undefined) {
        data.model = args.model;
      }
      if (args.provider !== undefined) {
        data.provider = args.provider;
      }
      await tx.chatMessage.update({
        where: { id: args.messageId },
        data,
      });
      await tx.chatSession.update({
        where: { id: args.conversationId },
        data: { updatedAt: now },
      });
    });
  }

  /**
   * Append one or more messages to an existing conversation. Honors the
   * client-supplied turnId for idempotency: if a row already exists with
   * the same (sessionId, turnId, role), the duplicate is skipped.
   *
   * Bumps `updatedAt` on the session so the sidebar can sort by recency.
   */
  async appendMessages(
    conversationId: string,
    messages: PersistedMessageInput[],
  ): Promise<void> {
    if (messages.length === 0) return;
    await this.prisma.$transaction(async (tx) => {
      for (const m of messages) {
        if (m.turnId) {
          const dup = await tx.chatMessage.findFirst({
            where: { sessionId: conversationId, turnId: m.turnId, role: m.role },
            select: { id: true },
          });
          if (dup) continue;
        }
        await tx.chatMessage.create({
          data: {
            sessionId: conversationId,
            role: m.role,
            content: m.content,
            // Prisma's Json column accepts arrays via InputJsonValue but
            // its inferred type doesn't surface the array shape — cast
            // through `unknown` so the array literal flows through.
            toolCalls:
              m.toolCalls != null
                ? (m.toolCalls as unknown as Prisma.InputJsonValue)
                : Prisma.JsonNull,
            toolCallId: m.toolCallId ?? null,
            turnId: m.turnId ?? null,
          },
        });
      }
      // Bump updatedAt explicitly — Prisma's @updatedAt only fires on
      // an actual ChatSession update, not when child rows are inserted.
      await tx.chatSession.update({
        where: { id: conversationId },
        data: { updatedAt: new Date() },
      });
    });
  }
}
