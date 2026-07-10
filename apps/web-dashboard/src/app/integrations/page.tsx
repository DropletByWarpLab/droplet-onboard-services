"use client";

/**
 * Integrations hub (/integrations) — every system Droplet can connect to, in
 * one place (design brief §3). Eaglesoft is the flagship connector; the rest
 * are framework placeholders so the hub reads as N-provider. WARP-1101.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Blocks, ShieldCheck, ChevronRight } from "lucide-react";
import { ShellPage } from "@/components/shell/ShellPage";
import { Sect } from "@/components/shell/primitives";
import { useIntegrations, type HubEntry } from "@/lib/hooks/useIntegrations";
import { ConnectorCard } from "@/components/integrations/ConnectorCard";
import { ConnectWizard } from "@/components/integrations/ConnectWizard";
import { connectorIcon } from "@/components/integrations/connector-visuals";
import { syncedAgo } from "@/lib/erp-format";
import { writeModeOf } from "@/lib/erp-types";

export default function IntegrationsPage() {
  const router = useRouter();
  const { entries, connected, refresh } = useIntegrations();
  const [wizardOpen, setWizardOpen] = useState(false);

  const openConnector = (e: HubEntry) => {
    if (e.meta.id === "eaglesoft") router.push("/integrations/eaglesoft");
  };
  const connectConnector = (e: HubEntry) => {
    if (e.meta.id === "eaglesoft") setWizardOpen(true);
  };

  const nothingConnected = connected.length === 0;

  return (
    <ShellPage
      icon={<Blocks size={15} />}
      label="Integrations"
      title="Integrations"
      sub="Systems Droplet connects to — all on your network."
    >
      {/* Connected strip */}
      {connected.length > 0 && (
        <>
          <Sect title="Connected" />
          <div className="card" style={{ padding: 6 }}>
            <div className="rows">
              {connected.map((e) => {
                const Icon = connectorIcon(e.meta.id);
                const mode = writeModeOf(e.connection);
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
                        Connected · synced {syncedAgo(e.connection.lastSyncedAt)} ·{" "}
                        {mode === "writes-enabled" ? "writes enabled" : mode === "writes-paused" ? "writes paused" : "read-only"}
                      </span>
                    </span>
                    <span className="badge muted" style={{ gap: 5 }}>
                      <ShieldCheck size={11} /> On this box only
                    </span>
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
      <div className="grid c3 stagger">
        {entries.map((e) => (
          <ConnectorCard
            key={e.meta.id}
            entry={e}
            onConnect={() => connectConnector(e)}
            onOpen={() => openConnector(e)}
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
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onConnected={() => refresh()}
      />
    </ShellPage>
  );
}
