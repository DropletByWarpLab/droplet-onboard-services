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
  Link2,
  ShieldAlert,
  Fingerprint,
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
  mintOverlayLinkToken,
  fetchPendingOverlayEnrollments,
  approveOverlayEnrollment,
  denyOverlayEnrollment,
} from "@/lib/api";
import type {
  VpnPeerInfo,
  VpnStatusInfo,
  VpnPeerCreatedInfo,
  OverlayLinkToken,
  PendingOverlayEnrollment,
} from "@/lib/types";
import { Dialog } from "@/components/Dialog";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";
import { translateError } from "@/lib/friendly-errors";
import { dashboardUrlFromConf } from "@/lib/wireguard";
import {
  buildOverlayEnrollUri,
  overlayApproveErrorCopy,
} from "@/lib/overlay-enroll";
import { formatRelativeTime } from "@/lib/relative-time";
import { peerConnectionCopy } from "@/lib/vpn-peer-liveness";

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
  const [showLink, setShowLink] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<VpnPeerInfo | null>(null);
  const { toast } = useToast();

  // WARP-1475: the overlay QR-enroll flow (mint + approval queue) is
  // owner/admin-only — the orchestrator gates the mint / pending-list /
  // approve / deny routes to those roles, so we only render the affordances
  // for them (never a button that would 403).
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
      : homeMintBlocked
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
      {/* WARP-1475: owner/admin-only overlay QR-enroll — a device scans the
          code with the Droplet app, then the owner approves it below. */}
      {isOwnerOrAdmin && status && status.overlayEnrollmentAvailable !== false && (
        <button
          className="btn"
          onClick={() => setShowLink(true)}
          type="button"
          // Disambiguates from "Add device" for a non-technical owner: Link is
          // the flow for a device that already runs the Droplet app.
          title="Link a device that has the Droplet app"
        >
          <Link2 size={15} />
          <span>Link a device</span>
        </button>
      )}
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

      {/* WARP-1475: overlay QR-enroll approval queue (owner/admin only). Sits
          above the peer list because approving here is the load-bearing gate
          that turns a scan into an enrolled device. */}
      {isOwnerOrAdmin && status && status.overlayEnrollmentAvailable !== false && <PendingEnrollments />}

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

      {/* How remote access works — the box's own web address + one-tap Connect. */}
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

      {showLink && <LinkDeviceDialog onClose={() => setShowLink(false)} />}

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
                <select
                  className="w-full mt-1.5 px-3 py-2.5 bg-[var(--surface)] text-[var(--text)] border border-[var(--border)] rounded"
                  value={mode}
                  onChange={(event) => setMode(event.target.value as "home" | "away")}
                >
                  {homeAvailable && <option value="home">Office network</option>}
                  <option value="away">Away from the office</option>
                </select>
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

// ─────────────────────── Link Device dialog (overlay QR-enroll) ──────────────
//
// WARP-1475 (ADR-030). Owner/admin-only. Mints a single-use link token on open
// and renders it as a `droplet://overlay-enroll` QR. The token is returned by
// the box ONCE (only its hash is persisted) — it lives only in this dialog's
// state, is cleared when the dialog unmounts, and is NEVER logged. Minting a new
// code supersedes (invalidates) the prior one. A scan STAGES a pending
// enrollment that the owner approves in the queue below; the QR alone grants no
// access.

