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
  // WARP-1391: the "Add device" mint is HOME mode — Endpoint = the box's
  // discovered home-facing LAN IP (resolveHomeEndpointHost), NOT the away-mode
  // default's split-horizon public FQDN (that FQDN is public-NXDOMAIN by design
  // — WARP-954 / ADR-023 — so an away conf shows keepalive but zero handshakes).
  // When the box hasn't discovered that LAN IP yet (homeEndpointHost null/absent)
  // a home mint 503s, so gate the affordance off rather than offer a dead mint.
  // Missing field ⇒ treat as "not reachable at home yet" (never over-promise —
  // the WARP-993 offLanReachable convention). Only surfaced once status loads.
  const homeMintBlocked = Boolean(status) && !status?.homeEndpointHost;
  // WARP-993: only promise "from anywhere" when the endpoint is actually
  // routable from outside the home LAN. FQDN-only (split-horizon, no public
  // A record — ADR-023 §3) reports false until the ADR-025 relay lands.
  // Missing field (older orchestrator) or status still loading ⇒ stay honest.
  const offLanReachable = status?.offLanReachable === true;

  const addAction = (
    <button
      className="btn primary"
      onClick={() => setShowAdd(true)}
      disabled={endpointMissing === true || homeMintBlocked}
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
      sub={
        offLanReachable
          ? "Connect your phone or laptop to your office network from anywhere. Add a device, scan the QR code in the WireGuard app, and you’re in."
          : "Connect your phone or laptop to your Droplet over your office network. Add a device, scan the QR code in the WireGuard app, and you’re in. Away-from-office access arrives with the secure relay — coming soon."
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

      {endpointMissing && (
        <div className="card" style={{ marginBottom: 14, borderColor: "rgba(217,163,92,0.3)" }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
            <AlertCircle size={16} style={{ color: "#d9a35c", flexShrink: 0, marginTop: 2 }} />
            <div>
              <p style={{ fontWeight: 600, color: "var(--text)", fontSize: 13.5 }}>Web address not ready yet</p>
              <p style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 2 }}>
                Your box is still setting up its own web address. Remote access turns
                on automatically once that’s ready — no settings to enter. If this
                doesn’t clear on its own, restart the box.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* WARP-1391: the box has its internet address but hasn't discovered its
          home-network address yet, so a device can't be minted for home use
          right now. Say so honestly (same calm tone as the endpoint card) and
          keep "Add device" disabled until the address appears — no dead config,
          no over-promise. Only shown when the endpoint itself IS ready, so this
          never stacks with the "Web address not ready yet" card above. */}
      {homeMintBlocked && !endpointMissing && (
        <div className="card" style={{ marginBottom: 14, borderColor: "rgba(217,163,92,0.3)" }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
            <AlertCircle size={16} style={{ color: "#d9a35c", flexShrink: 0, marginTop: 2 }} />
            <div>
              <p style={{ fontWeight: 600, color: "var(--text)", fontSize: 13.5 }}>Home address not ready yet</p>
              <p style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 2 }}>
                Your box is still setting up its home address on your network.
                Adding a device works on your office Wi-Fi — the button lights up
                automatically once that address is ready, with nothing to enter.
                If this doesn’t clear on its own, restart the box.
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

      {/* How remote access works — the box's own web address + one-tap Connect. */}
      <RemoteAddressCard status={status} />

      {showAdd && (
        <AddDeviceDialog
          onClose={() => setShowAdd(false)}
          onAdded={reload}
          publicFqdn={status?.publicFqdn ?? null}
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
// Read-only status for the new remote-access model (ADR-023 / ADR-025): the box
// carries its own publicly-trusted web address and reaches you through an
// outbound relay. There is nothing to configure — no dynamic DNS, no subdomain
// or token. If the box hasn't learned its address from HQ yet, we describe it
// generically. WARP-993: the "works at home AND away / turn on Connect" story
// is only told when `offLanReachable` is true — until the ADR-025 relay lands,
// the address only resolves on the home network and the copy says so.

function RemoteAddressCard({ status }: { status: VpnStatusInfo | null }) {
  const address = status?.publicFqdn?.trim() || null;
  const offLanReachable = status?.offLanReachable === true;

  return (
    <div className="card" style={{ marginTop: 24 }}>
      <div style={{ marginBottom: 12 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, color: "var(--text)" }}>Your box&rsquo;s web address</h2>
        <p style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 4, maxWidth: "34rem" }}>
          {offLanReachable ? (
            <>
              Remote access is automatic. Your Droplet has its own secure web address — the same one
              works in the office and away, with a padlock and nothing to install. When you&rsquo;re out,
              open the Droplet app and turn on <strong>Connect</strong>, then open that address in your
              browser. No dynamic DNS, no subdomain or token, and no changes to your office router.
            </>
          ) : (
            <>
              Your Droplet has its own secure web address — it works across your office network,
              with a padlock and nothing to install. Away-from-office access arrives with the
              secure relay — coming soon. No dynamic DNS, no subdomain or token, and no changes
              to your office router.
            </>
          )}
        </p>
      </div>

      {address ? (
        <div className="grid c2">
          <Stat label="Web address" value={address} />
          <Stat
            label="Away from the office"
            value={
              offLanReachable
                ? "Turn on Connect in the app"
                : "Coming soon — secure relay"
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
            Your box is still setting up its web address. This appears automatically once it&rsquo;s
            ready — nothing to do here.
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
  publicFqdn,
  offLanReachable,
}: {
  onClose: () => void;
  onAdded: () => void;
  publicFqdn: string | null;
  /** WARP-993: gates the ready-step copy — no "from anywhere" promise while
   *  the endpoint only resolves on the home network. */
  offLanReachable: boolean;
}) {
  const [step, setStep] = useState<"form" | "ready">("form");
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
      // WARP-1391: mint HOME mode explicitly. The orchestrator route defaults to
      // "away" (a byte-identical pre-hybrid compat contract, PR #897) which bakes
      // the split-horizon public FQDN Endpoint — public-NXDOMAIN by design, so the
      // conf shows keepalive but zero handshakes. Home bakes the box LAN IP and
      // works today; the page gates this affordance on homeEndpointHost.
      const result = await createVpnPeer(trimmed, "home");
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
                className="w-full px-3 py-2.5 outline-none focus:border-[var(--brand)] placeholder:text-[var(--text-faint)] transition-colors"
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
                  {/* ADR-023: prefer the publicly-trusted per-device FQDN — the
                      one address that works at home AND over the tunnel with a
                      green padlock. Falls back to the box-side gateway IP from
                      the conf's DNS line (parsed + IPv4-validated in
                      lib/wireguard.ts) until the box learns its FQDN from HQ. */}
                  {dashboardUrlFromConf(created.conf, publicFqdn ?? undefined)}
                </strong>{" "}
                in the browser —{" "}
                {offLanReachable
                  ? "that’s your Droplet from anywhere."
                  : "that’s your Droplet on your office network."}
              </li>
            </ol>
            <p className="type-caption-1 text-label-tertiary">
              {offLanReachable ? (
                publicFqdn ? (
                  <>
                    This is the same address you use at the office — it works on
                    your Wi-Fi <em>and</em> over the tunnel, with a secure padlock
                    and nothing to install. (On this Droplet&rsquo;s own Wi-Fi the
                    tunnel can&rsquo;t loop back, and you don&rsquo;t need it
                    there.)
                  </>
                ) : (
                  <>
                    Test it away from the office (cellular works) — on this
                    Droplet&rsquo;s own Wi-Fi the tunnel can&rsquo;t loop back, and
                    you don&rsquo;t need it there. Names like{" "}
                    <span className="font-mono">droplet.local</span> only work on
                    the office network, not over the tunnel.
                  </>
                )
              ) : (
                <>
                  This works while you&rsquo;re on your office network.
                  Away-from-office access arrives with the secure relay — coming
                  soon; this device will be ready for it.
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
