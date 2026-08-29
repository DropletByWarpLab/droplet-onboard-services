"use client";

/**
 * Eaglesoft ERP dashboard (/integrations/eaglesoft) — the practice, read live
 * from Eaglesoft on the LAN (design brief §4, §6, §7). Every region is driven
 * by connection.status; PHI is RBAC-gated. WARP-1101.
 */

import { useState } from "react";
import { Stethoscope, Lock, AlertTriangle, RefreshCw } from "lucide-react";
import { ShellPage } from "@/components/shell/ShellPage";
import { SafetyChip } from "@/components/integrations/SafetyChip";
import { ConnectWizard } from "@/components/integrations/ConnectWizard";
import { ConnectionHero } from "@/components/erp/ConnectionHero";
import { KpiStrip } from "@/components/erp/KpiStrip";
import { ScheduleList } from "@/components/erp/ScheduleList";
import { PatientSearch } from "@/components/erp/PatientSearch";
import { PatientPeek, type PatientPeekTarget } from "@/components/erp/PatientPeek";
import { SyncFooter } from "@/components/erp/SyncFooter";
import { ManageSheet } from "@/components/erp/ManageSheet";
import { NewAppointmentDialog } from "@/components/erp/NewAppointmentDialog";
import { WriteConfirmModal } from "@/components/erp/WriteConfirmModal";
import { useEaglesoft, useEaglesoftSchedule, useErpAccess } from "@/lib/hooks/useEaglesoft";
import { setProviderWrites, disconnectProvider } from "@/lib/api.erp";
import { formatDayLabel, syncedAgo } from "@/lib/erp-format";
import { writeModeOf, type AppointmentWriteRequest } from "@/lib/erp-types";

const DATA_STATUSES = new Set(["CONNECTED", "DEGRADED", "DRIFT_LOCKED"]);

