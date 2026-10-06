"use client";

import { useState } from "react";
import { authFetch } from "@/lib/auth";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ProviderCalendarStatus, type ProviderCalendarView } from "./ProviderCalendarStatus";

export interface MicrosoftCalendarView extends ProviderCalendarView { enabled: boolean; needsConsent?: boolean }

export function Microsoft365Calendar({ view, accountAddress, connected, onChanged, onReconnect, signInBusy }: {
  view: MicrosoftCalendarView;
  accountAddress: string | null;
  connected: boolean;
  onChanged: () => Promise<void>;
  onReconnect: () => void;
  signInBusy: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [confirmingOff, setConfirmingOff] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const update = async (enabled: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await authFetch("/api/m365/calendar", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }) });
      if (!res.ok) throw new Error("calendar update failed");
      await onChanged();
    } catch {
      setError(enabled ? "Droplet could not enable your Outlook calendar. Try again." : "Droplet could not turn off your Outlook calendar. Nothing changed. Try again.");
      throw new Error("calendar update failed");
    } finally {
      setBusy(false);
    }
  };
  return <div className="space-y-3">
    <label className="flex items-center gap-2 min-h-11 type-subheadline"><input type="checkbox" checked={view.enabled} disabled={busy || signInBusy || (!connected && !view.enabled)} onChange={() => { setError(null); if (view.enabled) setConfirmingOff(true); else void update(true).catch(() => {}); }} />Show Outlook calendar in Droplet</label>
    <p className="type-caption-1">Copy current events from your work or school account&apos;s primary calendar. Imported events are read-only; Droplet cannot change events in Outlook.</p>
    <ProviderCalendarStatus provider="Outlook" view={view} busy={busy || signInBusy} onReconnect={onReconnect} onRetry={() => void onChanged()} />
    {error && !confirmingOff && <p className="type-footnote text-system-red" role="alert">{error}</p>}
    <ConfirmDialog open={confirmingOff} title="Turn off Outlook calendar?" confirmedIdentifier={accountAddress ?? undefined}
      description="Droplet will stop reading this Outlook calendar and delete the imported calendar events it copied locally. Nothing in your Outlook calendar changes. Your Microsoft account stays connected."
      confirmLabel="Turn off calendar" variant="destructive" onConfirm={() => update(false)} onCancel={() => { setConfirmingOff(false); setError(null); }}
      accessory={error ? <p className="type-footnote text-system-red" role="alert">{error}</p> : undefined} />
  </div>;
}
