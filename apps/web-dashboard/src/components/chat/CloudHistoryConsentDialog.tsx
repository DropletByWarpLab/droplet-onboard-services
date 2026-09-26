"use client";

import { useId, useState } from "react";
import { Dialog } from "@/components/Dialog";
import type { CloudHistorySummary } from "@/lib/api";

/**
 * WARP-2991 — asked when a conversation with earlier on-box answers is
 * switched to a cloud model. Closing it records nothing, and the server then
 * sends only the user's own messages (it never relies on this dialog).
 *
 * WARP-2979 (ADR-059 P4 §6.13) — an answer that used Security is never sent
 * to a cloud model, whatever is chosen here: the server replays only the
 * user's own messages. So when the summary says so (`neverSent`), the dialog
 * says it too and offers only that — a "send everything" button would promise
 * what the server will not do.
 */
export function CloudHistoryConsentDialog({
  open,
  summary,
  modelLabel,
  onDecide,
  onClose,
}: {
  open: boolean;
  summary: CloudHistorySummary | null;
  modelLabel: string;
  onDecide: (decision: "granted" | "declined") => Promise<void>;
  onClose: () => void;
}) {
  const headingId = useId();
  const descId = useId();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const n = summary?.unaskedOnBoxAnswers ?? 0;
  const drewOn = summary?.drewOn ?? [];
  const neverSent = summary?.neverSent ?? [];
  const onlyMine = neverSent.length > 0;

  const decide = async (decision: "granted" | "declined") => {
    setPending(true);
    setFailed(false);
    try {
      await onDecide(decision);
      onClose();
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} labelledBy={headingId} describedBy={descId} maxWidth="sm">
      <div className="space-y-4">
        <div>
          <h2 id={headingId} className="type-headline" style={{ color: "var(--text)" }}>
            Send this conversation to {modelLabel}?
          </h2>
          <p id={descId} className="type-subheadline mt-1.5" style={{ color: "var(--text-muted)" }}>
            {modelLabel} runs outside your Droplet. This conversation has {n} earlier{" "}
            {n === 1 ? "answer" : "answers"} from the on-box model
            {drewOn.length > 0 ? `, including answers drawn from your ${drewOn.join(", ")}` : ""}.{" "}
            {onlyMine
              ? `Answers that used ${neverSent.join(" or ")} stay on this Droplet, so only your own messages are sent.`
              : "You can send the whole conversation, or only your own messages. Earlier answers then stay on the Droplet."}
          </p>
          {failed && (
            <p className="type-caption-1 mt-2" style={{ color: "var(--danger, #ef4444)" }}>
              Your choice could not be saved. Until it is, only your own messages are sent.
            </p>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" className={onlyMine ? "btn primary" : "btn"} disabled={pending} onClick={() => decide("declined")}>
            Only my messages
          </button>
          {!onlyMine && (
            <button
              type="button"
              className="btn primary"
              disabled={pending}
              onClick={() => decide("granted")}
            >
              Send the whole conversation
            </button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
