"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
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

/** Wire shape of POST /api/storage/network-drive/personal (orchestrator device-clients.ts). */
interface PersonalDriveLogin {
  deviceId: string;
  username: string;
  /** Plaintext, returned once — never shown again. */
  appPassword: string;
  macosUrl: string;
  windowsPath: string;
}

type DrivePlatform = "macos" | "windows";

interface ConnectDriveDialogProps {
  open: boolean;
  onClose: () => void;
  /**
   * Also show the device-wide shared SMB "Droplet" share (owner/admin only —
   * the endpoint 403s other roles). The shared fetch only runs when true.
   */
  showSharedDrive?: boolean;
}

/**
 * "Connect as a network drive" — puts a Droplet drive in Windows Explorer /
 * macOS Finder.
 *
 * "Your drive" (owner/admin/family, while the owner has turned personal drives
 * on): mints a personal WebDAV login through Nextcloud
 * (POST /api/storage/network-drive/personal) — the user's own My Files /
 * Household / department access, no shared password. The app password is
 * returned once and shown once; it can be revoked from the devices list. The
 * on/off flag is `personalDriveEnabled` from GET /api/settings/workspace; while
 * it is off the section shows a note instead of the create button.
 *
 * "Shared Droplet folder" (`showSharedDrive`, owner/admin only): step-by-step
 * connect instructions for the SMB "Droplet" share (the compose `samba`
 * service). The endpoint 403s other roles because that credential is
 * device-wide (see the route comment in orchestrator routes/storage.ts), so
 * the shared fetch only runs when the flag is set.
 */
export function ConnectDriveDialog({ open, onClose, showSharedDrive = false }: ConnectDriveDialogProps) {
  const [info, setInfo] = useState<NetworkDriveInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    if (!open || !showSharedDrive) return;
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
  }, [open, showSharedDrive]);

  return (
    <Dialog open={open} onClose={onClose} labelledBy="connect-drive-title" maxWidth="lg">
      <div className="flex items-center gap-2 mb-1">
        <HardDrive size={16} aria-hidden="true" />
        <h2 id="connect-drive-title" className="text-base font-semibold">
          Connect as a network drive
        </h2>
      </div>
      <p className="text-sm opacity-70 mb-4">
        Your Droplet files can appear directly in Windows Explorer and macOS
        Finder — files you drop there also show up here.
      </p>
      <p className="text-sm opacity-70 mb-4">
        Connecting a drive here doesn&apos;t share your computer&apos;s C: or D:
        drive with Droplet. Upload those files, or set up a separate shared
        folder connection from your computer.
      </p>

      <PersonalDrive open={open} />

      {showSharedDrive && (
        <h3 className="text-sm font-semibold mt-6 mb-1 pt-4 border-t border-black/10 dark:border-white/10">
          Shared Droplet folder
        </h3>
      )}

      {showSharedDrive && loading && <p className="text-sm opacity-70">Loading…</p>}
      {showSharedDrive && error && <p className="text-sm text-red-500">{error}</p>}

      {showSharedDrive && info && !info.enabled && (
        <p className="text-sm opacity-70">
          The network drive isn&apos;t enabled on this Droplet. It ships on by
          default on the appliance — see the network-drive guide in the device
          docs if it was switched off.
        </p>
      )}

      {showSharedDrive && info && info.enabled && (
        <div className="space-y-4">
          <section>
            <p className="text-sm opacity-70 mb-2">
              This connection opens only the shared Droplet folder. Files copied
              here from Explorer or Finder are in My Files → Droplet.
              Use Your drive above for your other folders and attached drives.
            </p>
            <Link
              href="/files?path=%2FDroplet"
              onClick={onClose}
              className="btn ghost"
            >
              Open shared folder in Files
            </Link>
          </section>
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
              Droplet folder only — keep it to workspace admins.
            </p>
          </section>
        </div>
      )}
    </Dialog>
  );
}

