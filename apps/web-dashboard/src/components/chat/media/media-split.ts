/**
 * WARP-3691 — which tool calls become inline media cards.
 *
 * A call is a media call only when it SUCCEEDED and its result carries at least
 * one VALID descriptor. Everything else (pending, failed, awaiting approval, a
 * tool that returned no `media`) keeps its chip, so a failed `get_camera_snapshot`
 * still shows as a red chip rather than silently disappearing.
 *
 * Validation lives in `parseChatMedia` (shared-types): every URL must be a
 * same-origin `/api/...` path, camera names / event ids must match the
 * orchestrator's own patterns. Persisted tool calls are re-validated on every
 * render — a stored result is not trusted just because we wrote it.
 */
import { parseChatMedia, type ChatMedia } from "@droplet/shared-types";
import type { ChatToolCall } from "@/lib/types";

export type { ChatMedia };

/** The validated media a tool call carries, or [] (never throws). */
export function mediaOf(call: ChatToolCall): ChatMedia[] {
  if (call.ok !== true || call.status === "confirmation_required") return [];
  try {
    return parseChatMedia(call.data);
  } catch {
    return [];
  }
}

export interface MediaCall {
  call: ChatToolCall;
  media: ChatMedia[];
}

/**
 * Partition calls into the ones rendered as cards and the ones that stay chips.
 * `isOtherCard` lets the caller keep its existing special cases (RunCard) out
 * of both lists.
 */
export function splitMediaCalls(
  calls: ChatToolCall[],
  isOtherCard: (c: ChatToolCall) => boolean = () => false,
): { chipCalls: ChatToolCall[]; mediaCalls: MediaCall[] } {
  const chipCalls: ChatToolCall[] = [];
  const mediaCalls: MediaCall[] = [];
  for (const call of calls) {
    if (isOtherCard(call)) continue;
    const media = mediaOf(call);
    if (media.length > 0) mediaCalls.push({ call, media });
    else chipCalls.push(call);
  }
  return { chipCalls, mediaCalls };
}
