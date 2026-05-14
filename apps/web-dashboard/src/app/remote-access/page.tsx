"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import {
  Plus,
  X,
  Globe,
  Smartphone,
  Trash2,
  Download,
  Copy,
  Check,
  AlertCircle,
  Loader2,
  ShieldOff,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import {
  fetchVpnStatus,
  fetchVpnPeers,
  createVpnPeer,
  deleteVpnPeer,
  fetchDuckDnsStatus,
  setDuckDnsConfig,
} from "@/lib/api";
import type {
  VpnPeerInfo,
  VpnStatusInfo,
  VpnPeerCreatedInfo,
  DuckDnsStatus,
} from "@/lib/types";
import { Dialog } from "@/components/Dialog";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";

/**
 * Remote Access — WireGuard VPN management page.
 *
 * Each user sees their own devices; admins (`role: owner`) see everyone's.
 * The page is intentionally simple: a header explaining what this is, a
 * status banner if the server endpoint isn't configured, a list of peers,
 * and an "Add a device" button that opens an inline dialog.
 *
 * The dialog is two-step: name the device, then show a QR + .conf with
 * download. The server returns the .conf exactly once — closing the dialog
 * forgets it on the client side too.
 */
export default function RemoteAccessPage() {
  const { user: currentUser } = useAuth();
  const [status, setStatus] = useState<VpnStatusInfo | null>(null);
  const [peers, setPeers] = useState<VpnPeerInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<VpnPeerInfo | null>(null);
  const { toast } = useToast();

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, p] = await Promise.all([
        fetchVpnStatus().catch(() => null),
        fetchVpnPeers().catch(() => ({ peers: [] as VpnPeerInfo[] })),
      ]);
      setStatus(s);
      setPeers(p.peers || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load Remote Access");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const handleRevokeConfirm = async () => {
    if (!revokeTarget) return;
    try {
      await deleteVpnPeer(revokeTarget.id);
      toast(`Revoked "${revokeTarget.deviceLabel}".`, "success");
      setRevokeTarget(null);
      await reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Revoke failed", "error");
      throw err;
    }
  };

  const activePeers = peers.filter((p) => p.status === "active");
  const endpointMissing = status && !status.endpointConfigured;

  return (
    <div className="p-6 lg:p-8 max-w-4xl">
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="type-large-title text-label-primary">Remote Access</h1>
          <p className="type-subheadline text-label-tertiary mt-1 max-w-xl">
            Connect your phone or laptop to your home network from anywhere.
            Add a device, scan the QR code in the WireGuard app, and you&rsquo;re in.
          </p>
        </div>
        <button
          onClick={() => setShowAdd(true)}
          disabled={endpointMissing === true}
          className="dp-btn-primary type-subheadline !py-2 !px-4 !min-h-[36px] flex-shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Plus size={14} />
          Add a device
        </button>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-system-red/10 border border-system-red/20 rounded type-footnote text-system-red flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError(null)}>
            <X size={12} />
          </button>
        </div>
      )}

      {endpointMissing && (
        <div className="mb-4 p-3 bg-system-orange/10 border border-system-orange/20 rounded type-footnote text-system-orange flex items-start gap-2">
          <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
          <div>
            <p className="font-medium">Endpoint host not configured</p>
            <p className="type-caption-1 mt-0.5">
              Set <code className="font-mono">WIREGUARD_ENDPOINT_HOST</code> in
              <code className="font-mono"> .env</code> to your DuckDNS subdomain
              or your home router&rsquo;s public IP, then restart the orchestrator.
            </p>
          </div>
        </div>
      )}

      {/* Server status card — small, only when configured */}
      {status?.configured && (
        <div className="dp-card p-4 mb-4 grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
          <Stat label="Endpoint" value={status.endpointHost ? `${status.endpointHost}:${status.listenPort}` : "—"} />
          <Stat label="VPN subnet" value={status.addresses?.[0] ?? "—"} />
          <Stat label="Active devices" value={String(activePeers.length)} />
          <Stat label="Server key" value={status.serverPublicKey?.slice(0, 8) + "…"} />
        </div>
      )}

      {/* Peer list */}
      <div className="dp-group">
        {loading && peers.length === 0 ? (
          <div className="dp-row flex items-center justify-center text-label-tertiary type-subheadline">
            Loading…
          </div>
        ) : peers.length === 0 ? (
          <div className="dp-row flex flex-col items-center justify-center py-12 text-center">
            <Globe size={32} className="text-label-quaternary mb-3" />
            <p className="type-subheadline text-label-tertiary">No devices yet</p>
            <p className="type-caption-1 text-label-quaternary mt-1 max-w-xs">
              Tap &ldquo;Add a device&rdquo; to set up your first phone or laptop.
            </p>
          </div>
        ) : (
          peers.map((peer) => (
            <PeerRow
              key={peer.id}
              peer={peer}
              isOwner={peer.userId === currentUser?.username}
              onRevoke={() => setRevokeTarget(peer)}
            />
          ))
        )}
      </div>

      {/* DuckDNS card — only renders when the user is an admin (the API
          returns 403 for non-admins; we treat that as "hide the section"
          rather than an error since families don't need to see it). */}
      <DuckDnsCard />

      {showAdd && (
        <AddDeviceDialog
          onClose={() => setShowAdd(false)}
          onAdded={reload}
        />
      )}

      <ConfirmDialog
        open={revokeTarget !== null}
        onConfirm={handleRevokeConfirm}
        onCancel={() => setRevokeTarget(null)}
        title={revokeTarget ? `Revoke "${revokeTarget.deviceLabel}"?` : "Revoke device?"}
        description="It will be disconnected from your network immediately and the WireGuard config on the device will stop working."
        confirmLabel="Revoke"
        variant="destructive"
      />
    </div>
  );
}

