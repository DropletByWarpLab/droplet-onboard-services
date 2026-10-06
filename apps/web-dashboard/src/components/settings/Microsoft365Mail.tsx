"use client";

import { useState } from "react";
import { Mail } from "lucide-react";
import { authFetch } from "@/lib/auth";
import { ConfirmDialog } from "@/components/ConfirmDialog";

export interface MicrosoftMailView {
  enabled: boolean;
  state: "DISCONNECTED" | "WAITING" | "CONNECTED" | "NEEDS_RECONNECT" | "ERROR";
  needsConsent: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  mailboxId: string | null;
  messageCount: number;
}

export function Microsoft365Mail({ view, accountAddress, connected, onChanged, onReconnect, signInBusy }: {
  view: MicrosoftMailView;
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
    let failureMessage: string | null = null;
    try {
      const res = await authFetch("/api/m365/mail", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }) });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: unknown } | null;
        if (body?.error === "mailbox_conflict") failureMessage = "This email address already has a mailbox in Droplet. Remove that mailbox before importing through Outlook.";
        throw new Error("mail import update failed");
      }
      await onChanged();
    } catch {
      setError(failureMessage ?? (enabled ? "Droplet could not enable Outlook email import. Try again." : "Droplet could not turn off Outlook email import. Check its status and try again."));
      throw new Error("mail import update failed");
    } finally {
      setBusy(false);
    }
  };
  const lastSync = view.lastSyncAt ? new Date(view.lastSyncAt) : null;
  const synced = lastSync !== null && Number.isFinite(lastSync.getTime());
  const hasLocalInbox = view.enabled && synced && Boolean(view.mailboxId);
  const ready = hasLocalInbox && view.state === "CONNECTED" && !view.needsConsent;
  const reconnect = view.enabled && (view.needsConsent || view.state === "NEEDS_RECONNECT");
  const pending = busy || signInBusy;
  return <div className="space-y-3" data-testid="outlook-mail-import">
    <label className="flex items-center gap-2 min-h-11 type-subheadline"><input type="checkbox" checked={view.enabled} disabled={pending || (!connected && !view.enabled)} onChange={() => { setError(null); if (view.enabled) setConfirmingOff(true); else void update(true).catch(() => {}); }} />Import Outlook emails into Droplet</label>
    <p className="type-caption-1">Import received and sent Outlook emails so you can read and search local copies here. Import is read-only; sending from Outlook in Droplet is not available. Unsent drafts and attachment files are not imported. Attachments stay in Outlook. Email must be enabled on this Droplet.</p>
    {view.enabled && <div className="space-y-2" data-testid="outlook-mail-status">
      <p className="type-subheadline flex items-center gap-2" role="status"><Mail size={16} aria-hidden="true" />{reconnect ? "Outlook email import needs reconnect" : view.state === "ERROR" ? "Outlook email import could not be refreshed" : ready ? "Outlook inbox is ready" : "Waiting for first email import…"}</p>
      {synced && <p className="type-caption-1">{Math.max(0, view.messageCount)} messages · Last imported {lastSync.toLocaleString()}. Local copies are read-only.</p>}
      {ready && <p className="type-caption-1">More emails may arrive as import continues.</p>}
      {reconnect && <button type="button" className="btn" disabled={pending} onClick={onReconnect}>Reconnect Outlook email</button>}
      {view.state === "ERROR" && !reconnect && <>{view.lastError && <p className="type-caption-1" role="alert">{view.lastError}</p>}<p className="type-caption-1">Droplet will retry. Your existing local emails are kept.</p><button type="button" className="btn" disabled={pending} onClick={() => void onChanged()}>Check import status</button></>}
      {hasLocalInbox && <a className="btn" href={`/email/${encodeURIComponent(view.mailboxId!)}`}>Open Outlook inbox</a>}
    </div>}
    {error && !confirmingOff && <p className="type-footnote text-system-red" role="alert">{error}</p>}
    <ConfirmDialog open={confirmingOff} title="Turn off Outlook email import?" confirmedIdentifier={accountAddress ?? undefined}
      description="Droplet will stop importing Outlook emails and delete this mailbox’s local messages, attachment metadata and Droplet drafts. Your emails in Outlook stay in Outlook. Your Microsoft account, calendar and file connections stay connected."
      confirmLabel="Turn off email import" variant="destructive" onConfirm={() => update(false)} onCancel={() => { setConfirmingOff(false); setError(null); }}
      accessory={error ? <p className="type-footnote text-system-red" role="alert">{error}</p> : undefined} />
  </div>;
}
