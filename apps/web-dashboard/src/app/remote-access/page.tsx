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
  RefreshCw,
} from "lucide-react";
import { ShellPage } from "@/components/shell/ShellPage";
import { useAuth } from "@/lib/auth";
import { OVERLAY_PEER_USER_ID } from "@droplet/auth-policy";
import {
  fetchVpnStatus,
  fetchVpnPeers,
  createVpnPeer,
  deleteVpnPeer,
} from "@/lib/api";
import type {
  VpnPeerInfo,
  VpnStatusInfo,
  VpnPeerCreatedInfo,
} from "@/lib/types";
import { Dialog } from "@/components/Dialog";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";
import { translateError } from "@/lib/friendly-errors";
import { dashboardUrlFromConf } from "@/lib/wireguard";
import { formatRelativeTime } from "@/lib/relative-time";
import { peerConnectionCopy } from "@/lib/vpn-peer-liveness";
import { ThemedSelect } from "@/components/ui/ThemedSelect";

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
  // WARP-1763: false when the orchestrator couldn't read the running
  // interface. Kept separate from the peer rows because it is a fact about the
  // OBSERVATION, not about any device.
  const [liveState, setLiveState] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<VpnPeerInfo | null>(null);
  const { toast } = useToast();

  const isOwnerOrAdmin =
    currentUser?.role === "owner" || currentUser?.role === "admin";

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, p] = await Promise.all([
        fetchVpnStatus(),
        fetchVpnPeers().catch(() => ({
          peers: [] as VpnPeerInfo[],
          // A failed fetch observed nothing, so the rows must not claim to
          // know a connection state (WARP-1763).
          liveStateAvailable: false,
        })),
      ]);
      setStatus(s);
      setPeers(p.peers || []);
      setLiveState(p.liveStateAvailable === true);
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
  const endpointMissing = status && !status.endpointConfigured && !status.homeEndpointHost;
  // Office configs require a discovered local endpoint. Away configs require
  // a configured direct endpoint; neither needs a fleet-issued web address.
  const homeMintBlocked = Boolean(status) && !status?.homeEndpointHost;
  // WARP-2689: the router holds a wg0 section but the kernel has no device —
  // it was flashed without WireGuard. `configured: true` alone would keep this
  // page looking ready while every device added here could never connect.
  // Strictly `=== false`: null/absent is "the router could not say" and must
  // not disable anything.
  const routerUnsupported = status?.interfaceLive === false;
  // a11y: when "Add device" is disabled, point screen-reader users at the card
  // that explains WHY (aria-describedby). endpointMissing takes precedence — its
  // card renders instead of the home-address one (they never stack).
  const disabledReasonId = routerUnsupported
    ? "ra-router-guidance"
    : endpointMissing
      ? "ra-endpoint-guidance"
      : homeMintBlocked && status?.offLanReachable !== true
        ? "ra-home-guidance"
        : undefined;
  // This indicates a configured direct endpoint, not a measured handshake.
  // Missing field (older orchestrator) or status still loading ⇒ stay honest.
  const offLanReachable = status?.offLanReachable === true;

  const addAction = (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <button className="btn" onClick={() => void reload()} disabled={loading} type="button" aria-label="Refresh remote access">
        <RefreshCw size={15} />
      </button>
      <button
        className="btn primary"
        onClick={() => setShowAdd(true)}
        disabled={loading || !status || routerUnsupported || endpointMissing === true || (homeMintBlocked && !offLanReachable)}
        aria-describedby={disabledReasonId}
        type="button"
      >
        <Plus size={15} />
        <span>Add device</span>
      </button>
    </div>
  );

  return (
    <ShellPage
      icon={<Globe size={15} />}
      label="Remote Access"
      title="Remote Access"
      sub={
        offLanReachable
          ? "Connect through WireGuard and use your office’s internal DNS. Add a device and choose an office or away connection, then scan the QR code in the WireGuard app."
          : "Connect through WireGuard and use your office’s internal DNS. Add a device, scan the QR code in the WireGuard app, then turn on the tunnel. Away access needs a reachable WireGuard endpoint."
      }
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

      {/* WARP-2689: the one state no amount of waiting clears — the router
          itself cannot run WireGuard. Rendered above the two "not ready yet"
          cards because it is the reason they would never resolve, and in the
          red tone because it needs a person to act, not to wait. */}
      {routerUnsupported && (
        <div id="ra-router-guidance" className="card" role="alert" style={{ marginBottom: 14, borderColor: "rgba(239,68,68,0.3)" }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
            <AlertCircle size={16} style={{ color: "#ef4444", flexShrink: 0, marginTop: 2 }} />
            <div>
              <p style={{ fontWeight: 600, color: "var(--text)", fontSize: 13.5 }}>Your router can’t run remote access yet</p>
              <p style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 2 }}>
                It’s missing WireGuard support, so devices added here wouldn’t be
                able to connect. Update the router’s software, then come back —
                there’s nothing else to set up.
              </p>
            </div>
          </div>
        </div>
      )}

      {endpointMissing && (
        <div id="ra-endpoint-guidance" className="card" style={{ marginBottom: 14, borderColor: "rgba(217,163,92,0.3)" }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
            <AlertCircle size={16} style={{ color: "#d9a35c", flexShrink: 0, marginTop: 2 }} />
            <div>
              <p style={{ fontWeight: 600, color: "var(--text)", fontSize: 13.5 }}>WireGuard endpoint not ready yet</p>
              <p style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 2 }}>
                Your Droplet’s local network address could not be read. Check the
                router connection, then refresh this page. Your network administrator
                can also configure a direct WireGuard endpoint for away access.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* An older status response can report an endpoint without a usable
          office address or direct away endpoint. Keep minting disabled until
          one is available; avoid stacking this with the endpoint warning. */}
      {homeMintBlocked && !endpointMissing && !offLanReachable && (
        <div id="ra-home-guidance" className="card" style={{ marginBottom: 14, borderColor: "rgba(217,163,92,0.3)" }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
            <AlertCircle size={16} style={{ color: "#d9a35c", flexShrink: 0, marginTop: 2 }} />
            <div>
              <p style={{ fontWeight: 600, color: "var(--text)", fontSize: 13.5 }}>Local address not ready yet</p>
              <p style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 2 }}>
                Once your Droplet’s local address is ready you’ll be able to add a device —
                it works on your office Wi-Fi, and the button turns on
                automatically, with nothing to enter. If this doesn’t clear on
                its own, restart the box.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Server status card — small, only when configured */}
      {status?.configured && (
        <div className="card grid c4" style={{ marginBottom: 16 }}>
          <Stat label="Office endpoint" value={status.homeEndpointHost ? `${status.homeEndpointHost}:${status.listenPort}` : "—"} />
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
              // WARP-1763: gate on ROLE, matching what the API actually
              // enforces (`requireRole("owner", "admin")` on
              // DELETE /api/vpn/peers/:id). The previous gate compared
              // `peer.userId` to the signed-in username, which was wrong in
              // both directions: a QR-linked device is stored under the
              // synthetic userId "overlay" and so could never show the button
              // to anyone, while a family user WAS shown a button for their
              // own device that the API would 403.
              // WARP-3121: the API now also lets anyone revoke an OVERLAY
              // device enrolled under their own username (a forgotten or lost
              // laptop); static peers stay owner/admin only.
              canRevoke={
                isOwnerOrAdmin ||
                (peer.kind === "overlay" &&
                  peer.userId !== OVERLAY_PEER_USER_ID &&
                  !!currentUser?.username &&
                  peer.userId === currentUser.username)
              }
              liveStateAvailable={liveState}
              onRevoke={() => setRevokeTarget(peer)}
            />
          ))
        )}
      </div>

      {/* How remote access works — WireGuard and the internal DNS address. */}
      <RemoteAddressCard status={status} />

      {showAdd && (
        <AddDeviceDialog
          onClose={() => setShowAdd(false)}
          onAdded={reload}
          internalHostname={status?.internalHostname ?? null}
          homeAvailable={Boolean(status?.homeEndpointHost)}
          offLanReachable={offLanReachable}
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
    </ShellPage>
  );
}

