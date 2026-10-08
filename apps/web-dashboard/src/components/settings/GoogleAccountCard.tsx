"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Mail } from "lucide-react";
import { authFetch, useAuth } from "@/lib/auth";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ProviderCalendarStatus, type ProviderCalendarView } from "./ProviderCalendarStatus";
import type { AccountConnectionNavigation } from "./ConnectedAccounts";

export interface GoogleConnectionView {
  state: "DISCONNECTED" | "PENDING_CONSENT" | "CONNECTED" | "NEEDS_RECONNECT" | "ERROR";
  accountAddress: string | null;
  connectedAt: string | null;
  lastError: string | null;
  configured: boolean;
  redirectUri: string;
  callbackSupported: boolean;
  mailboxId: string | null;
  mailEnabled?: boolean;
  calendarEnabled?: boolean;
  calendar?: ProviderCalendarView;
}

const OUTCOMES = {
  connected: { error: false, text: "Your Google account is connected." },
  cancelled: { error: false, text: "Google permission approval was cancelled. Try again when you’re ready." },
  expired: { error: true, text: "That Google permission approval expired. Start approval again when you’re ready." },
  failed: { error: true, text: "Google permission approval could not be completed. Try again, or ask your Droplet administrator to check Account connection setup." },
  different_account: { error: true, text: "To connect a different Google account, disconnect the current one first. Your existing local copies were kept." },
} as const;
type Outcome = keyof typeof OUTCOMES;

function takeOutcome(): Outcome | null {
  const url = new URL(window.location.href);
  const raw = url.searchParams.get("google");
  if (raw === null) return null;
  url.searchParams.delete("google");
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  return Object.hasOwn(OUTCOMES, raw) ? raw as Outcome : null;
}

