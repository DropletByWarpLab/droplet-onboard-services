"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, Check, Mail } from "lucide-react";
import { Sect } from "@/components/shell/primitives";
import {
  getEmailChannel,
  saveEmailChannel,
  testEmailChannel,
  type EmailChannelConfig,
  type EmailChannelUpdate,
} from "@/lib/api";
import { formatRelativeTime } from "@/lib/relative-time";

/**
 * BUG-11 — "Outbound email" settings section.
 *
 * Configures the operator-supplied SMTP relay that delivers invite emails. The
 * appliance never runs its own MTA; the owner brings their provider's SMTP
 * (Gmail app-password, Fastmail, a corporate relay, …).
 *
 * The password is WRITE-ONLY, mirroring the cloud-key editor on /models (WARP-2871): the field starts empty
 * and the placeholder reflects whether one is stored. Submitting blank keeps the
 * existing password (the API treats omitted-password as keep-existing). The raw
 * SMTP transport error is never rendered — only a friendly line — so a 535/auth
 * string never lands in the DOM.
 *
 * WARP-2957 — the relay is VERIFIED, not just saved. Saving an enabled relay
 * dials it in the same request and the response carries `lastTestedAt` /
 * `lastError`; "Test connection" does the same on demand. Before this the
 * only signal was "Saved", and the first evidence a pasted app password was
 * wrong was a failed invite days later. `lastError` is a closed-set sentence
 * the orchestrator chose — never the server's own reply — so rendering it is
 * safe by construction.
 *
 * Tokens only (.card / indigo inputs / .btn primary, type-*, indigo CSS
 * vars, system-red/green). No hardcoded colors.
 */
const SECURITY_OPTIONS: Array<{ value: EmailChannelUpdate["security"]; label: string }> = [
  { value: "starttls", label: "STARTTLS (587)" },
  { value: "tls", label: "TLS (465)" },
  { value: "none", label: "None (LAN relay)" },
];

