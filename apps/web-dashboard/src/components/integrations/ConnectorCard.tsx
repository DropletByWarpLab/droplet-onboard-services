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

import { AlertTriangle, BookOpen } from "lucide-react";
import { Badge } from "@/components/shell/primitives";
import { disconnectedCredentialView } from "@/lib/credential-purge";
import { credentialExpiryCopy } from "@/lib/credential-expiry";
import type { HubEntry } from "@/lib/hooks/useIntegrations";
import { connectorIcon, statusView } from "./connector-visuals";
import { DisconnectControl } from "./DisconnectControl";

export function ConnectorCard({
  entry,
  onConnect,
  onOpen,
  onDisconnected,
}: {
  entry: Pick<HubEntry, "meta" | "state" | "connect" | "open">;
  onConnect: () => void;
  onOpen: () => void;
  /** WARP-2518 — fired after the box confirmed a disconnect. The hub answers
   *  by re-reading, which is how the purge line appears on this very tile. */
  onDisconnected?: () => void;
}) {
  const { meta, state } = entry;
  const Icon = connectorIcon(meta.id);

  // A status exists only when the box actually reported one. "Still loading"
  // and "the read failed" are states of the request, not of the connection.
  const reported = state.kind === "reported" ? state.connection : null;
  const status = reported ? reported.status : null;
  const sv = reported ? statusView(reported.status, reported.credentialsPurged) : null;

  /**
   * WARP-2659 — "for how much longer", beside "does it work".
   *
   * Only from a REPORTED connection: a tile in `loading`/`error`/`absent` has
   * no verdict, and the box is the only thing that computes one. Rendered
   * through the shared `credentialExpiryCopy` so this tile and the credential
   * configurator cannot phrase one credential two ways, and null for every
   * provider whose credential has no hard stop.
   */
  const expiry = reported ? credentialExpiryCopy(reported.credentialExpiry) : null;

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
  /**
   * WARP-2623 — connected, with one dataset refused.
   *
   * It sits with the connected tiles and NOT with the errored ones, because
   * every other branch below offers the owner a credential: "Retry" re-runs
   * the probe against a key that is fine, and "Connect" runs the setup wizard
   * and stores a SECOND credential beside the working one. The fix is a plan
   * or a scope grant in the vendor's console, so the only action this tile can
   * honestly offer is the detail surface — which is also where Disconnect
   * lives, and disconnecting stays available exactly as it is for CONNECTED.
   */
  const capabilityLimited = status === "CAPABILITY_LIMITED";
  const needsAttention = status === "DEGRADED" || status === "DRIFT_LOCKED";
  const errored = status === "ERROR";
  const pending = status === "PROVISIONING";

  /**
   * WARP-2483 — disconnected, and the credential is STILL on the row.
   *
   * The only state whose action is neither "connect" nor "nothing". The owner
   * already asked for the key to be removed and it was not, so the tile has to
   * offer that path again — running the setup wizard would store a *second*
   * credential while the first one sits there, which is the opposite of what
   * they asked for. Disconnect lives on the connector's own surface
   * (`ManageSheet`), so this reuses the descriptor's `open` action and inherits
   * its honesty: a connector with no detail surface renders the stated reason
   * instead of a button that cannot finish the job.
   */
  // Computed from the reported flag, NOT read back off the badge `kind` the
  // pill happens to use — a behaviour inferred from a presentation choice is
  // one restyling away from silently changing what a button does.
  const credentialRetained =
    disconnectedCredentialView(status === "DISABLED", reported?.credentialsPurged)
      ?.purged === false;

  // Connected and needs-attention tiles go to the detail surface; everything
  // else runs the setup flow. Whichever it is, the tile knows whether that
  // action can actually happen.
  /**
   * WARP-2518 — whether this tile offers Disconnect at all.
   *
   * The rule is stated over what the BOX reported, never over the tile's own
   * availability flag: the point of the control is to reach a connection the
   * catalog may not even list. Three exclusions, each for its own reason:
   *
   *  - no reported row, or `NOT_CONFIGURED`: there is nothing to disconnect,
   *    and a destructive control on a connector that was never set up is an
   *    invitation to a confirmation dialog with no subject.
   *  - `DISABLED` with `credentialsPurged === true`: the box just said the key
   *    is gone. Offering to remove it again would contradict the line rendered
   *    directly above the button.
   *
   * `DISABLED` with the purge fact ABSENT or `false` keeps the control, and
   * that is the case that matters most — "disconnected, key still stored" is
   * precisely the state whose remedy was previously reachable only through
   * `ManageSheet`, i.e. only for a provider with a detail page.
   */
  const disconnectable =
    reported !== null &&
    status !== "NOT_CONFIGURED" &&
    !(status === "DISABLED" && reported.credentialsPurged === true);

  const usesOpen = isConnected || capabilityLimited || needsAttention || credentialRetained;
  const action = usesOpen ? entry.open : entry.connect;
  const handler = usesOpen ? onOpen : onConnect;
  const label = isConnected || capabilityLimited
    ? "Open"
    : needsAttention
      ? "Fix connection"
      : credentialRetained
        ? "Remove credential"
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

      {/* WARP-2483 — the state line. Only rendered when the box gave an answer
          that the pill alone cannot carry; there is no placeholder for "we
          weren't told", because a line of hedging reads as a problem. */}
      {sv?.detail && (
        <p
          className="type-caption-1 text-label-tertiary"
          style={{ margin: "-6px 0 16px" }}
          data-testid="connector-state-line"
        >
          {sv.detail}
        </p>
      )}

      {/* WARP-2659 — the expiry line. Its own line rather than a second badge,
          for the reason `StatusView.detail` gives: `.badge` is
          `flex-shrink: 0`, so a sentence in a pill pushes the connector's name
          out of its own card. */}
      {expiry && (
        <p
          className={`type-caption-1 ${expiry.tone === "warn" ? "text-system-red" : "text-label-tertiary"}`}
          style={{ margin: "-6px 0 16px" }}
          data-testid="connector-expiry-line"
        >
          {expiry.label}
        </p>
      )}

      {state.kind === "error" && (
        <p className="type-caption-1 text-label-tertiary" style={{ margin: "0 0 12px" }} role="status">
          {state.message}
        </p>
      )}

      {/* WARP-2342 — the setup guide, on the card as well as in the wizard.
          A cloud provider's credential is made in a vendor console we do not
          control, so the click-path has to be reachable from wherever the
          owner is looking. Rendered only when the provider declares one. */}
      {meta.setupGuideHref && (
        <p style={{ margin: "0 0 12px" }}>
          <a
            href={meta.setupGuideHref}
            target="_blank"
            rel="noreferrer"
            className="type-caption-1 text-accent"
            style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
          >
            <BookOpen size={12} strokeWidth={1.75} aria-hidden />
            Setup guide
          </a>
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

      {/* WARP-2518 — Disconnect, on the tile. Below the primary action and
          separated from it, because it is the destructive one and must not sit
          where a click aimed at Connect could land. `provider` is the key the
          BOX reported, not `meta.id`: those two are byte-equal for exactly one
          vendor, and using the catalog id here would rebuild the join defect
          WARP-2291 removed — a disconnect addressed to `quickbooks` when the
          row the tile is showing is `quickbooks-online`. Renders nothing for a
          non-admin (the control's own gate). */}
      {!comingSoon && disconnectable && reported && (
        <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
          <DisconnectControl
            provider={reported.provider}
            displayName={meta.name}
            onDisconnected={onDisconnected}
          />
        </div>
      )}
    </div>
  );
}
