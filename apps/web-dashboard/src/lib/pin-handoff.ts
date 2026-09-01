"use client";

/**
 * WARP-2582 (ADR-045 slice E) - handing a business record to /chat.
 *
 * WARP-829 built the hand-off channel (`droplet.pendingComposer`) for the
 * /tools "Use in chat" button and gave its payload a `kind` discriminant
 * explicitly so it could grow other seed sources. This is that second source.
 *
 * THE ORDERING PROBLEM, stated because it shapes the whole design. Context
 * pins are PER SESSION, and a session id does not exist until the first turn
 * mints one - which is why the chat page renders `ContextPinsPopover` only
 * `{conversationId && ...}`. There is no `context_pins` field on the chat
 * request either: `ContextPin`'s own schema docstring cites one "in
 * FEATURES.md s4.1", but nothing in the orchestrator or the dashboard has
 * ever sent or parsed it. So a pin cannot be in force on turn 1.
 *
 * The hand-off therefore carries BOTH halves:
 *   - `seedText` primes the composer so TURN 1 already names the record. It
 *     seeds, it never sends - identical to the /tools contract, so a write
 *     the model then attempts still meets the in-chat confirmation gate.
 *   - `pin` is applied once the first turn mints a conversation id, so every
 *     turn AFTER the first carries the scope without the user retyping it.
 *
 * Both are one-shot and consumed on a FRESH chat only (no `?c=` deep link, no
 * existing messages), so a stale payload can never hijack a thread the user
 * opened from history.
 */
import { PENDING_COMPOSER_KEY, type PendingComposerPinPayload } from "@/lib/types";

/** What the record surfaces know about the thing being pinned. */
export interface PinHandoffRecord {
  // WARP-2582 — `pin` is nullable on the payload (a list-scoped hand-off
  // carries seed text and no pin), so index through NonNullable rather
  // than widening this to include null. A record hand-off always has one.
  kind: NonNullable<PendingComposerPinPayload["pin"]>["kind"];
  id: string;
  /** Display name. Used for the chip and the seed line - never sent as `ref`. */
  name: string;
}

const NOUN: Record<PinHandoffRecord["kind"], string> = {
  customer: "customer",
  deal: "deal",
  project: "project",
  work_item: "work item",
};

/**
 * Stage a record hand-off and return true if it stuck.
 *
 * A `false` return is not an error worth surfacing: sessionStorage throws in a
 * locked-down browser, and the worst case is the user lands on an unseeded
 * /chat - which is exactly where the link took them before this ticket.
 */
export function stageRecordPinHandoff(record: PinHandoffRecord): boolean {
  const payload: PendingComposerPinPayload = {
    kind: "pin",
    label: record.name,
    pin: { kind: record.kind, ref: record.id },
    // Turn 1 has no pin yet, so the seed line carries the id itself. From
    // turn 2 the pin does it, and the model gets the same two facts either
    // way: what the record is called and which id names it.
    seedText: `About the ${NOUN[record.kind]} "${record.name}" (id ${record.id}): `,
  };
  try {
    window.sessionStorage.setItem(PENDING_COMPOSER_KEY, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

/**
 * The LIST-scoped variant, for "Ask AI about your customers".
 *
 * There is no record here, so there is nothing to pin - a pin needs a `ref`,
 * and "your customers" is not one. Seeding the composer is the honest whole of
 * what that button can do, and it is strictly more than the bare `href="/chat"`
 * it replaces.
 */
export function stagePromptHandoff(label: string, seedText: string): boolean {
  const payload: PendingComposerPinPayload = {
    kind: "pin",
    label,
    pin: null,
    seedText,
  };
  try {
    window.sessionStorage.setItem(PENDING_COMPOSER_KEY, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}
