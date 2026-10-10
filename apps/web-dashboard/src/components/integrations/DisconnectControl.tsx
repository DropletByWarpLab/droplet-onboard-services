"use client";

/**
 * WARP-2518 — Disconnect, once, for every surface that offers it.
 *
 * ## Why this is a component and not three call sites
 *
 * Until this existed the only Disconnect control in the product was inside
 * `ManageSheet`, which is reached from the practice surface's connected hero —
 * i.e. only for a provider that has a detail page. Every cloud connection an
 * owner made through `/connectors` or `/connectors/credentials` could be
 * *created* in the dashboard and *removed* only by calling the API, which
 * makes ADR-041 §2's promise ("disconnecting revokes and purges the stored
 * tokens, not merely flips a flag") true of the box and unreachable from the
 * UI the promise is made in.
 *
 * The obvious fix — a Disconnect button on the hub tile and another on the
 * credentials page — is three copies of a destructive confirmation, three
 * copies of the error handling, and three chances for one of them to drift
 * into confirming less than it purges. So the flow lives here and
 * `ManageSheet` became a consumer of it rather than its owner.
 *
 * ## What it owns, deliberately
 *
 * The CALL, not just the button. A parent that passed `onDisconnect` would be
 * back to owning the error handling, which is exactly what the practice page
 * did with `catch {}` (WARP-2519). The parent's only job afterwards is to
 * re-read: `onDisconnected` fires on success and every surface answers it by
 * refreshing, which is how the result reaches the owner in the *existing*
 * words — `credentialsPurged` arrives on the next read and renders through
 * `disconnectedCredentialView`. This component deliberately renders no outcome
 * copy of its own; a second sentence about the credential is a second sentence
 * to keep true.
 *
 * ## WARP-3375 — the records the connector copied are the owner's call
 *
 * The confirm used to say "Your X data is untouched" while the box deleted the
 * Customers records the connector had landed. It now asks. A connector that
 * copied something offers **Keep the records** (the default: they become
 * ordinary records and nothing is deleted) or **Delete the records**, and
 * Delete needs a SECOND, red confirmation. A connector that copied nothing says
 * so and offers no choice. Every sentence is derived per connector in
 * `disconnect-copy.ts` from the same dataset lists the box copies with.
 *
 * ## The role gate is here, not in each parent
 *
 * `POST /api/connectors/:provider/disconnect` is `requireRole("owner",
 * "admin")`. Mirroring that here means a new surface cannot forget it, and it
 * closes a live hole: `ManageSheet` showed the button to `family`/`guest`
 * sessions, whose click 403'd into the swallowing `catch {}`.
 */

import { useState } from "react";
import { Unplug } from "lucide-react";
import { landedRecords, providerDescriptor } from "@droplet/shared-types";
import { useAuth } from "@/lib/auth";
import { disconnectProvider, type LandedRecordsChoice } from "@/lib/api.erp";
import { lifecycleErrorMessage } from "@/lib/lifecycle-errors";
import { disconnectCopy } from "./disconnect-copy";

/**
 * Discriminated union, per `DnsServersForm.tsx:46-51`. Not four booleans:
 * "confirming", "busy" and "failed" cannot be true at once, and the boolean
 * shape is the one that produces a panel asking for confirmation while a
 * request for it is already in flight.
 */
type Phase =
  | { kind: "idle" }
  | { kind: "confirming" }
  // WARP-3375 — the second, red confirmation. Only Delete reaches it.
  | { kind: "confirmingDelete" }
  | { kind: "busy"; records: LandedRecordsChoice }
  | { kind: "error"; message: string };