export default function EaglesoftPage() {
  const { connection, kpis, schedule, refresh } = useEaglesoft();
  const access = useErpAccess();

  const [wizardOpen, setWizardOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [newApptOpen, setNewApptOpen] = useState(false);
  const [peek, setPeek] = useState<PatientPeekTarget | null>(null);
  const [pendingWrite, setPendingWrite] = useState<AppointmentWriteRequest | null>(null);
  const [dayOffset, setDayOffset] = useState(0);

  const status = connection.status;
  const showData = access.canViewPhi && DATA_STATUSES.has(status);
  const writesEnabled = writeModeOf(connection) === "writes-enabled";

  const day = new Date();
  day.setDate(day.getDate() + dayOffset);
  const dateLabel = formatDayLabel(day.toISOString());

  // Today's schedule rides on the base snapshot (polled every 30s); other days
  // are fetched on demand and cached per-date. Skip the fetch when today or
  // when data isn't shown (not connected / RBAC-locked).
  const isToday = dayOffset === 0;
  const otherDay = useEaglesoftSchedule(showData && !isToday ? day.toISOString().slice(0, 10) : null);
  const entries = isToday ? schedule : otherDay.entries;

  // WARP-2500 — both verbs are addressed to `connection.provider`, the key the
  // row itself carries, rather than to a hardcoded "eaglesoft". This page is
  // reached only for the Eaglesoft connection today, so the VALUE is the same;
  // what changes is that the value now comes from the connection being acted
  // on. When a second surface reuses these handlers, it cannot silently act on
  // the wrong connector, and the request no longer depends on the deprecated
  // literal alias routes.
  async function toggleWrites(next: boolean) {
    try {
      await setProviderWrites(connection.provider, next);
    } catch {
      /* backend not wired yet — surfaced elsewhere; refresh keeps UI honest */
    }
    refresh();
  }
  async function disconnect() {
    try {
      await disconnectProvider(connection.provider);
    } catch {
      /* no-op if backend absent */
    }
    refresh();
  }

  return (
    <ShellPage
      icon={<Stethoscope size={15} />}
      label="Eaglesoft"
      title="Eaglesoft"
      sub="Your practice — read live from Eaglesoft, on your network."
      actions={<SafetyChip variant="read-phi" />}
    >
      <ConnectionHero
        connection={connection}
        onConnect={() => setWizardOpen(true)}
        onManage={() => setManageOpen(true)}
      />

      {/* Degraded / drift banner — one line, one action; worst problem wins */}
      {status === "DRIFT_LOCKED" && (
        <StateBanner
          tone="warn"
          text="Eaglesoft was updated, so Droplet paused writing and is re-checking the data before it trusts it."
          action="Re-check now"
          onAction={refresh}
        />
      )}
      {status === "DEGRADED" && (
        <StateBanner
          tone="warn"
          text={`Showing what Droplet last read ${syncedAgo(connection.lastSyncedAt)} — it can't reach the Eaglesoft server right now.`}
          action="Retry"
          onAction={refresh}
        />
      )}

      {/* KPI strip: shown when connected (real values) or not-connected (em-dash
          placeholders per §7.2). Hidden for hard-error / RBAC-locked. */}
      {(showData || status === "NOT_CONFIGURED") && <KpiStrip kpis={showData ? kpis : undefined} />}

      {/* RBAC lock — connected but this user can't see PHI (§7.10) */}
      {DATA_STATUSES.has(status) && !access.canViewPhi && (
        <div className="card">
          <div className="empty">
            <span className="ei" aria-hidden><Lock size={22} /></span>
            <div className="eh">Patient data is restricted</div>
            <p className="type-footnote">You don&rsquo;t have permission to view patient data. Ask an admin.</p>
          </div>
        </div>
      )}

      {showData && (
        <>
          <ScheduleList
            entries={entries}
            dateLabel={dateLabel}
            writeEnabled={writesEnabled && access.canConfirmWrites}
            onPrevDay={() => setDayOffset((d) => d - 1)}
            onNextDay={() => setDayOffset((d) => d + 1)}
            onSyncNow={refresh}
            onSchedule={() => setNewApptOpen(true)}
            onSelect={(e) => setPeek({ id: e.patientId, name: e.patientName })}
          />
          <PatientSearch onSelect={(p) => setPeek(p)} />
          <SyncFooter connection={connection} onSyncNow={refresh} />
        </>
      )}

      {/* Modals & panels */}
      <ConnectWizard
        catalogId={wizardOpen ? "eaglesoft" : null}
        onClose={() => setWizardOpen(false)}
        onConnected={refresh}
      />
      <ManageSheet
        open={manageOpen}
        onClose={() => setManageOpen(false)}
        connection={connection}
        canToggleWrites={access.canEnableWrites}
        onToggleWrites={toggleWrites}
        onSyncNow={refresh}
        onDisconnect={disconnect}
      />
      <PatientPeek patient={peek} open={peek !== null} onClose={() => setPeek(null)} />
      <NewAppointmentDialog
        open={newApptOpen}
        onClose={() => setNewApptOpen(false)}
        onReady={(req) => {
          setNewApptOpen(false);
          setPendingWrite(req);
        }}
      />
      <WriteConfirmModal
        request={pendingWrite}
        open={pendingWrite !== null}
        onClose={() => setPendingWrite(null)}
        onDone={refresh}
      />
    </ShellPage>
  );
}

function StateBanner({
  tone,
  text,
  action,
  onAction,
}: {
  tone: "warn" | "danger";
  text: string;
  action: string;
  onAction: () => void;
}) {
  const color = tone === "warn" ? "var(--color-system-orange)" : "var(--color-system-red)";
  return (
    <div
      className="card"
      style={{ display: "flex", alignItems: "center", gap: 12, borderColor: color, background: "color-mix(in srgb, var(--color-system-orange) 8%, var(--card-bg))" }}
    >
      <AlertTriangle size={18} style={{ color, flexShrink: 0 }} />
      <span className="type-footnote text-label-primary" style={{ flex: 1 }}>{text}</span>
      <button type="button" className="btn sm" onClick={onAction}>
        <RefreshCw size={13} /> {action}
      </button>
    </div>
  );
}
