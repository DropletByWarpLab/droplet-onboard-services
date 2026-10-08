/**
 * WARP-3904 - when a queued connect follow-up turn may be sent.
 *
 * A connect card resolves with one short user turn ("<name> is connected
 * now."). The chat page holds it until the stream is idle and, for an OAuth
 * return, until the conversation it belongs to has loaded. This is the part of
 * that decision that does not depend on React, so it is a unit test rather than
 * a click-through:
 *
 *   - `send`: the turn belongs to the open conversation (or to none yet) and is
 *     still fresh. Send it once.
 *   - `wait`: the turn belongs to a conversation that is still opening.
 *   - `drop`: the turn has outlived its moment. A turn that is two minutes old
 *     must not surface in a conversation the person opened later.
 */

/** How long a queued connect follow-up turn stays valid. */
export const CONNECT_TURN_TTL_MS = 2 * 60 * 1000;

export interface PendingConnectTurn {
  turn: string;
  /** The conversation the turn belongs to, or null for the one now open. */
  conversationId: string | null;
  /** `Date.now()` when the turn was queued. */
  at: number;
}

export type ConnectTurnStep = "send" | "wait" | "drop";

export function connectTurnStep(
  pending: PendingConnectTurn,
  openConversationId: string | null,
  now: number,
): ConnectTurnStep {
  const fresh = now - pending.at <= CONNECT_TURN_TTL_MS;
  if (pending.conversationId !== null && pending.conversationId !== openConversationId) {
    return fresh ? "wait" : "drop";
  }
  return fresh ? "send" : "drop";
}