export function DisconnectControl({
  provider,
  displayName,
  onDisconnected,
}: {
  /** The row's own `provider` key — the orchestrator's free-form TEXT key, not
   *  a catalog id. It is what the provider-scoped URL is built from. */
  provider: string;
  /** What the owner calls this connection. Used in the copy only. */
  displayName: string;
  /** Fired ONLY after the box confirmed the disconnect. The surface answers by
   *  re-reading, which is what makes the purge fact appear. */
  onDisconnected?: () => void;
}) {
  const { user } = useAuth();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  // WARP-3375 — reset to Keep every time the confirm opens, so a Delete picked
  // in an earlier, abandoned attempt can never be the one-click default.
  const [choice, setChoice] = useState<LandedRecordsChoice>("keep");

  const isAdmin = user?.role === "owner" || user?.role === "admin";
  if (!isAdmin) return null;

  const copy = disconnectCopy(displayName, landedRecords(providerDescriptor(provider)));

  async function run(records: LandedRecordsChoice) {
    setPhase({ kind: "busy", records });
    try {
      await disconnectProvider(provider, records);
      setPhase({ kind: "idle" });
      onDisconnected?.();
    } catch (err) {
      // Never a no-op, and never the response body — see `lifecycleErrorMessage`.
      setPhase({
        kind: "error",
        message: lifecycleErrorMessage(`disconnect ${displayName}`, err),
      });
    }
  }

  const deleteStep =
    phase.kind === "confirmingDelete" || (phase.kind === "busy" && phase.records === "delete");

  // WARP-3375 — the second, red confirmation for Delete.
  if (deleteStep) {
    const busy = phase.kind === "busy";
    return (
      <div
        className="rounded-[var(--radius-input)] bg-[rgba(239,68,68,0.1)] border border-[#ef4444] p-3"
        data-testid="disconnect-confirm-delete"
      >
        <p className="type-subheadline" style={{ color: "var(--text)" }}>
          {copy.confirmDeleteTitle}
        </p>
        <p className="type-footnote mt-1" style={{ color: "var(--text)" }}>
          {copy.confirmDeleteBody}
        </p>
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            className="type-footnote px-2 min-h-[44px]"
            style={{ color: "var(--text-muted)" }}
            disabled={busy}
            onClick={() => setPhase({ kind: "confirming" })}
          >
            Go back
          </button>
          <button
            type="button"
            className="type-subheadline px-4 rounded-[var(--radius-input)] bg-[#ef4444] text-white hover:bg-[#dc2626] disabled:opacity-60 disabled:cursor-not-allowed inline-flex items-center gap-1.5 min-h-[44px]"
            disabled={busy}
            aria-busy={busy || undefined}
            onClick={() => run("delete")}
          >
            {busy ? "Deleting…" : "Delete records and disconnect"}
          </button>
        </div>
      </div>
    );
  }

  // Tokens follow `settings/DestructiveConfirm.tsx`, not the sheet this block
  // came out of: `ManageSheet` is grandfathered in
  // `scripts/dashboard-token-allowlist.txt` and this file is new, so the
  // ratified DESIGN.md tokens are the only ones it may use. The literal
  // `#ef4444` pair is that component's destructive treatment verbatim —
  // deliberately NOT `bg-accent`, which is where the white-on-accent contrast
  // failure lives.
  if (phase.kind === "confirming" || phase.kind === "busy") {
    const busy = phase.kind === "busy";
    // A connector that copied nothing has no choice to make: the answer is
    // fixed at Keep, which deletes nothing.
    const effective: LandedRecordsChoice = copy.copiesNothing ? "keep" : choice;
    return (
      <div
        className="rounded-[var(--radius-input)] bg-[rgba(239,68,68,0.1)] p-3"
        data-testid="disconnect-confirm"
      >
        {/* The purge is stated BEFORE it happens, which is the half ADR-041 §2
            calls a capability statement. WARP-3375: and so is what happens to
            the records, per connector — never "your data is untouched". */}
        <p className="type-footnote" style={{ color: "var(--text)" }}>
          {copy.intro}
        </p>
        {!copy.copiesNothing && (
          <fieldset className="mt-3" disabled={busy}>
            <legend className="sr-only">
              What happens to the {displayName} records Droplet copied
            </legend>
            <label className="flex items-start gap-2 min-h-[44px] py-1">
              <input
                type="radio"
                name={`records-${provider}`}
                className="mt-1"
                checked={choice === "keep"}
                onChange={() => setChoice("keep")}
              />
              <span>
                <span className="type-subheadline" style={{ color: "var(--text)" }}>
                  Keep the records (recommended)
                </span>
                <span
                  className="type-footnote block"
                  style={{ color: "var(--text-muted)" }}
                >
                  {copy.keep}
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 min-h-[44px] py-1">
              <input
                type="radio"
                name={`records-${provider}`}
                className="mt-1"
                checked={choice === "delete"}
                onChange={() => setChoice("delete")}
              />
              <span>
                <span className="type-subheadline" style={{ color: "var(--text)" }}>
                  Delete the records
                </span>
                <span
                  className="type-footnote block"
                  style={{ color: "var(--text-muted)" }}
                >
                  {copy.remove}
                </span>
              </span>
            </label>
          </fieldset>
        )}
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            className="type-footnote px-2 min-h-[44px]"
            style={{ color: "var(--text-muted)" }}
            disabled={busy}
            onClick={() => setPhase({ kind: "idle" })}
          >
            Keep connected
          </button>
          <button
            type="button"
            className="type-subheadline px-4 rounded-[var(--radius-input)] bg-[#ef4444] text-white hover:bg-[#dc2626] disabled:opacity-60 disabled:cursor-not-allowed inline-flex items-center gap-1.5 min-h-[44px]"
            disabled={busy}
            aria-busy={busy || undefined}
            onClick={() =>
              effective === "delete" ? setPhase({ kind: "confirmingDelete" }) : run("keep")
            }
          >
            {busy ? "Disconnecting…" : effective === "delete" ? "Continue" : "Disconnect"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        className="flex items-center gap-2 type-footnote text-system-red"
        onClick={() => {
          setChoice("keep");
          setPhase({ kind: "confirming" });
        }}
      >
        <Unplug size={14} aria-hidden /> Disconnect {displayName}
      </button>
      {phase.kind === "error" && (
        <p className="type-caption-1 text-system-red mt-2" role="alert">
          {phase.message}
        </p>
      )}
    </>
  );
}
