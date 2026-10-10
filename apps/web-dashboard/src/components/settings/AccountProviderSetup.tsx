"use client";

import { useCallback, useId, useState } from "react";
import { Copy } from "lucide-react";
import { authFetch, useAuth } from "@/lib/auth";

export interface AccountConnectionSetupView {
  google: { clientId: string; hasClientSecret: boolean; configured: boolean; redirectUri: string; callbackSupported: boolean };
  microsoft: { clientId: string; tenantId: string; configured: boolean; redirectUri: string };
}

function CallbackField({ provider, value }: { provider: string; value: string }) {
  const inputId = useId();
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setCopyFailed(false);
    } catch {
      setCopyFailed(true);
    }
  };
  return <div className="space-y-1.5">
    <label htmlFor={inputId}>{provider} callback URI</label>
    <div className="flex flex-wrap items-center gap-2">
      <input id={inputId} value={value} readOnly className="form-input flex-1 min-w-0" onFocus={(event) => event.target.select()} />
      <button className="btn" type="button" onClick={() => void copy()} aria-label={`Copy ${provider} callback URI`}><Copy size={16} aria-hidden="true" />{copied ? "Copied" : "Copy"}</button>
    </div>
    {copyFailed && <p className="type-caption-1" role="status">Select the URI and copy it manually.</p>}
  </div>;
}

