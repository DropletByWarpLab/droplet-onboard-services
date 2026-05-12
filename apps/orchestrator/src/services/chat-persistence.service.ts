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
  createdAt: string;
  updatedAt: string;
}

export interface PersistedConversationDetail extends PersistedConversationSummary {
  messages: Array<{
    id: string;
    role: string;
    content: string;
    toolCalls: PersistedToolCall[] | null;
    toolCallId: string | null;
    turnId: string | null;
    createdAt: string;
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
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      messages: row.messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        toolCalls: (m.toolCalls as unknown as PersistedToolCall[] | null) ?? null,
        toolCallId: m.toolCallId,
        turnId: m.turnId,
        createdAt: m.createdAt.toISOString(),
      })),
    };
  }

  /**
   * List a user's conversations newest-first. Used by the dashboard sidebar
   * (when reintroduced) and any future "resume" flow.
   */
  async listConversationsForUser(
    userId: string,
    limit: number,
    offset: number,
  ): Promise<PersistedConversationSummary[]> {
    const rows = await this.prisma.chatSession.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" },
      take: Math.min(Math.max(limit, 1), 100),
      skip: Math.max(offset, 0),
    });
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      model: r.model,
      provider: r.provider,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
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
  }): Promise<{ id: string; created: boolean }> {
    if (args.conversationId) {
      const existing = await this.prisma.chatSession.findFirst({
        where: { id: args.conversationId, userId: args.userId },
        select: { id: true },
      });
      if (existing) return { id: existing.id, created: false };
      // The client sent an id we don't own (different user, deleted, or
      // forged). Don't trust it — start a fresh conversation. Returning
      // 404 would also be acceptable but silently rolling forward keeps
      // the chat surface from going blank in the face of a stale URL.
    }
    const title = args.firstUserContent ? deriveTitle(args.firstUserContent) : null;
    const created = await this.prisma.chatSession.create({
      data: {
        userId: args.userId,
        title,
        model: args.model,
        provider: args.provider ?? null,
      },
      select: { id: true },
    });
    return { id: created.id, created: true };
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
