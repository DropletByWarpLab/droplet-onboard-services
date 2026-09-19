"use client";

/**
 * Eaglesoft connection status hero (design brief §4.1) — the answer at a
 * glance, in all four states (connected / needs-attention / can't-reach /
 * not-connected), plus the read/write mode pill and the primary action.
 * Renders inside ShellPage (.droplet-shell scope).
 */

import { Stethoscope, Lock, PlugZap, ShieldCheck } from "lucide-react";
import type { IntegrationConnection } from "@/lib/erp-types";
import { disconnectedCredentialView } from "@/lib/credential-purge";
import { writeModeOf } from "@/lib/erp-types";
import { syncedAgo } from "@/lib/erp-format";

interface HeroView {
  color: string;
  headline: string;
}

function heroView(c: IntegrationConnection): HeroView {
  switch (c.status) {
    case "CONNECTED":
      return { color: "var(--color-system-green)", headline: "Connected to Eaglesoft" };
    case "DEGRADED":
    case "DRIFT_LOCKED":
      return { color: "var(--color-system-orange)", headline: "Eaglesoft needs attention" };
    case "ERROR":
      return { color: "var(--color-system-red)", headline: "Can't reach Eaglesoft" };
    case "PROVISIONING":
      return { color: "var(--color-system-orange)", headline: "Waiting for setup" };
    case "DISABLED":
      return { color: "var(--text-muted)", headline: "Disconnected" };
    case "NOT_CONFIGURED":
    default:
      return { color: "var(--text-muted)", headline: "Not connected" };
  }
}

function Subline({ c }: { c: IntegrationConnection }) {
  const mono: React.CSSProperties = { fontFamily: "var(--font-mono, ui-monospace, monospace)" };
  if (c.status === "CONNECTED") {
    return (
      <span>
        Synced {syncedAgo(c.lastSyncedAt)} · database{" "}
        <span style={mono}>{c.databaseName ?? "PattersonPM"}</span>
        {c.schemaVersion ? <> · <span style={mono}>{c.schemaVersion}</span></> : null}
        {" "}· {c.writeEnabled ? "writes enabled" : "read-only"}
      </span>
    );
  }
  if (c.status === "NOT_CONFIGURED") {
    return <>Connect Droplet to your Eaglesoft server to see your schedule and patients here.</>;
  }
  // WARP-2483 — a deliberately disconnected connection is not a connection
  // that broke, and "Droplet can't read Eaglesoft right now" reads as a fault.
  // When the box told us what happened to the credential, say that instead.
  const disconnected = disconnectedCredentialView(
    c.status === "DISABLED",
    c.credentialsPurged,
  );
  if (disconnected) return <>{disconnected.line}</>;
  return <>{c.reason ?? "Droplet can't read Eaglesoft right now."}</>;
}

export function ConnectionHero({
  connection,
  onConnect,
  onManage,
}: {
  connection: IntegrationConnection;
  onConnect: () => void;
  onManage: () => void;
}) {
  const view = heroView(connection);
  const mode = writeModeOf(connection);
  const isConnected = connection.status === "CONNECTED";
  const isTrouble =
    connection.status === "DEGRADED" ||
    connection.status === "DRIFT_LOCKED" ||
    connection.status === "ERROR";
  /**
   * WARP-2483 — disconnected, and the box says the credential is STILL stored.
   *
   * This is where the hub tile's "Remove credential" action lands, so the
   * action has to exist here: Disconnect lives in `ManageSheet`, which is what
   * `onManage` opens. Without this branch the hero offered only "Connect
   * Eaglesoft" and an owner who asked to finish removing a key arrived at a
   * button that stores a second one.
   *
   * The purged case deliberately does NOT get it — there is nothing left to
   * remove, and setup is the only thing left to do.
   */
  const credentialRetained =
    disconnectedCredentialView(
      connection.status === "DISABLED",
      connection.credentialsPurged,
    )?.purged === false;

  return (
    <div className="card" style={{ display: "flex", alignItems: "center", gap: 20, flexWrap: "wrap" }}>
      <span
        aria-hidden
        style={{
          width: 72,
          height: 72,
          borderRadius: "50%",
          border: `3px solid ${view.color}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: view.color,
          flexShrink: 0,
        }}
      >
        <Stethoscope size={30} strokeWidth={1.75} />
      </span>

      <div style={{ flex: 1, minWidth: 200 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span className="type-headline text-label-primary">{view.headline}</span>
          <span
            className="badge"
            style={{
              background: mode === "read-only" ? "var(--inset)" : "rgba(217,163,92,0.16)",
              color: mode === "read-only" ? "var(--text-muted)" : "#b45309",
            }}
          >
            {mode === "read-only" ? <Lock size={11} /> : <PlugZap size={11} />}
            {mode === "read-only" ? "Read-only" : mode === "writes-paused" ? "Writes paused" : "Writes enabled"}
          </span>
        </div>
        <p className="type-subheadline text-label-secondary" style={{ marginTop: 6, lineHeight: 1.5 }}>
          <Subline c={connection} />
        </p>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
        {isConnected ? (
          <button type="button" className="btn" onClick={onManage}>
            <ShieldCheck size={15} /> Manage
          </button>
        ) : credentialRetained ? (
          <button type="button" className="btn primary" onClick={onManage}>
            <ShieldCheck size={15} /> Remove credential
          </button>
        ) : isTrouble ? (
          <button type="button" className="btn primary" onClick={onConnect}>
            Fix connection
          </button>
        ) : (
          <button type="button" className="btn primary" onClick={onConnect}>
            Connect Eaglesoft
          </button>
        )}
      </div>
    </div>
  );
}
