"use client";

/**
 * WARP-246 — hash-chain verification strip for /admin/audit.
 *
 * The chain is HMAC-signed on the box and the key never leaves it, so
 * the badge is a rendering of GET /api/activity/verify's result — the
 * dashboard never re-derives signatures client-side. The strip shows
 * the current state + when it was checked, with a re-verify action;
 * a broken chain additionally gets a role="alert" banner (rendered by
 * the page via <BrokenChainBanner>) because it is the one state a
 * household admin must not scroll past.
 */

import { RefreshCw, ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react";
import { Badge } from "@/components/shell/primitives";
import { formatRelativeTime } from "@/lib/relative-time";
import type { VerifyState } from "./types";

export function ChainVerificationBadge({
  state,
  onReverify,
}: {
  state: VerifyState;
  onReverify: () => void;
}) {
  const checking = state.phase === "checking";

  return (
    <div
      style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}
      // The broken phase is announced by the page's role="alert" banner;
      // keeping the strip live too would double-announce it.
      aria-live={state.phase === "broken" ? undefined : "polite"}
    >
      {state.phase === "checking" && (
        <Badge kind="muted">
          <ShieldQuestion size={12} aria-hidden />
          Verifying chain…
        </Badge>
      )}
      {state.phase === "ok" && (
        <>
          <Badge kind="ok">
            <ShieldCheck size={12} aria-hidden />
            Chain verified
          </Badge>
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
            {state.rowsChecked.toLocaleString()}{" "}
            {state.rowsChecked === 1 ? "entry" : "entries"} checked{" "}
            {formatRelativeTime(state.verifiedAt)}
          </span>
        </>
      )}
      {state.phase === "broken" && (
        <>
          <Badge kind="danger">
            <ShieldAlert size={12} aria-hidden />
            Chain broken
          </Badge>
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
            at entry #{state.brokenAtId} · checked{" "}
            {formatRelativeTime(state.verifiedAt)}
          </span>
        </>
      )}
      {state.phase === "error" && (
        <>
          <Badge kind="warn">
            <ShieldQuestion size={12} aria-hidden />
            Verification unavailable
          </Badge>
          <span
            style={{ fontSize: 12, color: "var(--text-muted)" }}
            title={state.detail}
          >
            {state.message}
          </span>
        </>
      )}
      <button
        type="button"
        className="btn sm ghost"
        onClick={onReverify}
        disabled={checking}
      >
        <RefreshCw size={13} className={checking ? "animate-spin" : undefined} aria-hidden />
        Re-verify
      </button>
    </div>
  );
}

/**
 * Rendered by the page when (and only when) the chain fails to verify.
 * Copy is deliberately calm: a broken chain on a home appliance is far
 * more often a restored backup than an intruder, but it always
 * deserves a deliberate look.
 */
export function BrokenChainBanner({
  brokenAtId,
  rowsChecked,
}: {
  brokenAtId: string;
  /** Rows the verify walk examined, INCLUDING the broken one. */
  rowsChecked: number;
}) {
  // The route increments rowsChecked before verifying, so the broken row
  // is included in the count; the intact prefix is one shorter. Phrased
  // as a positional count, never as an id (ids need not start at 1 after
  // a retention purge).
  const intactBefore = Math.max(0, rowsChecked - 1);
  return (
    <div
      role="alert"
      className="card"
      style={{
        borderColor: "color-mix(in srgb, var(--danger) 45%, var(--card-bd))",
        marginBottom: 16,
      }}
    >
      <div style={{ display: "flex", gap: 11, alignItems: "flex-start" }}>
        <span
          aria-hidden
          className="sev-ic err"
          style={{
            width: 30,
            height: 30,
            borderRadius: 9,
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <ShieldAlert size={16} />
        </span>
        <div style={{ minWidth: 0 }}>
          <p style={{ fontSize: 13.5, fontWeight: 600, color: "var(--text)" }}>
            The log&apos;s tamper-evidence seal is broken at entry #{brokenAtId}
          </p>
          <p style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 4 }}>
            Verification failed at entry #{brokenAtId}
            {intactBefore > 0
              ? `; the ${intactBefore.toLocaleString()} ${
                  intactBefore === 1 ? "entry" : "entries"
                } checked before it verified intact.`
              : "."}{" "}
            This usually means the database was restored from a backup; it can
            also mean someone changed the log by hand. Entries from #
            {brokenAtId} onward should not be trusted until you know which it
            was.
          </p>
        </div>
      </div>
    </div>
  );
}
