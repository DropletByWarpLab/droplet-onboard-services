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
import { ShellPage } from "@/components/shell/ShellPage";
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
import { translateError } from "@/lib/friendly-errors";

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
      setError(translateError(err, "vpn"));
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
      toast(translateError(err, "vpn"), "error");
      throw err;
    }
  };

  const activePeers = peers.filter((p) => p.status === "active");
  const endpointMissing = status && !status.endpointConfigured;

  const addAction = (
    <button
      className="btn primary"
      onClick={() => setShowAdd(true)}
      disabled={endpointMissing === true}
      type="button"
    >
      <Plus size={15} />
      <span>Add device</span>
    </button>
  );

  return (
    <ShellPage
      icon={<Globe size={15} />}
      label="Remote Access"
      title="Remote Access"
      sub="Connect your phone or laptop to your home network from anywhere. Add a device, scan the QR code in the WireGuard app, and you’re in."
      actions={addAction}
    >
      {error && (
        <div
          className="card"
          style={{ marginBottom: 14, display: "flex", alignItems: "center", justifyContent: "space-between", borderColor: "rgba(239,68,68,0.3)", color: "#ef4444" }}
        >
          <span style={{ fontSize: 13 }}>{error}</span>
          <button onClick={() => setError(null)} type="button" aria-label="Dismiss error" className="icon-btn" style={{ width: 28, height: 28 }}>
            <X size={12} />
          </button>
        </div>
      )}

      {endpointMissing && (
        <div className="card" style={{ marginBottom: 14, borderColor: "rgba(217,163,92,0.3)" }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
            <AlertCircle size={16} style={{ color: "#d9a35c", flexShrink: 0, marginTop: 2 }} />
            <div>
              <p style={{ fontWeight: 600, color: "var(--text)", fontSize: 13.5 }}>Endpoint host not configured</p>
              <p style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 2 }}>
                Set <code style={{ fontFamily: "var(--font-mono)" }}>WIREGUARD_ENDPOINT_HOST</code> in{" "}
                <code style={{ fontFamily: "var(--font-mono)" }}>.env</code> to your DuckDNS subdomain or your
                home router’s public IP, then restart the orchestrator.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Server status card — small, only when configured */}
      {status?.configured && (
        <div className="card grid c4" style={{ marginBottom: 16 }}>
          <Stat label="Endpoint" value={status.endpointHost ? `${status.endpointHost}:${status.listenPort}` : "—"} />
          <Stat label="VPN subnet" value={status.addresses?.[0] ?? "—"} />
          <Stat label="Active devices" value={String(activePeers.length)} />
          <Stat label="Server key" value={status.serverPublicKey?.slice(0, 8) + "…"} />
        </div>
      )}

      {/* Peer list */}
      <div className="card rows" style={{ padding: "4px 18px" }}>
        {loading && peers.length === 0 ? (
          <div className="lrow" style={{ justifyContent: "center", color: "var(--text-muted)" }}>Loading…</div>
        ) : peers.length === 0 ? (
          <div className="empty">
            <span className="ei"><Globe size={24} /></span>
            <span className="eh">No devices yet</span>
            <span>Tap “Add device” to set up your first phone or laptop.</span>
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

      {/* DuckDNS card — only renders when the user is an admin. */}
      <DuckDnsCard />

      {showAdd && <AddDeviceDialog onClose={() => setShowAdd(false)} onAdded={reload} />}

      <ConfirmDialog
        open={revokeTarget !== null}
        onConfirm={handleRevokeConfirm}
        onCancel={() => setRevokeTarget(null)}
        title={revokeTarget ? `Revoke "${revokeTarget.deviceLabel}"?` : "Revoke device?"}
        description="It will be disconnected from your network immediately and the WireGuard config on the device will stop working."
        confirmLabel="Revoke"
        variant="destructive"
      />
    </ShellPage>
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
        setErr(translateError(e, "vpn"));
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
      setErr(translateError(e, "vpn"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card" style={{ marginTop: 24 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
        <div>
          <h2 style={{ fontSize: 16, fontWeight: 600, color: "var(--text)" }}>Domain name (DuckDNS)</h2>
          <p style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 4, maxWidth: "32rem" }}>
            Free dynamic DNS so your tunnel keeps working when your home router&rsquo;s public IP
            changes. Sign up at{" "}
            <a href="https://www.duckdns.org/" target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
              duckdns.org
            </a>{" "}
            to get a subdomain and token.
          </p>
        </div>
        {status?.configured && !editing && (
          <button onClick={() => setEditing(true)} className="btn sm" type="button" style={{ flexShrink: 0 }}>
            Edit
          </button>
        )}
      </div>

      {err && (
        <div style={{ marginBottom: 12, padding: 10, borderRadius: 10, border: "1px solid rgba(239,68,68,0.25)", background: "rgba(239,68,68,0.08)", color: "#ef4444", fontSize: 13, display: "flex", alignItems: "flex-start", gap: 8 }}>
          <AlertCircle size={14} style={{ marginTop: 2, flexShrink: 0 }} />
          <span>{err}</span>
        </div>
      )}

      {status?.configured && !editing ? (
        <div className="grid c3">
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
          <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8, paddingTop: 4 }}>
            {editing && (
              <button
                onClick={() => {
                  setEditing(false);
                  setErr(null);
                  setToken("");
                }}
                className="btn ghost"
                type="button"
              >
                Cancel
              </button>
            )}
            <button onClick={handleSave} disabled={saving} className="btn primary" type="button">
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
      <p style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-muted)" }}>{label}</p>
      <p
        style={{ fontSize: 15, fontWeight: 600, color: "var(--text)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
      >
        {value}
      </p>
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
    <div className="lrow">
      <span className={"ri" + (isRevoked ? "" : " brand")}>
        <Smartphone size={16} />
      </span>
      <span className="rt">
        <span className="nm">
          {peer.deviceLabel}
          {isRevoked && <span style={{ marginLeft: 8, fontSize: 12, color: "var(--text-faint)" }}>· revoked</span>}
        </span>
        <span className="sub mono">
          {peer.assignedIp} · {peer.userId}
        </span>
      </span>
      {!isRevoked && isOwner && (
        <button
          onClick={onRevoke}
          aria-label={`Revoke device ${label}`}
          className="k-iconbtn danger"
          title="Revoke"
          type="button"
        >
          <Trash2 size={14} />
        </button>
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
      setError(translateError(err, "vpn"));
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
