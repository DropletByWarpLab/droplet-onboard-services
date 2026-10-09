/**
 * WARP-3904 — which tool calls become connect cards.
 *
 * A call is a connect call only when it SUCCEEDED and its result carries a
 * descriptor the shared parsers accept. Everything else (pending, failed,
 * awaiting approval, a descriptor whose paths are off the allowlist) keeps its
 * chip, so a refused card is a visible chip rather than a silent gap.
 *
 * Persisted tool calls are re-validated on every render: a stored result is not
 * trusted just because we wrote it, and neither is a model-shaped one. The
 * parsers drop any POST target that is not one of the three routes the hub
 * already writes to, so a descriptor cannot redirect a secret.
 */
import {
  parseConnectCard,
  parseConnectionDisconnected,
  parseConnectionsOverview,
  type ConnectCard,
  type ConnectionDisconnected,
  type ConnectionsOverview,
} from "@droplet/shared-types";
import type { ChatToolCall } from "@/lib/types";

export type ConnectResult =
  | { kind: "card"; card: ConnectCard }
  | { kind: "overview"; overview: ConnectionsOverview }
  | { kind: "disconnected"; disconnected: ConnectionDisconnected };

/** The result itself, and the MCP-wrapped `{ data: <result> }` form. */
function candidates(data: unknown): unknown[] {
  if (!data || typeof data !== "object") return [];
  const inner = (data as { data?: unknown }).data;
  return inner && typeof inner === "object" ? [data, inner] : [data];
}

/** The validated connect descriptor a tool call carries, or null (never throws). */
export function connectResultOf(call: ChatToolCall): ConnectResult | null {
  if (call.ok !== true || call.status === "confirmation_required") return null;
  try {
    for (const data of candidates(call.data)) {
      const card = parseConnectCard(data);
      if (card) return { kind: "card", card };
      const overview = parseConnectionsOverview(data);
      if (overview) return { kind: "overview", overview };
      const disconnected = parseConnectionDisconnected(data);
      if (disconnected) return { kind: "disconnected", disconnected };
    }
  } catch {
    /* a malformed result is a chip, not a crash */
  }
  return null;
}

export interface ConnectCall {
  call: ChatToolCall;
  result: ConnectResult;
}

/** The calls of one message that render as connect cards, in call order. */
export function connectCallsOf(calls: ChatToolCall[] | undefined): ConnectCall[] {
  const out: ConnectCall[] = [];
  for (const call of calls ?? []) {
    const result = connectResultOf(call);
    if (result) out.push({ call, result });
  }
  return out;
}