function LinkDeviceDialog({ onClose }: { onClose: () => void }) {
  const headingId = useId();
  const [token, setToken] = useState<OverlayLinkToken | null>(null);
  const [minting, setMinting] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const startedRef = useRef(false);

  const mint = useCallback(async () => {
    setMinting(true);
    setError(null);
    try {
      // The plaintext token is held only here and rendered into the QR — never
      // console-logged, never lifted into a parent store.
      const minted = await mintOverlayLinkToken();
      setToken(minted);
    } catch (err) {
      setToken(null);
      setError(translateError(err, "vpn"));
    } finally {
      setMinting(false);
    }
  }, []);

  // Mint once on open (ref-guarded against StrictMode's double-invoke so a
  // second token can't silently supersede the first the moment the dialog
  // appears).
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void mint();
  }, [mint]);

  const enrollUri = token
    ? buildOverlayEnrollUri({
        server: token.server,
        token: token.token,
        boxName: token.box_name,
      })
    : null;

  return (
    <Dialog open onClose={onClose} labelledBy={headingId} maxWidth="md" flush>
      <div>
        <div className="flex items-center justify-between px-4 py-3 border-b border-separator">
          <h3 id={headingId} className="type-headline text-label-primary">
            Link a device
          </h3>
          <button
            onClick={onClose}
            className="p-1 text-label-tertiary hover:text-label-primary transition-colors"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <ol className="type-footnote text-label-secondary list-decimal pl-5 space-y-1">
            <li>
              Open the <strong>Droplet app</strong> on the device you want to add.
            </li>
            <li>
              Choose <strong>Link a device</strong> and scan the code below.
            </li>
            <li>
              Come back here and <strong>approve</strong> it — it can&rsquo;t
              connect until you do.
            </li>
          </ol>

          {minting && (
            <div className="flex items-center justify-center gap-2 py-8 text-label-tertiary">
              <Loader2 size={16} className="animate-spin" />
              <span className="type-subheadline">Generating a code&hellip;</span>
            </div>
          )}

          {error && !minting && (
            <div className="p-2 bg-system-red/10 border border-system-red/20 rounded type-footnote text-system-red flex items-start gap-2">
              <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {enrollUri && !minting && (
            <>
              <div className="flex justify-center">
                <div className="p-4 bg-white rounded-lg">
                  <QRCodeSVG
                    value={enrollUri}
                    size={224}
                    level="M"
                    includeMargin={false}
                  />
                </div>
              </div>

              <div className="p-3 bg-system-orange/10 border border-system-orange/20 rounded type-caption-1 text-system-orange flex items-start gap-2">
                <ShieldOff size={14} className="mt-0.5 flex-shrink-0" />
                <span>
                  This code expires in about 5 minutes and is shown once.
                  Minting a new code invalidates this one — re-mint if it&rsquo;s
                  lost.
                </span>
              </div>
            </>
          )}

          <div className="flex items-center justify-between pt-1">
            <button
              onClick={() => void mint()}
              disabled={minting}
              className="btn"
              type="button"
            >
              <RefreshCw size={14} />
              Generate a new code
            </button>
            <button onClick={onClose} className="btn primary" type="button">
              Done
            </button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

// ─────────────────────── Pending enrollment queue ───────────────────────────
//
// WARP-1475 (ADR-030). Owner/admin-only. Lists staged overlay enrollments and
// is the load-bearing approval gate: a scan only becomes a network grant when
// the owner approves here. Polls on an interval so a scan surfaces without a
// manual refresh. The device-presented `label` is UNTRUSTED — rendered as text
// only (React escapes it; never dangerouslySetInnerHTML). A `conflict` row (a
// different device redeemed the same code) is flagged as a security event with
// distinct styling, not a benign expiry.

const OVERLAY_POLL_MS = 10_000;

function PendingEnrollments() {
  const [rows, setRows] = useState<PendingOverlayEnrollment[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const { toast } = useToast();

  const reload = useCallback(async () => {
    try {
      const data = await fetchPendingOverlayEnrollments();
      setRows(data);
    } catch {
      // A transient poll failure is non-actionable — keep the last-known list
      // rather than flashing an error banner every interval. Approve/deny
      // surface their own errors inline.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    const id = setInterval(() => void reload(), OVERLAY_POLL_MS);
    return () => clearInterval(id);
  }, [reload]);

  const handleApprove = useCallback(
    async (row: PendingOverlayEnrollment) => {
      setBusyId(row.id);
      try {
        await approveOverlayEnrollment(row.id);
        toast(
          `Approved "${row.label?.trim() || "device"}".`,
          "success",
        );
        await reload();
      } catch (err) {
        // Honest per-case copy for the 409/503 states — never a raw code.
        toast(
          overlayApproveErrorCopy(
            err as { status?: number; code?: string; message?: string },
          ),
          "error",
        );
      } finally {
        setBusyId(null);
      }
    },
    [reload, toast],
  );

  const handleDeny = useCallback(
    async (row: PendingOverlayEnrollment) => {
      setBusyId(row.id);
      try {
        await denyOverlayEnrollment(row.id);
        toast(`Denied "${row.label?.trim() || "device"}".`, "info");
        await reload();
      } catch (err) {
        toast(translateError(err, "vpn"), "error");
      } finally {
        setBusyId(null);
      }
    },
    [reload, toast],
  );

  // Only actionable states belong in the queue — approved/denied/expired are
  // history, not decisions the owner still has to make.
  const visible = rows.filter(
    (r) => r.state === "pending" || r.state === "approving",
  );
  // A conflict row is a security event — escalate the live-region politeness so
  // a screen-reader owner is interrupted rather than merely queued behind other
  // announcements. Benign additions stay polite.
  const hasConflict = visible.some((r) => r.conflict);

  return (
    <div
      className="card"
      style={{ marginBottom: 16 }}
      // The queue polls every 10s; without a live region a screen-reader owner
      // never learns a device (or a conflict) appeared.
      aria-live={hasConflict ? "assertive" : "polite"}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: visible.length ? 12 : 0 }}>
        <div>
          <h2 style={{ fontSize: 16, fontWeight: 600, color: "var(--text)" }}>
            Devices waiting to link
          </h2>
          <p style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 2 }}>
            {/* ADR-002: name the consequence. Approving is not just an
                acknowledgement — it grants the device access to the network. */}
            Scanned devices appear here. Approving one gives it remote access to
            your network, so approve only a device you recognize.
          </p>
        </div>
        <button
          onClick={() => void reload()}
          className="k-iconbtn"
          title="Refresh"
          aria-label="Refresh waiting devices"
          type="button"
        >
          <RefreshCw size={14} />
        </button>
      </div>

      {visible.length === 0 ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            paddingTop: 12,
            fontSize: 12.5,
            color: "var(--text-muted)",
          }}
        >
          <Smartphone size={14} style={{ flexShrink: 0 }} />
          <span>
            {loading
              ? "Checking for devices…"
              : "No devices waiting. Tap “Link a device” to add one."}
          </span>
        </div>
      ) : (
        <div className="space-y-2">
          {visible.map((row) => (
            <PendingEnrollmentRow
              key={row.id}
              row={row}
              busy={busyId === row.id}
              onApprove={() => handleApprove(row)}
              onDeny={() => handleDeny(row)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function PendingEnrollmentRow({
  row,
  busy,
  onApprove,
  onDeny,
}: {
  row: PendingOverlayEnrollment;
  busy: boolean;
  onApprove: () => void;
  onDeny: () => void;
}) {
  // Device-presented label — untrusted; interpolated as TEXT (React escapes it).
  const displayLabel = row.label?.trim() || "Unnamed device";
  const approving = row.state === "approving";
  const disabled = busy || approving;

  return (
    <div
      className={
        "flex items-start gap-3 p-3 rounded-lg border " +
        (row.conflict
          ? "border-system-red/30 bg-system-red/10"
          : "border-separator")
      }
      style={row.conflict ? undefined : { background: "var(--surface)" }}
    >
      <span
        className={"flex-shrink-0 mt-0.5 " + (row.conflict ? "text-system-red" : "text-label-tertiary")}
      >
        {row.conflict ? <ShieldAlert size={18} /> : <Smartphone size={18} />}
      </span>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="type-subheadline text-label-primary font-medium break-all">
            {displayLabel}
          </span>
          {row.conflict && (
            <span className="type-caption-2 px-1.5 py-0.5 rounded bg-system-red/10 text-system-red border border-system-red/25">
              Unexpected device
            </span>
          )}
        </div>

        <div className="type-caption-1 text-label-tertiary mt-0.5 flex items-center gap-2 flex-wrap">
          <span className="inline-flex items-center gap-1 font-mono">
            <Fingerprint size={12} aria-hidden="true" />
            {row.fingerprint_short}
          </span>
          <span aria-hidden="true">·</span>
          <span>{formatRelativeTime(row.presented_at)}</span>
        </div>

        {/* Without this, the short code is decorative to a non-technical owner.
            It's the one signal that ties this row to the physical device. */}
        <p className="type-caption-2 text-label-secondary mt-1">
          Check this code matches the one shown in the Droplet app on that
          device.
        </p>

        {row.conflict && (
          // The security note is the highest-stakes copy on the row. Pairing
          // `text-system-red` with its own `bg-system-red/10` tint fires the
          // WARP-633 compound-selector override in globals.css, which repoints
          // the text to --color-system-red-text (#b91c1c, ≥4.5:1 on the tint —
          // still ≥5:1 even over the row's own red wash). Matches the sibling
          // inline-error boxes elsewhere in this file.
          <p className="type-footnote text-system-red bg-system-red/10 border border-system-red/20 rounded p-2 mt-2">
            A different device tried to use this code. Approve only if you
            recognize it — otherwise deny it.
          </p>
        )}
      </div>

      <div className="flex items-center gap-2 flex-shrink-0">
        <button
          onClick={onDeny}
          disabled={disabled}
          className="btn sm"
          aria-label={`Deny device ${displayLabel}`}
          type="button"
        >
          Deny
        </button>
        <button
          onClick={onApprove}
          disabled={disabled}
          className="btn sm primary"
          aria-label={`Approve device ${displayLabel}`}
          type="button"
        >
          {disabled ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <Check size={13} />
          )}
          {approving ? "Approving…" : "Approve"}
        </button>
      </div>
    </div>
  );
}