// ─────────────────────── DuckDNS card ────────────────────────
//
// Two states: unconfigured (form to enter subdomain + token) and configured
// (read-only summary + "Edit" button to swap to form). Token is write-only —
// never displayed; the form input is always blank.

function DuckDnsCard() {
  const [status, setStatus] = useState<DuckDnsStatus | null>(null);
  const [adminVisible, setAdminVisible] = useState(true);
  const [editing, setEditing] = useState(false);
  const [subdomain, setSubdomain] = useState("");
  const [token, setToken] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const s = await fetchDuckDnsStatus();
      setStatus(s);
      if (s.configured) {
        setSubdomain(s.subdomain);
        setEnabled(s.enabled);
      }
    } catch (e) {
      // 403 = non-admin; hide the entire card. Other errors → show.
      const msg = e instanceof Error ? e.message : "Failed to load DuckDNS status";
      if (msg.startsWith("403")) {
        setAdminVisible(false);
      } else {
        setErr(msg);
      }
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  if (!adminVisible) return null;

  const handleSave = async () => {
    if (!subdomain.trim() || !token.trim()) {
      setErr("Both subdomain and token are required.");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const s = await setDuckDnsConfig({ subdomain: subdomain.trim(), token: token.trim(), enabled });
      setStatus(s);
      setToken("");
      setEditing(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="dp-card p-5 mt-6">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h2 className="type-headline text-label-primary">Domain name (DuckDNS)</h2>
          <p className="type-caption-1 text-label-tertiary mt-1 max-w-lg">
            Free dynamic DNS so your tunnel keeps working when your home
            router&rsquo;s public IP changes. Sign up at{" "}
            <a
              href="https://www.duckdns.org/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent hover:text-accent-hover underline-offset-2 hover:underline"
            >
              duckdns.org
            </a>{" "}
            to get a subdomain and token.
          </p>
        </div>
        {status?.configured && !editing && (
          <button
            onClick={() => setEditing(true)}
            className="dp-btn-secondary type-footnote !min-h-[32px] !py-1 !px-3 flex-shrink-0"
          >
            Edit
          </button>
        )}
      </div>

      {err && (
        <div className="mb-3 p-2 bg-system-red/10 border border-system-red/20 rounded type-footnote text-system-red flex items-start gap-2">
          <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
          <span>{err}</span>
        </div>
      )}

      {status?.configured && !editing ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 text-sm">
          <Stat label="Domain" value={status.fullDomain} />
          <Stat label="Token" value={status.tokenSet ? "Stored" : "Missing"} />
          <Stat label="Status" value={status.enabled ? "Enabled" : "Disabled"} />
        </div>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="type-caption-1 text-label-tertiary mb-1 block">
                Subdomain
              </label>
              <div className="flex items-center gap-2">
                <input
                  value={subdomain}
                  onChange={(e) => setSubdomain(e.target.value.toLowerCase())}
                  placeholder="my-droplet"
                  className="dp-input flex-1"
                  maxLength={63}
                />
                <span className="type-footnote text-label-tertiary whitespace-nowrap">
                  .duckdns.org
                </span>
              </div>
            </div>
            <div>
              <label className="type-caption-1 text-label-tertiary mb-1 block">
                Token{status?.configured && status.tokenSet && " (replace)"}
              </label>
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={status?.configured ? "•••••• (stored)" : "Paste DuckDNS token"}
                className="dp-input"
                autoComplete="off"
              />
            </div>
          </div>
          <label className="flex items-center gap-2 type-footnote text-label-secondary cursor-pointer">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="rounded"
            />
            Run dynamic DNS updates
          </label>
          <div className="flex items-center justify-end gap-2 pt-1">
            {editing && (
              <button
                onClick={() => {
                  setEditing(false);
                  setErr(null);
                  setToken("");
                }}
                className="type-subheadline text-accent hover:text-accent-hover px-3 py-2 transition-colors"
              >
                Cancel
              </button>
            )}
            <button
              onClick={handleSave}
              disabled={saving}
              className="dp-btn-primary type-subheadline !min-h-[36px] !py-1.5"
            >
              {saving ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  Saving&hellip;
                </>
              ) : (
                "Save"
              )}
            </button>
          </div>
          {!status?.configured && (
            <p className="type-caption-2 text-label-quaternary">
              After saving here, also set <code className="font-mono">WIREGUARD_ENDPOINT_HOST</code>
              {" "}in <code className="font-mono">.env</code> to{" "}
              <code className="font-mono">{subdomain || "yourname"}.duckdns.org</code>
              {" "}and restart the orchestrator so new peer configs use the hostname.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="type-caption-2 text-label-quaternary uppercase tracking-wider">{label}</p>
      <p className="type-callout text-label-primary font-medium truncate">{value}</p>
    </div>
  );
}

function PeerRow({
  peer,
  isOwner,
  onRevoke,
}: {
  peer: VpnPeerInfo;
  isOwner: boolean;
  onRevoke: () => void;
}) {
  const isRevoked = peer.status === "revoked";
  // aria-label uses the row's primary visible identifier (deviceLabel),
  // falling back to the stable peer id when the label is empty. Mirrors
  // the WARP-220 pattern applied site-wide in WARP-292.
  const label = peer.deviceLabel?.trim() ? peer.deviceLabel : peer.id;
  return (
    <div className="dp-row group">
      <div className="flex items-center gap-3 flex-1 min-w-0">
        <div
          className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ${
            isRevoked
              ? "bg-label-quaternary/10 text-label-quaternary"
              : "bg-accent/15 text-accent"
          }`}
        >
          <Smartphone size={14} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="type-callout text-label-primary truncate">
            {peer.deviceLabel}
            {isRevoked && (
              <span className="ml-2 type-caption-1 text-label-quaternary">
                · revoked
              </span>
            )}
          </p>
          <p className="type-caption-1 text-label-tertiary truncate">
            {peer.assignedIp} · {peer.userId}
          </p>
        </div>
      </div>
      {!isRevoked && isOwner && (
        // Always rendered (no opacity-gate) so touch + keyboard users can
        // reach the action. p-2.5 → 14 px icon + 20 px padding = 34 px
        // hit-target, clearing the ≥ 32 px ui-ux floor.
        <div className="flex items-center gap-0.5">
          <button
            onClick={onRevoke}
            aria-label={`Revoke device ${label}`}
            className="p-2.5 rounded-sm text-label-quaternary hover:text-system-red hover:bg-system-red/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent transition-colors"
            title="Revoke"
          >
            <Trash2 size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

// ─────────────────────── Add Device dialog ────────────────────────
//
// Two-step: name the device, then show the QR + .conf. The .conf comes
// back ONCE in the create response — we keep it in component state and
// drop it on close. There's no way to re-fetch it; the user revokes and
// re-mints if they lose it.
//
// WARP-291: built on top of the shared <Dialog> primitive so ARIA +
// focus + Escape + scroll-lock all come from there.

function AddDeviceDialog({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: () => void;
}) {
  const [step, setStep] = useState<"form" | "ready">("form");
  const [deviceLabel, setDeviceLabel] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<VpnPeerCreatedInfo | null>(null);
  const [copied, setCopied] = useState(false);
  const headingId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);

  const handleCreate = async () => {
    const trimmed = deviceLabel.trim();
    if (!trimmed) {
      setError("Give this device a name (e.g. \"Alice's iPhone\")");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await createVpnPeer(trimmed);
      setCreated(result);
      setStep("ready");
      onAdded();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add device");
    } finally {
      setSubmitting(false);
    }
  };

  const handleCopyConf = () => {
    if (!created) return;
    navigator.clipboard.writeText(created.conf);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleDownloadConf = () => {
    if (!created) return;
    const safeName = created.peer.deviceLabel.replace(/[^a-z0-9_-]+/gi, "_") || "wg-peer";
    const blob = new Blob([created.conf], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${safeName}.conf`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      labelledBy={headingId}
      maxWidth="md"
      initialFocusRef={inputRef}
    >
      <div>
        <div className="flex items-center justify-between px-4 py-3 border-b border-separator">
          <h3 id={headingId} className="type-headline text-label-primary">
            {step === "form" ? "Add a device" : "Scan to connect"}
          </h3>
          <button
            onClick={onClose}
            className="p-1 text-label-tertiary hover:text-label-primary"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        {step === "form" && (
          <div className="p-5 space-y-4">
            <div>
              <label className="type-caption-1 text-label-tertiary mb-1.5 block">
                Device name
              </label>
              <input
                ref={inputRef}
                value={deviceLabel}
                onChange={(e) => setDeviceLabel(e.target.value)}
                placeholder="Alice&rsquo;s iPhone"
                className="dp-input"
                onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                maxLength={64}
              />
              <p className="type-caption-2 text-label-quaternary mt-1.5">
                You&rsquo;ll see this label in the device list. The phone or laptop
                you&rsquo;re adding doesn&rsquo;t need to know it.
              </p>
            </div>

            {error && (
              <div className="p-2 bg-system-red/10 border border-system-red/20 rounded type-footnote text-system-red flex items-start gap-2">
                <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                onClick={onClose}
                className="type-subheadline text-accent hover:text-accent-hover px-3 py-2 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={submitting}
                className="dp-btn-primary type-subheadline !min-h-[36px] !py-1.5"
              >
                {submitting ? (
                  <>
                    <Loader2 size={14} className="animate-spin" />
                    Generating&hellip;
                  </>
                ) : (
                  "Generate"
                )}
              </button>
            </div>
          </div>
        )}

        {step === "ready" && created && (
          <div className="p-5 space-y-4">
            <ol className="type-footnote text-label-secondary list-decimal pl-5 space-y-1">
              <li>
                Install <strong>WireGuard</strong> from the App Store or Play Store.
              </li>
              <li>
                Open the app, tap <strong>+</strong>, choose <strong>Create from QR code</strong>,
                and scan the code below.
              </li>
              <li>Activate the new tunnel — done.</li>
            </ol>

            <div className="flex justify-center">
              <div className="p-4 bg-white rounded-lg">
                <QRCodeSVG
                  value={created.conf}
                  size={224}
                  level="M"
                  includeMargin={false}
                />
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={handleCopyConf}
                className="flex-1 dp-btn-secondary type-footnote !min-h-[36px] !py-1.5"
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
                {copied ? "Copied" : "Copy text"}
              </button>
              <button
                onClick={handleDownloadConf}
                className="flex-1 dp-btn-secondary type-footnote !min-h-[36px] !py-1.5"
              >
                <Download size={14} />
                Download .conf
              </button>
            </div>

            <div className="p-3 bg-system-orange/10 border border-system-orange/20 rounded type-caption-1 text-system-orange flex items-start gap-2">
              <ShieldOff size={14} className="mt-0.5 flex-shrink-0" />
              <span>
                Save this now — the private key is shown once. If you lose it,
                revoke this device and add a new one.
              </span>
            </div>

            <div className="flex justify-end pt-1">
              <button
                onClick={onClose}
                className="dp-btn-primary type-subheadline !min-h-[36px] !py-1.5"
              >
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}
