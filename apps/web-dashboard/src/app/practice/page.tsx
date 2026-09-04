"use client";

/**
 * Practice (/practice) — the practice's day, read live from Eaglesoft on the
 * LAN (design brief §4, §6, §7). Every region is driven by connection.status;
 * PHI is RBAC-gated. WARP-1101.
 *
 * WARP-2560 (ADR-044) — moved here from /integrations/eaglesoft, unchanged.
 * It was filed under Operations → Integrations, beside the router and the
 * remote-access toggle, because that is where the CONNECTION is configured.
 * But this page is not a connection screen: it is the schedule, the day's
 * KPIs and patient lookup — the operational core of the customer's business.
 * The connection surface stayed in Operations; the data surface belongs in
 * Business, next to Customers and Projects.
 *
 * The old route still resolves — see app/integrations/eaglesoft/page.tsx.
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
import { setProviderWrites } from "@/lib/api.erp";
import { lifecycleErrorMessage } from "@/lib/lifecycle-errors";
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

  // WARP-2500 — the verb is addressed to `connection.provider`, the key the row
  // itself carries, rather than to a hardcoded "eaglesoft". This page is
  // reached only for the Eaglesoft connection today, so the VALUE is the same;
  // what changes is that the value now comes from the connection being acted
  // on. When a second surface reuses this handler, it cannot silently act on
  // the wrong connector, and the request no longer depends on the deprecated
  // literal alias routes.
  //
  // WARP-2519 — and it no longer swallows the failure. This was `catch {}` with
  // the comment "backend not wired yet — surfaced elsewhere", and it was not
  // surfaced elsewhere: `refresh()` re-read the unchanged connection and the
  // toggle sprang back with no message, no banner and no console line. A write
  // kill-switch that silently declines to move is the worst possible one — the
  // owner is left believing writes are off when the box still has them on, or
  // the reverse.
  //
  // The message is built from the typed code, never the response body
  // (`lifecycleErrorMessage`, rule 19), and it clears on the next attempt so a
  // stale failure cannot outlive the state it described.
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);

  async function toggleWrites(next: boolean) {
    setLifecycleError(null);
    try {
      await setProviderWrites(connection.provider, next);
    } catch (err) {
      setLifecycleError(
        lifecycleErrorMessage(next ? "turn writes on" : "turn writes off", err),
      );
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

      {/* WARP-2519 — the lifecycle failure, in the page's existing banner
          vocabulary. `danger`, not `warn`: unlike the drift and degraded
          banners below (which describe a connection behaving as designed under
          a problem) this one says the box refused something the owner just
          asked for, and the state they are looking at is not the state they
          asked for. Its action retries the READ, which is what tells them what
          the box actually holds now. */}
      {lifecycleError && (
        <StateBanner
          tone="danger"
          text={lifecycleError}
          action="Re-check"
          onAction={() => {
            setLifecycleError(null);
            refresh();
          }}
        />
      )}

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
        onDisconnected={refresh}
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
      {/* The label colour comes from the token, not the legacy `text-label-*`
          utility: this file is NEW, and the ratchet only grandfathers files that
          already carried one. */}
      <span className="type-footnote" style={{ flex: 1, color: "var(--color-label-primary)" }}>
        {text}
      </span>
      <button type="button" className="btn sm" onClick={onAction}>
        <RefreshCw size={13} /> {action}
      </button>
    </div>
  );
}
