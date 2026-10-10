"use client";
/**
 * WARP-3904 — "what's connected" as a card: every family (mailbox, Google,
 * Microsoft 365, calendar feed, catalog provider) in ONE status vocabulary, and
 * what is available to add.
 *
 * It reads only. Its two actions, "Reconnect" on a row and a pill under
 * "Available to connect", send an ordinary user turn ("Reconnect Stripe",
 * "Connect Stripe") that the model answers with a fresh connect card. Nothing
 * here holds a credential, opens a form or calls the box.
 */
import { useId } from "react";
import Link from "next/link";
import {
  CONNECTION_STATUS_LABEL,
  type AvailableConnection,
  type ConnectionRow,
  type ConnectionsOverview,
} from "@droplet/shared-types";
import { SafetyChip } from "@/components/integrations/SafetyChip";
import "./connect-card.css";

/** How many "Available to connect" pills show before "<n> more". */
export const MAX_AVAILABLE_PILLS = 9;

const ROLE_HINT = "Ask an owner or admin to connect this.";

export interface ConnectionsOverviewCardProps {
  overview: ConnectionsOverview;
  /** Send a quiet user turn. Called with "Connect <name>" or "Reconnect <name>". */
  onOutcome: (turn: string) => void;
}

function initialOf(name: string): string {
  return (Array.from(name.trim())[0] ?? "?").toUpperCase();
}

/** `detail · capabilities · your account | box-wide`, whatever is present. */
function detailLine(row: ConnectionRow): string {
  return [row.detail, row.capabilities.join(", "), row.scope === "personal" ? "your account" : "box-wide"]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" · ");
}

function Row({ row, onOutcome }: { row: ConnectionRow; onOutcome: (turn: string) => void }) {
  return (
    <li className="cc-row" data-testid="connection-row" data-status={row.status} data-provider={row.provider}>
      <span className="cc-logo is-small" aria-hidden="true">
        {initialOf(row.displayName)}
      </span>
      <div className="cc-row-main">
        <Link className="cc-row-name" href={row.manageHref}>
          {row.displayName}
        </Link>
        <p className="cc-row-detail">{detailLine(row)}</p>
        {row.statusDetail && <p className="cc-row-detail">{row.statusDetail}</p>}
      </div>
      <span className="cc-status">
        <span className={`cc-dot is-${row.status}`} aria-hidden="true" />
        {CONNECTION_STATUS_LABEL[row.status]}
      </span>
      {row.canReconnect && (
        <button type="button" className="cc-btn" onClick={() => onOutcome(`Reconnect ${row.displayName}`)}>
          Reconnect
        </button>
      )}
    </li>
  );
}

function Pill({ item, onOutcome }: { item: AvailableConnection; onOutcome: (turn: string) => void }) {
  const blocked = !item.canConnect;
  return (
    // The wrapper carries the tooltip too: a disabled button swallows its own title in some browsers.
    <span title={blocked ? ROLE_HINT : undefined}>
      <button
        type="button"
        className="cc-pill"
        disabled={blocked}
        title={blocked ? ROLE_HINT : undefined}
        onClick={() => onOutcome(`Connect ${item.displayName}`)}
      >
        {item.displayName}
      </button>
    </span>
  );
}

export function ConnectionsOverviewCard({ overview, onOutcome }: ConnectionsOverviewCardProps) {
  const titleId = useId();
  const connected = overview.connected.filter((r) => r.status === "connected").length;
  const needsAttention = overview.connected.filter((r) => r.status === "needs_attention").length;
  const available = overview.available;
  const shown = available.slice(0, MAX_AVAILABLE_PILLS);
  const more = available.length - shown.length;

  return (
    <section className="cc cc-wide" aria-labelledby={titleId} data-testid="connections-overview">
      <div className="cc-head">
        <div className="cc-titles">
          <h3 className="cc-title" id={titleId}>
            Connections
          </h3>
          <p className="cc-counts" data-testid="connections-counts">
            {connected} connected · {needsAttention} needs attention · {available.length} available
          </p>
        </div>
        <SafetyChip variant="read-lan" className="cc-chip" />
      </div>

      {overview.connected.length > 0 ? (
        <ul className="cc-rows" aria-label="Connected">
          {overview.connected.map((row) => (
            <Row key={row.id} row={row} onOutcome={onOutcome} />
          ))}
        </ul>
      ) : (
        <p className="cc-empty">Nothing is connected yet.</p>
      )}

      {available.length > 0 && (
        <>
          <p className="cc-section">Available to connect</p>
          <div className="cc-pills">
            {shown.map((item) => (
              <Pill key={`${item.family}:${item.provider}`} item={item} onOutcome={onOutcome} />
            ))}
            {more > 0 && (
              <Link className="cc-pill" href="/connectors">
                {more} more
              </Link>
            )}
          </div>
        </>
      )}

      <div className="cc-foot">
        <p>Box-wide connections need an owner or admin. Personal accounts are yours.</p>
        <Link className="cc-link" href="/connectors">
          Open Connectors
        </Link>
      </div>
    </section>
  );
}