/** One registration per Droplet. Secrets are never returned to the browser. */
export function AccountProviderSetup({ onSaved }: { onSaved?: () => void } = {}) {
  const { user } = useAuth();
  const allowed = user?.role === "owner" || user?.role === "admin";
  const [view, setView] = useState<AccountConnectionSetupView | null>(null);
  const [googleClientId, setGoogleClientId] = useState("");
  const [googleSecret, setGoogleSecret] = useState("");
  const [clearSecret, setClearSecret] = useState(false);
  const [microsoftClientId, setMicrosoftClientId] = useState("");
  const [tenantId, setTenantId] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState<"google" | "microsoft" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const load = useCallback(async (provider?: "google" | "microsoft") => {
    setLoading(true);
    try {
      const res = await authFetch("/api/account-connections/setup");
      if (!res.ok) throw new Error("setup read failed");
      const next = await res.json() as AccountConnectionSetupView;
      if (!next?.google || !next?.microsoft || typeof next.google.clientId !== "string" || typeof next.microsoft.clientId !== "string" || typeof next.microsoft.tenantId !== "string") throw new Error("invalid setup view");
      setView(next);
      if (!provider || provider === "google") setGoogleClientId(next.google.clientId);
      if (!provider || provider === "microsoft") {
        setMicrosoftClientId(next.microsoft.clientId);
        setTenantId(next.microsoft.tenantId);
      }
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  if (!allowed) return null;

  const save = async (provider: "google" | "microsoft") => {
    if (saving) return;
    setSaving(provider);
    setError(null);
    setSaved(null);
    const body = provider === "google"
      ? { google: { clientId: googleClientId.trim(), ...(clearSecret ? { clientSecret: "" } : googleSecret ? { clientSecret: googleSecret } : {}) } }
      : { microsoft: { clientId: microsoftClientId.trim(), tenantId: tenantId.trim() } };
    try {
      const res = await authFetch("/api/account-connections/setup", {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("setup save failed");
      // Clear the write-only input even if the following status read fails.
      if (provider === "google") {
        setGoogleSecret("");
        setClearSecret(false);
      }
      setSaved(provider === "google" ? "Google connection setup saved." : "Microsoft connection setup saved.");
      await load(provider);
      onSaved?.();
    } catch {
      setError("Droplet could not save account connection setup. Check the registration details and try again.");
    } finally {
      setSaving(null);
    }
  };

  return <details className="card" onToggle={(event) => { if (event.currentTarget.open && !view && !loading) void load(); }}>
    <summary className="type-subheadline cursor-pointer py-2">Account connection setup</summary>
    <div className="space-y-5 pt-4">
      <p className="type-caption-1">Administrator setup, once per Droplet. Register your own Google and Microsoft applications and save their details here. Each person can then connect their own account with a button.</p>
      <p className="type-caption-1">Enable Calendar to show imported events, and Email to read connected mailboxes. Outgoing mail also requires the owner&apos;s approval in email settings.</p>
      {loading && <p className="type-caption-1" role="status">Checking account setup…</p>}
      {loadFailed && <div className="space-y-2"><p className="type-caption-1">Droplet could not read account connection setup.</p><button className="btn" type="button" disabled={loading} onClick={() => void load()}>Retry setup</button></div>}
      {view && <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void save("google"); }}>
          <h3 className="type-title-3">Google setup</h3>
          <p className="type-caption-1" role="status">{view.google.configured ? "Registration saved" : "Registration needed"}</p>
          <p className="type-caption-1">Create a Google OAuth client for a Web application, configure its consent screen for the Gmail and read-only Google Calendar features you want to offer, then register this exact callback URI. Google may require app verification before other people can connect.</p>
          <a href="/help/connectors/google-mail" target="_blank" rel="noopener noreferrer" className="type-caption-1 underline">Google registration and permissions guide</a>
          <CallbackField provider="Google" value={view.google.redirectUri} />
          {!view.google.callbackSupported && <p className="type-footnote text-system-red" role="alert">Google requires an HTTPS address with a registered hostname. A local hostname, IP address or HTTP address cannot be used. Configure Droplet&apos;s public HTTPS address, reload this setup, and register the updated callback URI.</p>}
          <label className="flex flex-col gap-1.5">Google client ID<input className="form-input" value={googleClientId} onChange={(event) => setGoogleClientId(event.target.value)} autoComplete="off" spellCheck={false} disabled={Boolean(saving)} /></label>
          <label className="flex flex-col gap-1.5">Google client secret<input className="form-input" type="password" value={googleSecret} onChange={(event) => setGoogleSecret(event.target.value)} autoComplete="new-password" spellCheck={false} disabled={Boolean(saving) || clearSecret} aria-describedby="google-secret-help" /></label>
          <p className="type-caption-1" id="google-secret-help">{view.google.hasClientSecret ? "A secret is stored. Leave this blank to keep it, or enter a replacement. The saved secret is never shown." : "Enter the client secret from your Google OAuth application. It will not be shown after saving."}</p>
          {view.google.hasClientSecret && <label className="flex items-center gap-2 type-caption-1"><input type="checkbox" checked={clearSecret} onChange={(event) => { setClearSecret(event.target.checked); setGoogleSecret(""); }} disabled={Boolean(saving)} />Remove stored Google client secret</label>}
          <button className="btn primary" type="submit" disabled={Boolean(saving) || loading || loadFailed}>{saving === "google" ? "Saving Google…" : "Save Google setup"}</button>
        </form>
        <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void save("microsoft"); }}>
          <h3 className="type-title-3">Microsoft setup</h3>
          <p className="type-caption-1" role="status">{view.microsoft.configured ? "Registration saved" : "Registration needed"}</p>
          <p className="type-caption-1">Register a single-tenant Microsoft Entra application under “Mobile and desktop applications” with this exact callback URI. Enable the required delegated permissions and have your Microsoft administrator grant consent.</p>
          <a href="/help/connectors/microsoft-365" target="_blank" rel="noopener noreferrer" className="type-caption-1 underline">Microsoft registration and permissions guide</a>
          <CallbackField provider="Microsoft" value={view.microsoft.redirectUri} />
          <label className="flex flex-col gap-1.5">Microsoft application (client) ID<input className="form-input" value={microsoftClientId} onChange={(event) => setMicrosoftClientId(event.target.value)} autoComplete="off" spellCheck={false} disabled={Boolean(saving)} /></label>
          <label className="flex flex-col gap-1.5">Microsoft directory (tenant) ID<input className="form-input" value={tenantId} onChange={(event) => setTenantId(event.target.value)} autoComplete="off" spellCheck={false} disabled={Boolean(saving)} /></label>
          <button className="btn primary" type="submit" disabled={Boolean(saving) || loading || loadFailed}>{saving === "microsoft" ? "Saving Microsoft…" : "Save Microsoft setup"}</button>
        </form>
      </div>}
      {saved && <p className="type-footnote text-system-green" role="status">{saved}</p>}
      {error && <p className="type-footnote text-system-red" role="alert">{error}</p>}
    </div>
  </details>;
}