/** "Your drive": per-user WebDAV login, created on demand and shown once. */
function PersonalDrive({ open }: { open: boolean }) {
  // null = not known yet. Only an explicit `true` from the server turns it on.
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [platform, setPlatform] = useState<DrivePlatform>(() =>
    typeof navigator !== "undefined" && /windows/i.test(navigator.userAgent)
      ? "windows"
      : "macos",
  );
  const [login, setLogin] = useState<PersonalDriveLogin | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);

  // The password is shown once — drop it when the dialog closes.
  useEffect(() => {
    if (open) return;
    setLogin(null);
    setError(null);
    setShowPassword(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setEnabled(null);
    setLoadFailed(false);
    (async () => {
      try {
        const res = await authFetch("/api/settings/workspace");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { personalDriveEnabled?: boolean };
        if (!cancelled) setEnabled(body.personalDriveEnabled === true);
      } catch {
        if (!cancelled) setLoadFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const create = async () => {
    setCreating(true);
    setError(null);
    try {
      const res = await authFetch("/api/storage/network-drive/personal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (body.error === "personal_drive_disabled") {
          // The owner switched it off while this dialog was open.
          setEnabled(false);
        } else if (body.error === "nc_credential_unavailable") {
          setError(
            "To set up your drive, sign out and sign in with your password once, then try again.",
          );
        } else if (res.status === 429) {
          setError("You've created a lot of drive logins. Try again in an hour.");
        } else {
          setError("Couldn't create your drive login. Try again in a moment.");
        }
        return;
      }
      setLogin((await res.json()) as PersonalDriveLogin);
      setShowPassword(false);
    } catch {
      setError("Couldn't create your drive login. Try again in a moment.");
    } finally {
      setCreating(false);
    }
  };

  if (enabled !== true) {
    return (
      <section>
        <h3 className="text-sm font-semibold mb-1">Your drive</h3>
        {loadFailed ? (
          <p className="text-sm text-red-500">
            Couldn&apos;t check whether personal drives are on. Try again in a
            moment.
          </p>
        ) : enabled === null ? (
          <p className="text-sm opacity-70">Loading…</p>
        ) : (
          <p className="text-sm opacity-70">
            Personal drives aren&apos;t turned on for this Droplet. Your
            Droplet owner can turn them on in Settings.
          </p>
        )}
      </section>
    );
  }

  return (
    <section>
      <h3 className="text-sm font-semibold mb-1">Your drive</h3>
      <p className="text-sm opacity-70 mb-2">
        All of My Files that your account can access, including registered
        attached drives and permitted shared folders, using your own login.
      </p>
      <div className="flex gap-2 mb-2" role="group" aria-label="Computer type">
        {(["macos", "windows"] as const).map((p) => (
          <button
            key={p}
            type="button"
            className={`btn ${platform === p ? "" : "ghost"}`}
            aria-pressed={platform === p}
            onClick={() => setPlatform(p)}
          >
            {p === "macos" ? "Mac" : "Windows"}
          </button>
        ))}
      </div>

      {!login && (
        <button type="button" className="btn" onClick={create} disabled={creating}>
          {creating ? "Creating…" : "Create my drive login"}
        </button>
      )}
      {error && <p className="text-sm text-red-500 mt-2">{error}</p>}

      {login && (
        <div>
          <ol className="text-sm opacity-80 list-decimal ml-4 space-y-0.5">
            {platform === "macos" ? (
              <>
                <li>
                  In Finder press <span className="font-medium">⌘K</span> (Go →
                  Connect to Server…)
                </li>
                <li>Paste the address below and click Connect.</li>
                <li>Enter the username and password below.</li>
                <li>
                  Tick{" "}
                  <span className="font-medium">
                    Remember this password in my keychain
                  </span>
                  .
                </li>
              </>
            ) : (
              <>
                <li>
                  Open File Explorer → <span className="font-medium">This PC</span>{" "}
                  → Map network drive…
                </li>
                <li>Paste the address below as the folder.</li>
                <li>
                  Tick <span className="font-medium">Reconnect at sign-in</span>{" "}
                  and{" "}
                  <span className="font-medium">
                    Connect using different credentials
                  </span>
                  .
                </li>
                <li>Enter the username and password below.</li>
              </>
            )}
          </ol>
          <CopyField
            label="Your drive address"
            value={platform === "macos" ? login.macosUrl : login.windowsPath}
          />
          <CopyField label="Your drive username" value={login.username} />
          <CopyField
            label="Your drive password"
            value={login.appPassword}
            masked={!showPassword}
            trailing={
              <button
                type="button"
                className="btn ghost"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? "Hide your drive password" : "Show your drive password"}
              >
                {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            }
          />
          <p className="text-xs opacity-60 mt-2">
            This password is only shown now — copy it before you close this
            window. If you lose it, you can remove this login from your devices
            list and create a new one.
          </p>
        </div>
      )}
    </section>
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
