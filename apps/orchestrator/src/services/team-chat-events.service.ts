/**
 * WARP-3485 — live team-chat (Messages) events on the event socket, so a
 * client stops polling the open conversation, the list and the unread badge.
 *
 * Topic:   `droplet/team-chat/<username>`  (one per person, like
 *          `droplet/notifications/<username>` and `droplet/agent-runs/<username>`)
 * QoS:     0, best-effort. A client that missed one re-reads the REST routes,
 *          which keep every gate and stay valid for older clients.
 * Payload: IDs and a kind only, never text, titles or names:
 *   { kind: "message" | "read" | "conversation", conversationId: string, messageId?: string }
 *   - message:      a message was posted (or a meeting card in it changed); `messageId` names it.
 *   - read:         the person's own read cursor moved. Sent to that person only,
 *                   so nobody can tell when a colleague read a conversation.
 *   - conversation: the conversation was created. There is no rename or
 *                   membership route yet; one that is added publishes this kind
 *                   (to the old and the new members) after its write.
 *
 * Recipients are the conversation's participants (TeamChatParticipant), so a
 * non-member never receives anything, and an external guest only receives the
 * conversations they were added to. ws-bridge subscribes each socket to its
 * own user's topic only.
 *
 * Fire-and-forget: a failure is logged and never fails the write that caused it.
 */
import type { PrismaClient } from "@prisma/client";
import { publish } from "./mqtt.service.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("team-chat-events");

export const TEAM_CHAT_EVENTS_TOPIC = (username: string): string => `droplet/team-chat/${username}`;

export interface TeamChatEvent {
  kind: "message" | "read" | "conversation";
  conversationId: string;
  messageId?: string;
}

/**
 * Publish `event` to every member of its conversation, or, with `onlyUsername`,
 * to that one person (the caller has already proven they are a member).
 */
export async function publishTeamChatEvent(
  prisma: PrismaClient,
  event: TeamChatEvent,
  onlyUsername?: string,
): Promise<void> {
  try {
    // Built field by field so nothing else on `event` can ever reach the wire.
    const payload: Record<string, unknown> = {
      kind: event.kind,
      conversationId: event.conversationId,
      ...(event.messageId ? { messageId: event.messageId } : {}),
    };
    if (onlyUsername) {
      publish(TEAM_CHAT_EVENTS_TOPIC(onlyUsername), payload);
      return;
    }
    const members = await prisma.teamChatParticipant.findMany({
      where: { threadId: event.conversationId },
      select: { userId: true },
    });
    if (members.length === 0) return;
    const users = await prisma.user.findMany({
      where: { id: { in: members.map((m) => m.userId) } },
      select: { username: true },
    });
    for (const u of users) publish(TEAM_CHAT_EVENTS_TOPIC(u.username), payload);
  } catch (err) {
    logger.warn({ err, conversationId: event.conversationId, kind: event.kind }, "team_chat_event_publish_failed");
  }
}
