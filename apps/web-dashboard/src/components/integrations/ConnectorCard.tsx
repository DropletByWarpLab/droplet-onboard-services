"use client";

/**
 * A single connector tile in the Integrations hub catalog (design brief §3.2).
 * Renders inside ShellPage (.droplet-shell scope) so it uses the shell `.card`
 * / `.btn` classes and the `Badge` primitive.
 *
 * WARP-2291: the tile renders an explicit {@link ConnectionState} rather than a
 * connection row that may have been fabricated from a `Map` miss, and it takes
 * the dispatch its buttons perform as data. If the action for the state it is
 * in is `unavailable`, it draws a disabled button plus the reason — a live
 * button whose click does nothing is the failure this component is not allowed
 * to render.
 */

import { AlertTriangle } from "lucide-react";
import { Badge } from "@/components/shell/primitives";
import type { HubEntry } from "@/lib/hooks/useIntegrations";
import { connectorIcon, statusView } from "./connector-visuals";

export function ConnectorCard({
  entry,
  onConnect,
  onOpen,
}: {
  entry: Pick<HubEntry, "meta" | "state" | "connect" | "open">;
  onConnect: () => void;
  onOpen: () => void;
}) {
  const { meta, state } = entry;
  const Icon = connectorIcon(meta.id);

  // A status exists only when the box actually reported one. "Still loading"
  // and "the read failed" are states of the request, not of the connection.
  const status = state.kind === "reported" ? state.connection.status : null;
  const sv = status ? statusView(status) : null;

  // WARP-2291: a tile the box reports an actual connection for cannot claim to
  // be coming soon — that would be the hub denying a connection that exists,
  // which is precisely what the broken status join used to do to a connected
  // QuickBooks Online. The availability flag stays authoritative everywhere
  // else (it is WARP-2123's to set); a reported NOT_CONFIGURED does not
  // override it, because that is the box agreeing there is nothing there.
  const comingSoon =
    meta.availability === "coming-soon" &&
    (status === null || status === "NOT_CONFIGURED");

  const isConnected = status === "CONNECTED";
  const needsAttention = status === "DEGRADED" || status === "DRIFT_LOCKED";
  const errored = status === "ERROR";
  const pending = status === "PROVISIONING";

  // Connected and needs-attention tiles go to the detail surface; everything
  // else runs the setup flow. Whichever it is, the tile knows whether that
  // action can actually happen.
  const usesOpen = isConnected || needsAttention;
  const action = usesOpen ? entry.open : entry.connect;
  const handler = usesOpen ? onOpen : onConnect;
  const label = isConnected
    ? "Open"
    : needsAttention
      ? "Fix connection"
      : errored
        ? "Retry"
        : pending
          ? "Resume setup"
          : "Connect";
  const primary = !usesOpen && !errored && !pending;

  return (
    <div className="card" style={comingSoon ? { opacity: 0.6 } : undefined}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <span
          aria-hidden
          style={{
            width: 34,
            height: 34,
            borderRadius: 9,
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "var(--brand-subtle)",
            color: "var(--brand)",
          }}
        >
          <Icon size={18} strokeWidth={1.75} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              justifyContent: "space-between",
            }}
          >
            <span className="type-headline text-label-primary">{meta.name}</span>
            {comingSoon ? (
              <span className="type-caption-1 text-label-tertiary">Coming soon</span>
            ) : state.kind === "loading" ? (
              <span className="type-caption-1 text-label-tertiary">Checking…</span>
            ) : state.kind === "error" ? (
              <Badge kind="danger">
                <AlertTriangle size={11} strokeWidth={2} aria-hidden />
                Status unavailable
              </Badge>
            ) : sv ? (
              <Badge kind={sv.kind}>
                <sv.icon size={11} strokeWidth={2} aria-hidden />
                {sv.label}
              </Badge>
            ) : null}
          </div>
          <span className="type-caption-1 text-label-tertiary">{meta.category}</span>
        </div>
      </div>

      <p
        className="type-footnote text-label-secondary"
        style={{ margin: "12px 0 16px", lineHeight: 1.5 }}
      >
        {meta.description}
      </p>

      {state.kind === "error" && (
        <p className="type-caption-1 text-label-tertiary" style={{ margin: "0 0 12px" }} role="status">
          {state.message}
        </p>
      )}

      {comingSoon ? (
        <span className="type-caption-1 text-label-tertiary">Available in a future update</span>
      ) : state.kind === "loading" ? (
        <button type="button" className="btn" disabled>
          Checking…
        </button>
      ) : action.kind === "unavailable" ? (
        <>
          <button type="button" className="btn" disabled>
            {label}
          </button>
          <p className="type-caption-1 text-label-tertiary" style={{ margin: "8px 0 0" }}>
            {action.reason}
          </p>
        </>
      ) : (
        <button
          type="button"
          className={primary ? "btn primary" : "btn"}
          onClick={handler}
        >
          {label}
        </button>
      )}
    </div>
  );
}
