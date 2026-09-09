"use client";

/**
 * WARP-2469 — the in-chat approval prompt for a WARP-2305 interceptor
 * challenge.
 *
 * This is where "writes ask for a thumbs-up" stops being a slogan and
 * becomes a control the user can actually operate. The interceptor
 * refuses a confirming tool and mints a token bound to that exact call;
 * this component is what a human uses to release it.
 *
 * WHAT IT DELIBERATELY DOES NOT SHOW: argument values. The summary is
 * built server-side by `confirmation-summary.ts` and carries an
 * argument's key, kind and size only — tool arguments routinely hold
 * customer content and, on the ERP/health surfaces, PHI, and this prompt
 * is rendered into a chat transcript that is persisted and re-read. The
 * trade-off (you see "path — 25 characters", not the path) is stated in
 * that module; loosening it needs a per-tool allowlist, not a change
 * here.
 *
 * WHAT IT DOES NOT HOLD: the token. The client has an opaque
 * `challengeId`; approval happens on `POST /api/llm/confirm/:id`, which
 * is role-gated, and the agent loop collects the token itself.
 *
 * Hand-rolled `useState` — this repo has no react-hook-form and no zod
 * on the dashboard side.
 */
import { useState } from "react";
import { Check, Loader2, ShieldAlert, ShieldX, TimerOff, X } from "lucide-react";
import type { ChatToolCall } from "@/lib/types";

export interface ToolApprovalPromptProps {
  call: ChatToolCall;
  /** Epoch ms used to decide expiry. Injectable so a test can advance it. */
  now?: number;
  onDecision?: (challengeId: string, decision: "approve" | "deny") => void;
  /** Re-ask: mints a fresh challenge by re-running the request. */
  onRerequest?: () => void;
}

/** A human sentence for one summarised argument. Never a value. */
function fieldLine(field: {
  key: string;
  kind: string;
  detail: string;
  value?: boolean;
}): string {
  if (field.kind === "boolean") return `${field.key}: ${field.value ? "yes" : "no"}`;
  return `${field.key}: ${field.detail}`;
}

export function ToolApprovalPrompt({
  call,
  now,
  onDecision,
  onRerequest,
}: ToolApprovalPromptProps) {
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const confirmation = call.confirmation;
  const challengeId = confirmation?.challengeId;
  if (!confirmation || !challengeId) return null;

  const at = now ?? Date.now();
  // Expiry is read from the challenge's own `expiresAt` (the interceptor's
  // mint), and from the server-decided `confirmState` — a prompt the
  // server already refused as expired must render as expired even if the
  // local clock disagrees.
  const isExpired =
    call.confirmState === "expired" ||
    (typeof confirmation.expiresAt === "number" && confirmation.expiresAt <= at);
  const isDenied = call.confirmState === "denied";
  const isApproved = call.confirmState === "ran";
  const isFailed = call.confirmState === "failed";
  const settled = isExpired || isDenied || isApproved;

  const toolName = confirmation.tool ?? call.name;
  const fields = confirmation.summary?.fields ?? [];
  const truncated = confirmation.summary?.truncatedFields ?? 0;

  const decide = (decision: "approve" | "deny") => {
    if (busy || settled) return;
    setBusy(decision);
    onDecision?.(challengeId, decision);
  };

  return (
    <div
      className="mb-2 p-3 rounded-lg bg-system-orange/10 text-system-orange type-caption-1"
      role="group"
      aria-label={`Approval needed for ${toolName}`}
      data-testid="tool-approval-prompt"
      data-challenge-id={challengeId}
      data-state={
        isExpired ? "expired" : isDenied ? "denied" : isApproved ? "approved" : "pending"
      }
    >
      <p className="flex items-center gap-1.5 font-medium">
        {isExpired ? (
          <TimerOff size={14} aria-hidden="true" />
        ) : isDenied ? (
          <ShieldX size={14} aria-hidden="true" />
        ) : (
          <ShieldAlert size={14} aria-hidden="true" />
        )}
        <span>
          {isExpired
            ? `This approval request for ${toolName} expired`
            : isDenied
              ? `You declined ${toolName}`
              : isApproved
                ? `You approved ${toolName}`
                : `${toolName} needs your approval`}
        </span>
      </p>

      {fields.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 opacity-90" data-testid="approval-arg-summary">
          {fields.map((f) => (
            <li key={f.key}>{fieldLine(f)}</li>
          ))}
          {truncated > 0 && <li>…and {truncated} more</li>}
        </ul>
      )}

      {isExpired ? (
        <div className="mt-2">
          <p className="type-caption-2 opacity-80">
            Approvals are only good for a few minutes. Ask again to get a fresh one.
          </p>
          {onRerequest && (
            <button
              type="button"
              onClick={onRerequest}
              data-testid="approval-rerequest"
              className="mt-1.5 inline-flex items-center gap-1 px-3 py-2 rounded-md
                type-caption-1 font-medium
                bg-system-orange/15 hover:bg-system-orange/25 text-system-orange
                focus:outline-none focus:ring-2 focus:ring-system-orange/40
                transition-colors"
            >
              Ask again
            </button>
          )}
        </div>
      ) : settled ? null : (
        <div className="mt-2 flex items-center gap-1.5">
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => decide("approve")}
            data-testid="approval-approve"
            className="inline-flex items-center gap-1 px-3 py-2 rounded-md
              type-caption-1 font-medium
              bg-system-orange/15 hover:bg-system-orange/25 text-system-orange
              disabled:opacity-60 disabled:cursor-not-allowed
              focus:outline-none focus:ring-2 focus:ring-system-orange/40
              transition-colors"
          >
            {busy === "approve" ? (
              <>
                <Loader2 size={12} className="animate-spin" aria-hidden="true" />
                Approving…
              </>
            ) : (
              <>
                <Check size={12} aria-hidden="true" />
                Approve
              </>
            )}
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => decide("deny")}
            data-testid="approval-deny"
            className="inline-flex items-center gap-1 px-3 py-2 rounded-md
              type-caption-1 font-medium
              bg-system-orange/5 hover:bg-system-orange/15 text-system-orange
              disabled:opacity-60 disabled:cursor-not-allowed
              focus:outline-none focus:ring-2 focus:ring-system-orange/40
              transition-colors"
          >
            <X size={12} aria-hidden="true" />
            Don&apos;t
          </button>
        </div>
      )}

      {isFailed && (
        <p className="mt-1.5 type-caption-2 text-system-red" data-testid="approval-failed">
          That didn&apos;t go through — ask again to retry.
        </p>
      )}
    </div>
  );
}