export function EmailChannelSection() {
  const [cfg, setCfg] = useState<EmailChannelConfig | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [host, setHost] = useState("");
  const [port, setPort] = useState(587);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [fromAddress, setFromAddress] = useState("");
  const [fromName, setFromName] = useState("Droplet");
  const [security, setSecurity] = useState<EmailChannelUpdate["security"]>("starttls");

  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await getEmailChannel();
      setCfg(data);
      setEnabled(data.enabled);
      setHost(data.host);
      setPort(data.port);
      setUsername(data.username);
      setFromAddress(data.fromAddress);
      setFromName(data.fromName);
      setSecurity(data.security);
    } catch {
      // Non-fatal — might not have admin access; leave the form on defaults.
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleSave = async () => {
    setError(null);
    setSavedAt(null);
    setSaving(true);
    try {
      const update: EmailChannelUpdate = {
        enabled,
        host: host.trim(),
        port,
        username: username.trim(),
        fromAddress: fromAddress.trim(),
        fromName: fromName.trim() || "Droplet",
        security,
        // Write-only: only include the password when the operator typed one.
        // Blank → omit → the orchestrator keeps the stored password.
        ...(password.length > 0 ? { password } : {}),
      };
      const saved = await saveEmailChannel(update);
      // An enabled save carries the verify outcome (lastTestedAt/lastError);
      // the status line below renders it. Nothing else to do here.
      setCfg(saved);
      setPassword("");
      setSavedAt(Date.now());
    } catch {
      // Keep the raw transport string (e.g. "535 5.7.8 auth failed …") out of
      // the DOM — show a friendly line instead.
      setError("Couldn't save the email settings. Check the values and try again.");
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setError(null);
    setSavedAt(null);
    setTesting(true);
    try {
      const result = await testEmailChannel();
      setCfg((prev) =>
        prev
          ? { ...prev, lastTestedAt: result.lastTestedAt, lastError: result.error }
          : prev,
      );
    } catch {
      setError("Couldn't test the relay right now. Try again in a moment.");
    } finally {
      setTesting(false);
    }
  };

  // The relay's verified state, from the row — not from anything typed in the
  // form. A test is against what is SAVED, and the copy says so.
  const verified = cfg?.lastTestedAt ? (cfg.lastError ? "failed" : "ok") : "untested";
  const canTest = Boolean(cfg && cfg.host.trim().length > 0) && !saving && !testing;

  return (
    <section className="mb-10">
      <Sect title="Outbound email" />

      <div className="card space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Mail size={16} style={{ color: "var(--text-muted)" }} />
            <div>
              <p className="type-headline" style={{ color: "var(--text)" }}>SMTP relay</p>
              <p className="type-caption-1 mt-0.5" style={{ color: "var(--text-muted)" }}>
                Used to deliver invite emails. Your provider&rsquo;s SMTP — the box never sends mail itself.
              </p>
            </div>
          </div>
          {verified === "ok" && cfg?.lastTestedAt && (
            <span
              className="flex items-center gap-1 type-caption-1 text-system-green"
              role="status"
            >
              <Check size={14} /> Connected · checked {formatRelativeTime(cfg.lastTestedAt)}
            </span>
          )}
          {verified === "failed" && (
            <span className="flex items-center gap-1 type-caption-1 text-system-red" role="status">
              <AlertCircle size={14} /> Not connected
            </span>
          )}
          {verified === "untested" && cfg?.hasPassword && (
            <span className="type-caption-1" style={{ color: "var(--text-muted)" }} role="status">
              Saved, not tested yet
            </span>
          )}
        </div>

        {verified === "failed" && cfg?.lastError && (
          <p
            className="type-footnote text-system-red bg-system-red/10 rounded-sm px-3 py-2"
            role="alert"
          >
            {cfg.lastError}
          </p>
        )}

        {/* Enable toggle */}
        <label className="flex items-center gap-2.5 cursor-pointer">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="h-4 w-4 rounded-sm accent-[var(--brand)]"
          />
          <span className="type-subheadline" style={{ color: "var(--text)" }}>
            Enable outbound email
          </span>
        </label>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="SMTP host" htmlFor="smtp-host">
            <input
              id="smtp-host"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="smtp.gmail.com"
              className="w-full px-3 py-2.5 outline-none focus:border-[var(--brand)] placeholder:text-[var(--text-faint)] transition-colors"
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-input)",
                color: "var(--text)",
              }}
            />
          </Field>
          <Field label="Port" htmlFor="smtp-port">
            <input
              id="smtp-port"
              type="number"
              inputMode="numeric"
              value={port}
              onChange={(e) => setPort(Number(e.target.value) || 0)}
              placeholder="587"
              className="w-full px-3 py-2.5 outline-none focus:border-[var(--brand)] placeholder:text-[var(--text-faint)] transition-colors"
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-input)",
                color: "var(--text)",
              }}
            />
          </Field>
          <Field label="Username" htmlFor="smtp-username">
            <input
              id="smtp-username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="postmaster@yourdomain.com"
              className="w-full px-3 py-2.5 outline-none focus:border-[var(--brand)] placeholder:text-[var(--text-faint)] transition-colors"
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-input)",
                color: "var(--text)",
              }}
              autoComplete="off"
            />
          </Field>
          <Field label="SMTP password" htmlFor="smtp-password">
            <input
              id="smtp-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={cfg?.hasPassword ? "Saved — replace to change" : "App password"}
              className="w-full px-3 py-2.5 outline-none focus:border-[var(--brand)] placeholder:text-[var(--text-faint)] transition-colors"
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-input)",
                color: "var(--text)",
              }}
              autoComplete="new-password"
            />
          </Field>
          <Field label="From address" htmlFor="smtp-from">
            <input
              id="smtp-from"
              type="email"
              inputMode="email"
              value={fromAddress}
              onChange={(e) => setFromAddress(e.target.value)}
              placeholder="droplet@yourdomain.com"
              className="w-full px-3 py-2.5 outline-none focus:border-[var(--brand)] placeholder:text-[var(--text-faint)] transition-colors"
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-input)",
                color: "var(--text)",
              }}
            />
          </Field>
          <Field label="From name" htmlFor="smtp-from-name">
            <input
              id="smtp-from-name"
              value={fromName}
              onChange={(e) => setFromName(e.target.value)}
              placeholder="Droplet"
              className="w-full px-3 py-2.5 outline-none focus:border-[var(--brand)] placeholder:text-[var(--text-faint)] transition-colors"
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-input)",
                color: "var(--text)",
              }}
            />
          </Field>
          <Field label="Security" htmlFor="smtp-security">
            <select
              id="smtp-security"
              value={security}
              onChange={(e) => setSecurity(e.target.value as EmailChannelUpdate["security"])}
              className="w-full px-3 py-2.5 outline-none focus:border-[var(--brand)] transition-colors"
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-input)",
                color: "var(--text)",
              }}
            >
              {SECURITY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {error && (
          <p className="type-footnote text-system-red bg-system-red/10 rounded-sm px-3 py-2">
            {error}
          </p>
        )}
        {savedAt && !error && (
          <p className="type-footnote text-system-green flex items-center gap-1">
            <Check size={14} /> Saved
          </p>
        )}

        <div className="flex items-center gap-2 pt-1">
          <button
            onClick={handleSave}
            disabled={saving || testing}
            className="btn primary type-subheadline !min-h-[40px]"
          >
            {saving ? (enabled ? "Saving and checking…" : "Saving…") : "Save"}
          </button>
          <button
            type="button"
            onClick={handleTest}
            disabled={!canTest}
            className="btn type-subheadline !min-h-[40px]"
            title="Dials the saved relay and signs in. Sends nothing."
          >
            {testing ? "Checking…" : "Test connection"}
          </button>
        </div>
      </div>
    </section>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="type-caption-1 px-0.5" style={{ color: "var(--text-muted)" }}>
        {label}
      </label>
      {children}
    </div>
  );
}
