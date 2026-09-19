"use client";

/**
 * Integrations hub (/integrations) — every system Droplet can connect to, in
 * one place (design brief §3). WARP-1101.
 *
 * WARP-2291: dispatch is data, not a vendor name. Both handlers used to be a
 * bare equality test against a single hardcoded vendor id, with no `else`, so
 * Connect on any other tile called a function that did nothing and returned —
 * no navigation, no wizard, no error, indistinguishable from a slow page.
 * Every tile now carries its own `connect`/`open` action from the provider
 * descriptor, and the one branch that cannot act says why out loud. No vendor
 * id appears in this file at all any more, and a test asserts that.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Blocks, ShieldCheck, ChevronRight, AlertTriangle } from "lucide-react";
import { ShellPage } from "@/components/shell/ShellPage";
import { Sect } from "@/components/shell/primitives";
import { useIntegrations, type HubEntry } from "@/lib/hooks/useIntegrations";
import { ConnectorCard } from "@/components/integrations/ConnectorCard";
import { ConnectWizard } from "@/components/integrations/ConnectWizard";
import { connectorIcon } from "@/components/integrations/connector-visuals";
import type { ConnectAction } from "@/components/integrations/provider-descriptors";
import { syncedAgo } from "@/lib/erp-format";
import { writeModeOf } from "@/lib/erp-types";

export default function IntegrationsPage() {
  const router = useRouter();
  const { entries, connected, error, refresh } = useIntegrations();
  // WHICH tile opened the wizard, not merely THAT one did (WARP-2451). A
  // boolean could only ever open one vendor's form, which is the whole defect
  // one layer down from the dispatch WARP-2291 fixed.
  const [wizardFor, setWizardFor] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<{ name: string; reason: string } | null>(null);

  /**
   * The whole dispatch. Exhaustive over `ConnectAction`, so a tile can only
   * navigate, open the wizard, or say why it can do neither — there is no path
   * out of this function that leaves the click unanswered.
   */
  const run = (e: HubEntry, action: ConnectAction) => {
    switch (action.kind) {
      case "route":
        setBlocked(null);
        router.push(action.href);
        return;
      case "wizard":
        setBlocked(null);
        setWizardFor(action.catalogId);
        return;
      case "unavailable":
        setBlocked({ name: e.meta.name, reason: action.reason });
        return;
    }
  };

  const openConnector = (e: HubEntry) => run(e, e.open);
  const connectConnector = (e: HubEntry) => run(e, e.connect);

  const nothingConnected = connected.length === 0;

  return (
    <ShellPage
      icon={<Blocks size={15} />}
      label="Integrations"
      title="Integrations"
      sub="Systems Droplet connects to — all on your network."
    >
      {/* A failed status read is a fact the owner is told, not one smoothed
          into an empty, healthy-looking hub. */}
      {error && (
        <div className="card" role="alert" style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
          <AlertTriangle size={16} className="shrink-0" style={{ marginTop: 1, color: "var(--danger)" }} aria-hidden />
          <span className="type-footnote text-label-secondary">
            {error} What you see below may be out of date.
          </span>
        </div>
      )}

      {/* Connected strip */}
      {connected.length > 0 && (
        <>
          <Sect title="Connected" />
          <div className="card" style={{ padding: 6 }}>
            <div className="rows">
              {connected.map((e) => {
                const Icon = connectorIcon(e.meta.id);
                const conn = e.state.connection;
                const mode = writeModeOf(conn);
                return (
                  <button
                    key={e.meta.id}
                    type="button"
                    className="lrow ev-row"
                    style={{ width: "100%", textAlign: "left", background: "transparent", border: 0, cursor: "pointer" }}
                    onClick={() => openConnector(e)}
                  >
                    <span className="ri brand" aria-hidden><Icon size={17} /></span>
                    <span className="rt">
                      <span className="nm">{e.meta.name}</span>
                      <span className="sub">
                        {/* WARP-2659 — the sync clause is dropped for a track
                            that does not sync. `syncedAgo(undefined)` is the
                            string "never", so a connected MCP provider would
                            otherwise read "Connected · synced never" and send
                            the owner looking for a broken sync that does not
                            exist on this track. */}
                        Connected ·{e.syncs ? ` synced ${syncedAgo(conn.lastSyncedAt)} ·` : ""}{" "}
                        {mode === "writes-enabled" ? "writes enabled" : mode === "writes-paused" ? "writes paused" : "read-only"}
                      </span>
                    </span>
                    {/* WARP-2659 — the badge describes the SYNCED COPY: the
                        datasets a LAN or cloud track lands on this box and
                        nowhere else. A track that syncs nothing has no copy to
                        describe, and its tile already says so ("nothing is
                        copied onto the box"); rendering the badge there would
                        claim a residency for data the box never holds. Gated
                        on the same `syncs` fact that drops the "synced …"
                        clause above, because it is the same fact — the
                        dashboard descriptor carries no track, and `syncs` is
                        the per-track statement of exactly this. */}
                    {e.syncs && (
                      <span className="badge muted" style={{ gap: 5 }}>
                        <ShieldCheck size={11} /> On this box only
                      </span>
                    )}
                    <ChevronRight size={16} className="text-label-tertiary" />
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}

      {/* First-run empty state */}
      {nothingConnected && (
        <div className="empty" style={{ paddingBottom: 8 }}>
          <span className="ei" aria-hidden><Blocks size={24} /></span>
          <div className="eh">Connect your first system</div>
          <p className="type-footnote" style={{ maxWidth: 420 }}>
            Start with Eaglesoft — Droplet will read your schedule and patients right from your own network.
          </p>
        </div>
      )}

      {/* Catalog */}
      <Sect title="Available" />

      {/* Why the last click could not do anything. Shown because a click that
          silently returns is worse than one that explains itself. */}
      {blocked && (
        <p
          className="type-footnote text-label-secondary"
          role="status"
          data-testid="hub-blocked-reason"
          style={{ marginBottom: 12 }}
        >
          <strong>{blocked.name}:</strong> {blocked.reason}
        </p>
      )}

      <div className="grid c3 stagger">
        {entries.map((e) => (
          <ConnectorCard
            key={e.meta.id}
            entry={e}
            onConnect={() => connectConnector(e)}
            onOpen={() => openConnector(e)}
            // WARP-2518 — the same re-read the wizard's `onConnected` triggers.
            // It is what makes the tile's own `credentialsPurged` line appear:
            // the hub asserts nothing about the disconnect itself, it just asks
            // the box again.
            onDisconnected={() => refresh()}
          />
        ))}
      </div>

      {/* Safety footer */}
      <p
        className="type-caption-1 text-label-tertiary"
        style={{ marginTop: 24, display: "flex", alignItems: "flex-start", gap: 8, maxWidth: 720 }}
      >
        <ShieldCheck size={14} className="shrink-0" style={{ marginTop: 1 }} />
        Droplet connects to these systems over your local network only. Nothing is sent to us or to
        the cloud, and you can disconnect any time.
      </p>

      <ConnectWizard
        catalogId={wizardFor}
        onClose={() => setWizardFor(null)}
        onConnected={() => refresh()}
      />
    </ShellPage>
  );
}
