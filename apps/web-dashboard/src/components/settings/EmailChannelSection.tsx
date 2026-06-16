"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Mail } from "lucide-react";
import {
  getEmailChannel,
  saveEmailChannel,
  type EmailChannelConfig,
  type EmailChannelUpdate,
} from "@/lib/api";

/**
 * BUG-11 — "Outbound email" settings section.
 *
 * Configures the operator-supplied SMTP relay that delivers invite emails. The
 * appliance never runs its own MTA; the owner brings their provider's SMTP
 * (Gmail app-password, Fastmail, a corporate relay, …).
 *
 * The password is WRITE-ONLY, mirroring ProviderKeyForm: the field starts empty
 * and the placeholder reflects whether one is stored. Submitting blank keeps the
 * existing password (the API treats omitted-password as keep-existing). The raw
 * SMTP transport error is never rendered — only a friendly line — so a 535/auth
 * string never lands in the DOM.
 *
 * Tokens only (dp-group / dp-row / dp-input / dp-btn-primary, type-*,
 * text-label-*, system-red/green, accent). No hardcoded colors.
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

  return (
    <section className="mb-10">
      <h2 className="type-footnote text-label-secondary uppercase tracking-wider px-1 mb-2">
        Outbound email
      </h2>

      <div className="dp-card p-4 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Mail size={16} className="text-label-secondary" />
            <div>
              <p className="type-headline text-label-primary">SMTP relay</p>
              <p className="type-caption-1 text-label-tertiary mt-0.5">
                Used to deliver invite emails. Your provider&rsquo;s SMTP — the box never sends mail itself.
              </p>
            </div>
          </div>
          {cfg?.hasPassword && (
            <span className="flex items-center gap-1 type-caption-1 text-system-green">
              <Check size={14} /> Configured
            </span>
          )}
        </div>

        {/* Enable toggle */}
        <label className="flex items-center gap-2.5 cursor-pointer">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="h-4 w-4 rounded-sm accent-accent"
          />
          <span className="type-subheadline text-label-primary">
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
              className="dp-input"
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
              className="dp-input"
            />
          </Field>
          <Field label="Username" htmlFor="smtp-username">
            <input
              id="smtp-username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="postmaster@yourdomain.com"
              className="dp-input"
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
              className="dp-input"
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
              className="dp-input"
            />
          </Field>
          <Field label="From name" htmlFor="smtp-from-name">
            <input
              id="smtp-from-name"
              value={fromName}
              onChange={(e) => setFromName(e.target.value)}
              placeholder="Droplet"
              className="dp-input"
            />
          </Field>
          <Field label="Security" htmlFor="smtp-security">
            <select
              id="smtp-security"
              value={security}
              onChange={(e) => setSecurity(e.target.value as EmailChannelUpdate["security"])}
              className="dp-input"
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
            disabled={saving}
            className="dp-btn-primary type-subheadline !min-h-[40px]"
          >
            {saving ? "Saving…" : "Save"}
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
      <label htmlFor={htmlFor} className="type-caption-1 text-label-secondary px-0.5">
        {label}
      </label>
      {children}
    </div>
  );
}