// ─────────────────────── Remote address card ────────────────────────
//
// Internal DNS is provisioned locally and remains independent of fleet TLS.

function RemoteAddressCard({ status }: { status: VpnStatusInfo | null }) {
  const address = status?.internalHostname?.trim() || null;
  const offLanReachable = status?.offLanReachable === true;

  return (
    <div className="card" style={{ marginTop: 24 }}>
      <div style={{ marginBottom: 12 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, color: "var(--text)" }}>Your Droplet&rsquo;s internal address</h2>
        <p style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 4, maxWidth: "34rem" }}>
          Open this address on your office network, or after connecting through
          WireGuard. The tunnel uses your office DNS to resolve the same internal
          name. HTTPS uses your Droplet&rsquo;s certificate; your device may need
          to trust it before your browser opens the page.
        </p>
      </div>

      {address ? (
        <div className="grid c2">
          <Stat label="Internal web address" value={`https://${address}`} />
          <Stat
            label="Away from the office"
            value={
              offLanReachable
                ? "Direct WireGuard endpoint configured"
                : "WireGuard endpoint needs configuration"
            }
          />
        </div>
      ) : (
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 8,
            padding: 10,
            borderRadius: 10,
            border: "1px solid rgba(217,163,92,0.25)",
            background: "rgba(217,163,92,0.08)",
            fontSize: 12.5,
            color: "var(--text-muted)",
          }}
        >
          <Globe size={14} style={{ marginTop: 2, flexShrink: 0, color: "#d9a35c" }} />
          <span>
            {status
              ? "Your internal DNS name is unavailable. Check the router DNS setup with your network administrator."
              : "Loading your internal address…"}
          </span>
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
  canRevoke,
  liveStateAvailable,
  onRevoke,
}: {
  peer: VpnPeerInfo;
  canRevoke: boolean;
  liveStateAvailable: boolean;
  onRevoke: () => void;
}) {
  const isRevoked = peer.status === "revoked";
  // aria-label uses the row's primary visible identifier (deviceLabel),
  // falling back to the stable peer id when the label is empty. Mirrors
  // the WARP-220 pattern applied site-wide in WARP-292.
  const label = peer.deviceLabel?.trim() ? peer.deviceLabel : peer.id;
  const isLinked = peer.kind === "overlay";
  const conn = isRevoked
    ? null
    : peerConnectionCopy(peer, liveStateAvailable);
  // Overlay peers carry the synthetic userId "overlay", which is an
  // implementation detail and means nothing to the person reading the row.
  // Show who linked it instead, and fall back to the owning username for
  // static peers, which is a real account name.
  const attribution = isLinked
    ? peer.linkTokenEnrolledBy
      ? `linked by ${peer.linkTokenEnrolledBy}`
      : "linked by QR"
    : peer.userId;
  return (
    <div className="lrow">
      <span className={"ri" + (isRevoked ? "" : " brand")}>
        <Smartphone size={16} />
      </span>
      <span className="rt">
        <span className="nm">
          {peer.deviceLabel}
          {isLinked && (
            <span className="badge info" style={{ marginLeft: 8, flexShrink: 0 }}>
              Linked device
            </span>
          )}
          {isRevoked && <span style={{ marginLeft: 8, fontSize: 12, color: "var(--text-faint)" }}>· revoked</span>}
        </span>
        <span className="sub mono">
          {peer.assignedIp} · {attribution}
        </span>
        {conn && (
          <span
            className="sub"
            style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}
          >
            <span className={`badge ${conn.tone}`}>{conn.text}</span>
            {isLinked && peer.enrolledAt ? (
              <span>linked {formatRelativeTime(peer.enrolledAt)}</span>
            ) : null}
          </span>
        )}
      </span>
      {!isRevoked && canRevoke && (
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
  internalHostname,
  homeAvailable,
  offLanReachable,
}: {
  onClose: () => void;
  onAdded: () => void;
  internalHostname: string | null;
  homeAvailable: boolean;
  /** Whether an away config is available in addition to an office config. */
  offLanReachable: boolean;
}) {
  const [step, setStep] = useState<"form" | "ready">("form");
  const [mode, setMode] = useState<"home" | "away">(homeAvailable ? "home" : "away");
  const [deviceLabel, setDeviceLabel] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<VpnPeerCreatedInfo | null>(null);
  const [copied, setCopied] = useState(false);
  const headingId = useId();
  // WARP-650: label/input association for the device-name field.
  const deviceLabelId = useId();
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
      // Home dials the discovered office IP; away dials the explicit UDP endpoint.
      const result = await createVpnPeer(trimmed, mode);
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
      // Sectioned layout (full-width header divider) — sections own their
      // padding (WARP-1153).
      flush
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
            {offLanReachable && (
              <label className="type-caption-1 text-label-tertiary block">
                Connection
                <ThemedSelect
                  className="w-full mt-1.5 px-3 py-2.5 bg-[var(--surface)] text-[var(--text)] border border-[var(--border)] rounded"
                  value={mode}
                  onChange={(event) => setMode(event.target.value as "home" | "away")}
                >
                  {homeAvailable && <option value="home">Office network</option>}
                  <option value="away">Away from the office</option>
                </ThemedSelect>
              </label>
            )}
            <div>
              <label htmlFor={deviceLabelId} className="type-caption-1 text-label-tertiary mb-1.5 block">
                Device name
              </label>
              <input
                id={deviceLabelId}
                ref={inputRef}
                value={deviceLabel}
                onChange={(e) => setDeviceLabel(e.target.value)}
                placeholder="Alice&rsquo;s iPhone"
                className="w-full px-3 py-2.5 outline-none focus:ring-2 focus:ring-[var(--brand)] placeholder:text-[var(--text-faint)] transition-colors"
                style={{
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-input)",
                  color: "var(--text)",
                }}
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
                className="btn primary"
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
              <li>
                Activate the tunnel, then open{" "}
                <strong className="font-mono break-all">
                  {dashboardUrlFromConf(created.conf, internalHostname ?? undefined)}
                </strong>{" "}
                in the browser —{" "}
                {mode === "away"
                  ? "that’s your Droplet over WireGuard."
                  : "that’s your Droplet on your office network."}
              </li>
            </ol>
            <p className="type-caption-1 text-label-tertiary">
              {mode === "away" ? (
                <>
                  Test this connection from cellular or another network. The
                  WireGuard tunnel carries your office DNS and internal address.
                </>
              ) : (
                <>
                  This config connects on your office network. For an away
                  connection, your administrator needs to configure a reachable
                  WireGuard endpoint, then add a device for away access.
                </>
              )}
            </p>

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
                className="flex-1 btn justify-center"
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
                {copied ? "Copied" : "Copy text"}
              </button>
              <button
                onClick={handleDownloadConf}
                className="flex-1 btn justify-center"
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
                className="btn primary"
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
