"use client";

/**
 * A single connector tile in the Integrations hub catalog (design brief §3.2).
 * Renders inside ShellPage (.droplet-shell scope) so it uses the shell `.card`
 * / `.btn` classes and the `Badge` primitive.
 */

import { Badge } from "@/components/shell/primitives";
import type { HubEntry } from "@/lib/hooks/useIntegrations";
import { connectorIcon, statusView } from "./connector-visuals";

export function ConnectorCard({
  entry,
  onConnect,
  onOpen,
}: {
  entry: HubEntry;
  onConnect: () => void;
  onOpen: () => void;
}) {
  const { meta, connection } = entry;
  const Icon = connectorIcon(meta.id);
  const comingSoon = meta.availability === "coming-soon";
  const { status } = connection;
  const sv = statusView(status);

  const isConnected = status === "CONNECTED";
  const needsAttention = status === "DEGRADED" || status === "DRIFT_LOCKED";
  const errored = status === "ERROR";
  const pending = status === "PROVISIONING";
  const showPill = !comingSoon && status !== "NOT_CONFIGURED";

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
            {showPill ? (
              <Badge kind={sv.kind}>
                <sv.icon size={11} strokeWidth={2} aria-hidden />
                {sv.label}
              </Badge>
            ) : comingSoon ? (
              <span className="type-caption-1 text-label-tertiary">Coming soon</span>
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

      {comingSoon ? null : isConnected ? (
        <button type="button" className="btn" onClick={onOpen}>
          Open
        </button>
      ) : needsAttention ? (
        <button type="button" className="btn" onClick={onOpen}>
          Fix connection
        </button>
      ) : errored ? (
        <button type="button" className="btn" onClick={onConnect}>
          Retry
        </button>
      ) : pending ? (
        <button type="button" className="btn" onClick={onConnect}>
          Resume setup
        </button>
      ) : (
        <button type="button" className="btn primary" onClick={onConnect}>
          Connect
        </button>
      )}
    </div>
  );
}
