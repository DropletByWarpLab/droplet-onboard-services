"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Copy as CopyIcon, Eye, EyeOff, HardDrive } from "lucide-react";
import { Dialog } from "@/components/Dialog";
import { authFetch } from "@/lib/auth";

/** Wire shape of GET /api/storage/network-drive (orchestrator storage.ts). */
interface NetworkDriveInfo {
  enabled: boolean;
  share: string;
  username: string;
  /** null when the share is disabled or the credential was never generated. */
  password: string | null;
  hosts: { mdns: string; lan: string };
  windowsPath: string;
  macosUrl: string;
}

interface ConnectDriveDialogProps {
  open: boolean;
  onClose: () => void;
}

/**
 * "Connect network drive" — step-by-step connect instructions for the SMB
 * "Droplet" share (the compose `samba` service) so the Droplet folder shows
 * up natively in Windows Explorer / macOS Finder.
 *
 * Owner/admin surface only: the endpoint 403s other roles because the
 * credential is device-wide (see the route comment in orchestrator
 * routes/storage.ts), and the page hides the trigger for them.
 */
export function ConnectDriveDialog({ open, onClose }: ConnectDriveDialogProps) {
  const [info, setInfo] = useState<NetworkDriveInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setShowPassword(false);
    (async () => {
      try {
        const res = await authFetch("/api/storage/network-drive");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as NetworkDriveInfo;
        if (!cancelled) setInfo(body);
      } catch {
        if (!cancelled) {
          setError("Couldn't load the connection details. Try again in a moment.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  return (
    <Dialog open={open} onClose={onClose} labelledBy="connect-drive-title" maxWidth="lg">
      <div className="flex items-center gap-2 mb-1">
        <HardDrive size={16} aria-hidden="true" />
        <h2 id="connect-drive-title" className="text-base font-semibold">
          Connect as a network drive
        </h2>
      </div>
      <p className="text-sm opacity-70 mb-4">
        Your Droplet folder can appear directly in Windows Explorer and macOS
        Finder — files you drop there also show up here under{" "}
        <span className="font-medium">Droplet</span>.
      </p>

      {loading && <p className="text-sm opacity-70">Loading…</p>}
      {error && <p className="text-sm text-red-500">{error}</p>}

      {info && !info.enabled && (
        <p className="text-sm opacity-70">
          The network drive isn&apos;t enabled on this Droplet. It ships on by
          default on the appliance — see the network-drive guide in the device
          docs if it was switched off.
        </p>
      )}

      {info && info.enabled && (
        <div className="space-y-4">
          <section>
            <h3 className="text-sm font-semibold mb-1">Windows</h3>
            <ol className="text-sm opacity-80 list-decimal ml-4 space-y-0.5">
              <li>
                Open Explorer — the Droplet appears under{" "}
                <span className="font-medium">Network</span>, or
              </li>
              <li>enter the address below in the Explorer address bar.</li>
            </ol>
            <CopyField label="Windows address" value={info.windowsPath} />
          </section>

          <section>
            <h3 className="text-sm font-semibold mb-1">macOS</h3>
            <ol className="text-sm opacity-80 list-decimal ml-4 space-y-0.5">
              <li>
                In Finder press <span className="font-medium">⌘K</span> (Go →
                Connect to Server…)
              </li>
              <li>and enter the address below.</li>
            </ol>
            <CopyField label="macOS address" value={info.macosUrl} />
          </section>

          <section>
            <h3 className="text-sm font-semibold mb-1">Sign in as</h3>
            <CopyField label="Username" value={info.username} />
            {info.password === null ? (
              <p className="text-sm opacity-70 mt-1">
                No drive password has been generated yet — re-run device setup
                to create one.
              </p>
            ) : (
              <CopyField
                label="Password"
                value={info.password}
                masked={!showPassword}
                trailing={
                  <button
                    type="button"
                    className="btn ghost"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                  >
                    {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                }
              />
            )}
            <p className="text-xs opacity-60 mt-2">
              This sign-in is shared for the whole Droplet and opens the shared
              Droplet folder only — keep it to household admins.
            </p>
          </section>
        </div>
      )}
    </Dialog>
  );
}

/** Read-only value row with a copy button (and optional trailing control). */
function CopyField({
  label,
  value,
  masked = false,
  trailing,
}: {
  label: string;
  value: string;
  masked?: boolean;
  trailing?: React.ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be unavailable (http origin / permissions) — the value
      // is selectable text, so failing silently still leaves a manual path.
    }
  }, [value]);

  return (
    <div className="flex items-center gap-2 mt-1.5">
      <code
        className="flex-1 text-sm px-2 py-1 rounded border border-black/10 dark:border-white/10 bg-black/5 dark:bg-white/5 select-all overflow-x-auto whitespace-nowrap"
        aria-label={label}
      >
        {masked ? "••••••••••••" : value}
      </code>
      {trailing}
      <button
        type="button"
        className="btn ghost"
        onClick={copy}
        aria-label={`Copy ${label.toLowerCase()}`}
      >
        {copied ? <Check size={14} /> : <CopyIcon size={14} />}
      </button>
    </div>
  );
}