export function GoogleAccountCard({ navigate = (url: string) => window.location.assign(url), calendarPollMs = 5_000, returnTo, beforeConnect, afterConnect }: AccountConnectionNavigation & { navigate?: (url: string) => void; calendarPollMs?: number } = {}) {
  const { user } = useAuth();
  const allowed = user?.role === "owner" || user?.role === "admin" || user?.role === "family";
  const [view, setView] = useState<GoogleConnectionView | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);
  const [mail, setMail] = useState(true);
  const [calendar, setCalendar] = useState(false);
  const initializedFeatures = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authFetch("/api/google/connection");
      if (!res.ok) throw new Error("connection read failed");
      const next = await res.json() as GoogleConnectionView;
      if (!next || typeof next.configured !== "boolean" || typeof next.callbackSupported !== "boolean" || !["DISCONNECTED", "PENDING_CONSENT", "CONNECTED", "NEEDS_RECONNECT", "ERROR"].includes(next.state)) throw new Error("invalid connection view");
      setView(next);
      if (!initializedFeatures.current) {
        const hasAccount = Boolean(next.accountAddress || next.mailboxId);
        setMail(hasAccount ? next.mailEnabled ?? Boolean(next.mailboxId) : true);
        setCalendar(hasAccount ? next.calendarEnabled ?? false : false);
        initializedFeatures.current = true;
      }
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!allowed) return;
    setOutcome(takeOutcome());
    void load();
  }, [allowed, load]);

  useEffect(() => {
    if (!allowed || view?.calendar?.state !== "WAITING") return;
    const timer = window.setInterval(() => void load(), calendarPollMs);
    return () => window.clearInterval(timer);
  }, [allowed, view?.calendar?.state, load, calendarPollMs]);

  if (!allowed) return null;

  const connect = async () => {
    if (busy || !view?.configured || !view.callbackSupported || (!mail && !calendar)) return;
    setBusy(true);
    setError(null);
    setOutcome(null);
    try {
      if (beforeConnect) {
        try {
          await beforeConnect();
        } catch {
          if (mounted.current) {
            setError("Droplet could not save your setup progress. Try again before connecting Google.");
            setBusy(false);
          }
          return;
        }
      }
      if (!mounted.current) return;
      if (new URL(view.redirectUri).origin !== window.location.origin) {
        navigate(new URL(returnTo ?? "/settings", view.redirectUri).toString());
        return;
      }
      const res = await authFetch("/api/google/connect", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mail, calendar, ...(returnTo ? { returnTo } : {}) }),
      });
      const body = await res.json().catch(() => ({})) as { authorizeUrl?: string };
      if (!mounted.current) return;
      if (res.ok && body.authorizeUrl) {
        navigate(body.authorizeUrl);
        return;
      }
      setError("Droplet could not start Google sign-in. Try again, or ask your Droplet administrator to check Account connection setup.");
    } catch {
      setError("Droplet could not start Google sign-in. Check your connection and try again.");
    } finally {
      afterConnect?.();
    }
    setBusy(false);
  };

  const disconnect = async () => {
    setDisconnectError(null);
    try {
      const res = await authFetch("/api/google/connection", { method: "DELETE" });
      if (!res.ok) throw new Error("disconnect failed");
    } catch {
      setDisconnectError("Droplet could not disconnect Google. Nothing changed. Try again.");
      throw new Error("disconnect failed");
    }
    setOutcome(null);
    initializedFeatures.current = false;
    await load();
  };

  const connected = view?.state === "CONNECTED";
  const reconnect = view?.state === "NEEDS_RECONNECT" || view?.state === "ERROR";
  const existingMail = Boolean(view?.accountAddress && (view.mailEnabled ?? view.mailboxId));
  const existingCalendar = Boolean(view?.accountAddress && view.calendarEnabled);
  const changedFeatures = (mail && !existingMail) || (calendar && !existingCalendar);
  const since = view?.connectedAt ? new Date(view.connectedAt) : null;
  const note = outcome ? OUTCOMES[outcome] : null;
  const opensRegisteredAddress = (() => {
    try { return Boolean(view && new URL(view.redirectUri).origin !== window.location.origin); }
    catch { return false; }
  })();

  return (
    <section className="card space-y-4" id="google-account" aria-labelledby="google-account-title">
      <div className="flex items-center gap-3">
        <span className="ri brand" aria-hidden="true"><Mail size={20} /></span>
        <h3 className="type-title-3" id="google-account-title">Google / Gmail</h3>
      </div>
      <p className="type-caption-1">Choose Gmail, Google Calendar, or both. Approve access on Google&apos;s website, then return here.</p>
      <fieldset className="space-y-2" disabled={busy || loading || !view}>
        <legend className="type-subheadline mb-2">Use this account for</legend>
        <label className="flex items-center gap-2 min-h-11 type-subheadline"><input type="checkbox" checked={mail} disabled={busy || loading || existingMail} onChange={(event) => setMail(event.target.checked)} />Gmail</label>
        <label className="flex items-center gap-2 min-h-11 type-subheadline"><input type="checkbox" checked={calendar} disabled={busy || loading || existingCalendar} onChange={(event) => setCalendar(event.target.checked)} />Google Calendar</label>
      </fieldset>
      {mail && <p className="type-caption-1">Google asks for full mail access so Droplet can read and send through your mailbox. Your Droplet owner must enable outgoing mail before Droplet can send.</p>}
      {calendar && <p className="type-caption-1">Calendar access is read-only. Droplet copies events from your primary Google calendar; it cannot change your Google events.</p>}
      {(existingMail || existingCalendar) && <p className="type-caption-1">Remove a calendar import in Calendar subscriptions. Your Droplet owner or administrator manages Gmail removal in Mailboxes Droplet reads. To switch Google accounts, disconnect this account first.</p>}
      {!mail && !calendar && <p className="type-caption-1">Select Gmail or Google Calendar to continue.</p>}
      {note && <p className={note.error ? "type-footnote text-system-red bg-system-red/10 rounded-sm px-3 py-2" : "type-footnote"} role={note.error ? "alert" : "status"} data-testid="google-outcome">{note.text}</p>}
      {loadFailed && <div className="space-y-2"><p className="type-caption-1">Droplet could not read your Google connection.</p><button type="button" className="btn" disabled={loading} onClick={() => void load()}>{loading ? "Checking…" : "Retry"}</button></div>}
      {!view && !loadFailed && <p className="type-caption-1" role="status">Checking connection…</p>}
      {opensRegisteredAddress && <p className="type-caption-1">Account linking opens Droplet&apos;s registered address. You may need to sign in to Droplet there.</p>}
      {view && <div className="space-y-1">
        <p className="type-subheadline" role="status">
          {connected ? view.accountAddress ? `Connected as ${view.accountAddress}` : "Connected" : reconnect ? "Needs reconnect" : view.state === "PENDING_CONSENT" ? "Waiting for Google approval…" : "Not connected"}
          {connected && since && !Number.isNaN(since.getTime()) ? ` · since ${since.toLocaleDateString()}` : ""}
        </p>
        {reconnect && <p className="type-caption-1">Reconnect {view.accountAddress ?? "your existing Google account"} to let Droplet continue reading your selected mail and calendar. To connect a different Google account, disconnect this one first.</p>}
        {connected && existingMail && <p className="type-caption-1">Account access is approved. Mail reading begins when Email is enabled; mailbox status appears in Mailboxes Droplet reads.</p>}
      </div>}
      {view && (!connected || changedFeatures) && <div className="space-y-3">
        {!view.configured && <p className="type-caption-1">Ask your Droplet administrator to enable Google account connections.</p>}
        {view.configured && !view.callbackSupported && <p className="type-caption-1">Ask your Droplet administrator to set up an HTTPS address with a registered hostname for Google account connections.</p>}
        <button className="btn primary type-subheadline" disabled={busy || loading || loadFailed || !view.configured || !view.callbackSupported || (!mail && !calendar)} onClick={() => void connect()}>{busy ? "Opening Google…" : reconnect ? "Reconnect Google" : connected ? "Update Google permissions" : "Connect Google"}</button>
      </div>}
      {view?.calendarEnabled && view.calendar && <ProviderCalendarStatus provider="Google" view={view.calendar} busy={busy || loading} onReconnect={() => void connect()} onRetry={() => void load()} />}
      {view && (connected || view.accountAddress || view.mailboxId) && <button className="btn" disabled={busy} onClick={() => setConfirming(true)}>Disconnect Google</button>}
      {error && <p role="alert" className="type-footnote text-system-red bg-system-red/10 rounded-sm px-3 py-2">{error}</p>}
      <ConfirmDialog
        open={confirming}
        title="Disconnect Google?"
        confirmedIdentifier={view?.accountAddress ?? undefined}
        description={`Droplet will stop reading ${view?.accountAddress ?? "this account"} and delete its local mailbox, copied messages, attachments and imported calendar events. Your messages and calendar events in Google stay in Google. Droplet also asks Google to revoke its access; if that fails, remove Droplet from your Google account permissions.`}
        confirmLabel="Disconnect Google"
        variant="destructive"
        accessory={disconnectError ? <p role="alert" className="type-footnote text-system-red">{disconnectError}</p> : undefined}
        onConfirm={disconnect}
        onCancel={() => { setConfirming(false); setDisconnectError(null); }}
      />
    </section>
  );
}
