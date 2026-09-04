"use client";

/**
 * WARP-2518 — Disconnect, once, for every surface that offers it.
 *
 * ## Why this is a component and not three call sites
 *
 * Until this existed the only Disconnect control in the product was inside
 * `ManageSheet`, which is reached from the practice surface's connected hero —
 * i.e. only for a provider that has a detail page. Every cloud connection an
 * owner made through `/integrations` or `/integrations/credentials` could be
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
 * ## The role gate is here, not in each parent
 *
 * `POST /api/integrations/:provider/disconnect` is `requireRole("owner",
 * "admin")`. Mirroring that here means a new surface cannot forget it, and it
 * closes a live hole: `ManageSheet` showed the button to `family`/`guest`
 * sessions, whose click 403'd into the swallowing `catch {}`.
 */

import { useState } from "react";
import { Unplug } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { disconnectProvider } from "@/lib/api.erp";
import { lifecycleErrorMessage } from "@/lib/lifecycle-errors";

/**
 * Discriminated union, per `DnsServersForm.tsx:46-51`. Not four booleans:
 * "confirming", "busy" and "failed" cannot be true at once, and the boolean
 * shape is the one that produces a panel asking for confirmation while a
 * request for it is already in flight.
 */
type Phase =
  | { kind: "idle" }
  | { kind: "confirming" }
  | { kind: "busy" }
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

  const isAdmin = user?.role === "owner" || user?.role === "admin";
  if (!isAdmin) return null;

  async function run() {
    setPhase({ kind: "busy" });
    try {
      await disconnectProvider(provider);
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

  // Tokens follow `settings/DestructiveConfirm.tsx`, not the sheet this block
  // came out of: `ManageSheet` is grandfathered in
  // `scripts/dashboard-token-allowlist.txt` and this file is new, so the
  // ratified DESIGN.md tokens are the only ones it may use. The literal
  // `#ef4444` pair is that component's destructive treatment verbatim —
  // deliberately NOT `bg-accent`, which is where the white-on-accent contrast
  // failure lives.
  if (phase.kind === "confirming" || phase.kind === "busy") {
    const busy = phase.kind === "busy";
    return (
      <div
        className="rounded-[var(--radius-input)] bg-[rgba(239,68,68,0.1)] p-3"
        data-testid="disconnect-confirm"
      >
        {/* The purge is stated BEFORE it happens, which is the half ADR-041 §2
            calls a capability statement. The old sheet's wording promised only
            that Droplet would stop reading. */}
        <p className="type-footnote" style={{ color: "var(--text)" }}>
          Disconnect {displayName}? Droplet stops reading it and removes the stored
          credential. Your {displayName} data is untouched.
        </p>
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
            onClick={run}
          >
            {busy ? "Disconnecting…" : "Disconnect"}
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
        onClick={() => setPhase({ kind: "confirming" })}
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
