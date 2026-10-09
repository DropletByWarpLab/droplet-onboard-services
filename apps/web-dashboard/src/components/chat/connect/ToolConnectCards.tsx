"use client";
/**
 * WARP-3904 — the connect descriptors a turn's tool calls produced, rendered
 * beneath the message text (same placement as the media cards).
 *
 * `interactive` is decided by the message, not here: it is true only for the
 * newest assistant message of a live conversation.
 */
import { ConnectCard } from "./ConnectCard";
import { ConnectionDisconnected } from "./ConnectionDisconnected";
import { ConnectionsOverviewCard } from "./ConnectionsOverviewCard";
import type { ConnectCall } from "./connect-split";

export function ToolConnectCards({
  calls,
  interactive,
  conversationId,
  onOutcome,
}: {
  calls: ConnectCall[];
  interactive: boolean;
  conversationId: string | null;
  onOutcome: (turn: string) => void;
}) {
  if (calls.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 mt-2" data-testid="tool-connect-cards">
      {calls.map(({ call, result }) => {
        switch (result.kind) {
          case "card":
            return (
              <ConnectCard
                key={call.id}
                card={result.card}
                interactive={interactive}
                conversationId={conversationId}
                onOutcome={onOutcome}
              />
            );
          case "overview":
            return <ConnectionsOverviewCard key={call.id} overview={result.overview} onOutcome={onOutcome} />;
          case "disconnected":
            return <ConnectionDisconnected key={call.id} disconnected={result.disconnected} />;
          default:
            return null;
        }
      })}
    </div>
  );
}
