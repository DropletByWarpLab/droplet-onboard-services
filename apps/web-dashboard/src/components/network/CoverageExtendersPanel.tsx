"use client";
/**
 * WARP-446 — Coverage Extenders panel.
 *
 * Renders the household's list of extender APs above the Devices grid
 * on /network. The full data fetch is `fetchApDevices`; per-row
 * approve drives through `approveApDevice` (which now returns the
 * routing-service operationId so the panel can poll
 * `/api/network/operations/:id` until the safe_apply lands).
 *
 * Design discipline (ADR-002 progressive disclosure):
 *   - Empty state → friendly explainer + "Add extender" CTA opens the
 *     dialog with helper copy.
 *   - AWAITING_APPROVAL → highlighted card at top, one-tap approve.
 *   - ONLINE → standard card, model + last-seen + decommission.
 *   - DECOMMISSIONED → collapsed at bottom; operator can still see
 *     historical context for the "what was that AP?" question.
 *   - FAILED → red-tinted card with mapped home-user copy + retry hint.
 *
 * Motion: restraint-first (Emil Kowalski lens). No celebration on
 * approve-success; transition is the SWR refresh + the new status pill
 * rendering. The optimistic spinner runs only while the safe_apply op
 * is pending. Dialog + ConfirmDialog primitives carry framer-motion
 * with `useReducedMotion` honored.
 *
 * Design tokens — every status pill / button / banner uses a semantic
 * token: the system-* state ramp from app/globals.css (text-system-*,
 * bg-system-*) plus the indigo shell primitives and vars from
 * components/shell (.card, .btn, var(--text), var(--card-bd), type-*).
 * NO raw Tailwind palette classes — those drift away from the dashboard's
 * typography and color tokens and break the home-user persona.
 *
 * Blockers resolved (WARP-446 post-QA):
 *   #2  Operation-Id polling on approve + decommission.
 *   #3  Replace window.prompt with <Dialog> wizard (PSK input).
 *   #4  Replace window.confirm with <ConfirmDialog> (destructive).
 *   #5  Semantic design tokens everywhere; no raw amber/sky/etc.
 *   #6  a11y primitives: role="alert" / role="status" / aria-live;
 *       focus-visible rings; 36px min-h on action buttons.
 *   #7  AP_ONBOARD_ERROR_COPY keys home-user copy off the typed
 *       ApOnboardErrorCode that the orchestrator now ships.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import useSWR, { mutate } from "swr";
import {
  Wifi,
  WifiOff,
  Loader2,
  Plus,
  AlertTriangle,
  Info,
  Clock,
  Trash2,
  ArrowUpRight,
  Eye,
  EyeOff,
  X,
} from "lucide-react";
import {
  fetchApDevices,
  approveApDevice,
  decommissionApDevice,
  fetchNetworkOperation,
} from "@/lib/api";
import type { ApDeviceInfo, ApDeviceStatus, ApOnboardBackend } from "@/lib/types";
import { Dialog } from "@/components/Dialog";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { translateError } from "@/lib/friendly-errors";

// ────────────────────────────────────────────────────────────────────
// Status display metadata. Centralised so the panel and any future
// inline reference stay in lockstep without scattering literal colours.
// Every pill class maps to a semantic system-* token from globals.css
// (blocker #5) so the dashboard's color story holds even when the
// theme is re-themed.
// ────────────────────────────────────────────────────────────────────
const STATUS_META: Record<
  ApDeviceStatus,
  { label: string; pillClass: string; icon: typeof Wifi }
> = {
  DISCOVERED: {
    label: "Discovered",
    pillClass: "bg-[var(--card-inner)] text-[color:var(--text-muted)]",
    icon: Clock,
  },
  AWAITING_APPROVAL: {
    label: "Awaiting approval",
    pillClass: "bg-system-orange/10 text-system-orange",
    icon: AlertTriangle,
  },
  PROVISIONING: {
    label: "Setting up…",
    pillClass: "bg-system-blue/10 text-system-blue",
    icon: Loader2,
  },
  ONLINE: {
    label: "Online",
    pillClass: "bg-system-green/10 text-system-green",
    icon: Wifi,
  },
  FAILED: {
    label: "Failed",
    pillClass: "bg-system-red/10 text-system-red",
    icon: AlertTriangle,
  },
  DECOMMISSIONED: {
    label: "Removed",
    pillClass: "bg-[var(--card-inner)] text-[color:var(--text-muted)]",
    icon: WifiOff,
  },
};

// Sort order: action-required → active → historical. Within each
// bucket, most-recently-seen first.
const STATUS_RANK: Record<ApDeviceStatus, number> = {
  AWAITING_APPROVAL: 0,
  DISCOVERED: 0, // poller will collapse to AWAITING_APPROVAL same tick
  PROVISIONING: 1,
  ONLINE: 2,
  FAILED: 3,
  DECOMMISSIONED: 4,
};

// ────────────────────────────────────────────────────────────────────
// ADR-024 §4 — vendor labelling. The household sees ONE list regardless
// of which ecosystem an extender belongs to; the only new affordance is
// a small text badge naming the vendor. We prefer the explicit `vendor`
// string the backend reports ("TP-Link", "Ubiquiti"); when it's null we
// derive a plain-language label from the `backend` discriminator so the
// badge is never blank (and never color-only — a11y).
// ────────────────────────────────────────────────────────────────────
const BACKEND_VENDOR_LABEL: Record<ApOnboardBackend, string> = {
  DROPLET_IMAGE: "Droplet",
  EASYMESH: "EasyMesh",
  UNIFI: "Ubiquiti",
};

function vendorLabelFor(ap: ApDeviceInfo): string {
  const reported = ap.vendor?.trim();
  if (reported) return reported;
  return BACKEND_VENDOR_LABEL[ap.backend] ?? "Droplet";
}

// ────────────────────────────────────────────────────────────────────
// Home-user error copy keyed off ApOnboardErrorCode (blocker #7).
// Mirrors the ROUTER_ERROR_COPY pattern on /network. The fall-through
// is UNKNOWN, never the raw error message — that keeps technical
// strings ("ETIMEDOUT", "ubus error 4") off the home-user surface.
// ────────────────────────────────────────────────────────────────────
const AP_ONBOARD_ERROR_COPY: Record<
  string,
  { title: string; body: string }
> = {
  PROVISIONING_TIMEOUT: {
    title: "Setting up took too long",
    body: "The extender didn't finish connecting in time. It might be too far from the main router — try moving it closer and approving again.",
  },
  ROUTER_UNREACHABLE: {
    title: "Couldn't reach the main router",
    body: "The router didn't respond. Make sure the Droplet is online and try again in a moment.",
  },
  WIRELESS_CONFIG_REJECTED: {
    title: "WiFi settings were rejected",
    body: "The extender refused the WiFi setup. Double-check the password and try again.",
  },
  AP_NOT_FOUND: {
    title: "Extender not found",
    body: "We can't see this extender anymore. Make sure it's powered on and plugged into the network.",
  },
  UNKNOWN: {
    title: "Something went wrong",
    body: "Setting up this extender didn't work. Please try again — if it keeps failing, contact support.",
  },
};

function copyForError(
  err: unknown,
  fallback?: string,
): { title: string; body: string } {
  const code =
    err && typeof err === "object" && "code" in err
      ? String((err as { code?: unknown }).code ?? "")
      : "";
  if (code && AP_ONBOARD_ERROR_COPY[code]) {
    return AP_ONBOARD_ERROR_COPY[code];
  }
  return {
    title: AP_ONBOARD_ERROR_COPY.UNKNOWN.title,
    body: fallback || AP_ONBOARD_ERROR_COPY.UNKNOWN.body,
  };
}

function copyForFailureReason(failureReason: string | null): {
  title: string;
  body: string;
} {
  if (!failureReason) return AP_ONBOARD_ERROR_COPY.UNKNOWN;
  // Heuristic: the orchestrator's RouterError messages are mapped to
  // ApOnboardErrorCode at the route layer (see ap-onboard.service.ts
  // ApOnboardError.routerError). The DB column stores the raw routing
  // message, so we fall back to keyword sniffing here for the row's
  // historical failureReason. Fresh actions use the more reliable
  // `err.code` path via `copyForError`.
  const haystack = failureReason.toLowerCase();
  if (haystack.includes("timeout") || haystack.includes("timed out")) {
    return AP_ONBOARD_ERROR_COPY.PROVISIONING_TIMEOUT;
  }
  if (
    haystack.includes("unreachable") ||
    haystack.includes("connection refused") ||
    haystack.includes("network")
  ) {
    return AP_ONBOARD_ERROR_COPY.ROUTER_UNREACHABLE;
  }
  if (
    haystack.includes("rejected") ||
    haystack.includes("invalid") ||
    haystack.includes("wireless")
  ) {
    return AP_ONBOARD_ERROR_COPY.WIRELESS_CONFIG_REJECTED;
  }
  return AP_ONBOARD_ERROR_COPY.UNKNOWN;
}

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.max(0, Math.floor(diffMs / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function displayNameFor(ap: ApDeviceInfo): string {
  if (ap.displayName) return ap.displayName;
  const last3 = ap.mac.split(":").slice(-3).join(":");
  // The device-tree compatible string `raspberrypi,5-model-b` is the literal
  // value Pi-based APs emit on /proc/device-tree/compatible — matched here for
  // detection (do NOT rename it), but the operator-facing label stays
  // hardware-agnostic (ADR-011).
  if (ap.model?.includes("raspberrypi,5")) return `AP (${last3})`;
  if (ap.model) return `${ap.model} AP (${last3})`;
  return `Extender (${last3})`;
}

// ────────────────────────────────────────────────────────────────────
// Operation polling: same shape as /network's WARP-40 opStatus
// machine. After approve / decommission returns, capture the
// operationId, poll /api/network/operations/:id at 1s cadence until
// applied or rolled_back (cap at 70s), then refresh /api/aps.
// ────────────────────────────────────────────────────────────────────
type OperationStatus =
  | { state: "idle" }
  | { state: "pending"; id: string; mac: string; verb: "approve" | "remove" }
  | { state: "applied"; id: string; mac: string }
  // Neutral no-change terminal (routing 4xx): the request was refused before any
  // router change. Distinct from rolled_back (a change made then reverted).
  | { state: "rejected"; id: string; mac: string; reason: string | null }
  | { state: "rolled_back"; id: string; mac: string; reason: string | null };

interface ApCardProps {
  ap: ApDeviceInfo;
  onApprove: (ap: ApDeviceInfo, triggerEl: HTMLElement | null) => void;
  onRequestRemove: (ap: ApDeviceInfo, triggerEl: HTMLElement | null) => void;
  busy: boolean;
}

function ApCard({ ap, onApprove, onRequestRemove, busy }: ApCardProps) {
  const meta = STATUS_META[ap.status];
  const Icon = meta.icon;
  const isSpinning =
    ap.status === "PROVISIONING" || (busy && ap.status !== "DECOMMISSIONED");
  const showApprove =
    ap.status === "AWAITING_APPROVAL" || ap.status === "DISCOVERED";
  const showRemove = ap.status === "ONLINE" || ap.status === "FAILED";
  const isFailed = ap.status === "FAILED";

  const ringClass = showApprove
    ? "ring-1 ring-system-orange/30"
    : isFailed
    ? "ring-1 ring-system-red/30"
    : "";

  const friendlyError = isFailed
    ? copyForFailureReason(ap.failureReason)
    : null;

  return (
    <div className={`card flex flex-col gap-3 ${ringClass}`}>
      <div className="flex items-start gap-3">
        <div className="rounded-full bg-[var(--card-inner)] p-2 text-[color:var(--text-muted)]">
          <Icon
            size={18}
            className={isSpinning ? "animate-spin" : ""}
            aria-hidden
          />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="type-card-title text-[color:var(--text)] font-medium truncate">
              {displayNameFor(ap)}
            </span>
            <span
              className={`text-xs px-2 py-0.5 rounded-full font-medium ${meta.pillClass}`}
            >
              {meta.label}
            </span>
            {/* ADR-024 §4: quiet, text-only vendor badge. Neutral
                (muted ink + hairline border) so it reads as metadata
                and never competes with the semantic status pill — and so
                it carries meaning by text, not color (a11y). */}
            <span className="text-xs px-2 py-0.5 rounded-full font-medium border border-[var(--card-bd)] text-[color:var(--text-muted)]">
              {vendorLabelFor(ap)}
            </span>
          </div>
          <div className="type-footnote text-[color:var(--text-muted)] mt-0.5">
            {ap.model ? `${ap.model} · ` : ""}
            Last seen {timeAgo(ap.lastSeen)}
            {ap.lastIp ? ` · ${ap.lastIp}` : ""}
          </div>
          {friendlyError ? (
            <div className="type-footnote text-system-red mt-2">
              <span className="font-medium">{friendlyError.title}.</span>{" "}
              {friendlyError.body}
            </div>
          ) : null}
        </div>
      </div>
      {(showApprove || showRemove) && (
        <div className="flex gap-2 self-end">
          {showApprove && (
            <button
              type="button"
              disabled={busy}
              onClick={(e) =>
                onApprove(ap, e.currentTarget as HTMLElement)
              }
              className="btn primary !min-h-[36px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
              aria-label={`Approve ${displayNameFor(ap)}`}
            >
              {busy ? (
                <>
                  <Loader2 size={14} className="animate-spin" aria-hidden />
                  Approving&hellip;
                </>
              ) : (
                "Approve"
              )}
            </button>
          )}
          {showRemove && (
            <button
              type="button"
              disabled={busy}
              onClick={(e) =>
                onRequestRemove(ap, e.currentTarget as HTMLElement)
              }
              className="btn ghost !min-h-[36px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
              aria-label={`Remove ${displayNameFor(ap)}`}
            >
              <Trash2 size={14} aria-hidden /> Remove
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function CoverageExtendersPanel() {
  // 10s refresh — same cadence as the orchestrator's discovery poller
  // (DROPLET_AP_DISCOVERY_INTERVAL=10). New extender announces become
  // visible within one polling cycle on each side. Operation-Id
  // polling (below) refreshes more aggressively for the in-flight
  // write so the user doesn't have to wait the full 10s for the new
  // status to land.
  const { data, error, isLoading } = useSWR(
    "/api/aps",
    () => fetchApDevices(),
    { refreshInterval: 10_000 },
  );

  const [busyMac, setBusyMac] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [errorCopy, setErrorCopy] = useState<
    { title: string; body: string } | null
  >(null);
  const [opStatus, setOpStatus] = useState<OperationStatus>({ state: "idle" });

  // Approve-dialog state. Captures the target AP plus the trigger
  // element so focus restores correctly when the dialog closes.
  const [approveTarget, setApproveTarget] = useState<ApDeviceInfo | null>(null);
  const [approveDialogOpen, setApproveDialogOpen] = useState(false);
  const approveTriggerRef = useRef<HTMLElement | null>(null);

  // Remove-confirm state — same triggerRef pattern.
  const [removeTarget, setRemoveTarget] = useState<ApDeviceInfo | null>(null);
  const removeTriggerRef = useRef<HTMLElement | null>(null);

  // Header "+ Add extender" button — focus-restore target when the
  // dialog is opened from the header / empty state.
  const addHeaderRef = useRef<HTMLButtonElement | null>(null);

  const aps = useMemo(() => {
    const list = data?.aps ?? [];
    return [...list].sort((a, b) => {
      const rank = STATUS_RANK[a.status] - STATUS_RANK[b.status];
      if (rank !== 0) return rank;
      return new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime();
    });
  }, [data]);

  // ──────────────────────────────────────────────────────────────
  // Operation-Id polling (blocker #2). Lifted directly from
  // /network/page.tsx's WARP-40 opStatus machine so behaviour stays
  // consistent across the network surface. Cap at 70s (safe_apply
  // 60s + slack) so a lost operation doesn't keep the banner
  // spinning forever; treat the timeout as rolled_back.
  // ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (opStatus.state !== "pending") return;
    const startedAt = Date.now();
    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;
      try {
        const op = await fetchNetworkOperation(opStatus.id);
        if (cancelled) return;
        if (op.state === "applied") {
          setOpStatus({
            state: "applied",
            id: op.id,
            mac: opStatus.mac,
          });
          await mutate("/api/aps");
        } else if (op.state === "rejected") {
          // Neutral no-change terminal — the router refused the request (4xx),
          // nothing was applied or reverted. Don't present the rollback alarm.
          setOpStatus({
            state: "rejected",
            id: op.id,
            mac: opStatus.mac,
            reason: op.reason,
          });
          await mutate("/api/aps");
        } else if (op.state === "rolled_back") {
          setOpStatus({
            state: "rolled_back",
            id: op.id,
            mac: opStatus.mac,
            reason: op.reason,
          });
          await mutate("/api/aps");
        } else if (op.state === "unknown") {
          // DASH-07: 404 from the orchestrator — indeterminate, not a success.
          // Present as unconfirmed (rolled_back banner) and re-check the AP
          // list rather than reporting the change as applied.
          setOpStatus({
            state: "rolled_back",
            id: op.id,
            mac: opStatus.mac,
            reason: op.reason ?? "We couldn't confirm this change — re-check the device list.",
          });
          await mutate("/api/aps");
        } else if (Date.now() - startedAt > 70_000) {
          setOpStatus({
            state: "rolled_back",
            id: opStatus.id,
            mac: opStatus.mac,
            reason: "Timed out waiting for the router",
          });
        }
      } catch {
        if (!cancelled) {
          setOpStatus({
            state: "rolled_back",
            id: opStatus.id,
            mac: opStatus.mac,
            reason: "Could not reach the router",
          });
        }
      }
    };
    tick();
    const interval = setInterval(tick, 1_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [opStatus]);

  async function handleApproveSubmit(
    ap: ApDeviceInfo,
    psk: string,
    ssid: string,
  ): Promise<void> {
    setErrorMsg(null);
    setErrorCopy(null);
    setBusyMac(ap.mac);
    try {
      const { operationId } = await approveApDevice(ap.mac, {
        ssid,
        encryptionKey: psk,
      });
      await mutate("/api/aps");
      if (operationId) {
        setOpStatus({
          state: "pending",
          id: operationId,
          mac: ap.mac,
          verb: "approve",
        });
      }
      setApproveDialogOpen(false);
      setApproveTarget(null);
    } catch (err) {
      const copy = copyForError(err, translateError(err, "network"));
      setErrorCopy(copy);
      setErrorMsg(`${copy.title}. ${copy.body}`);
      throw err; // keep dialog open so user can retry
    } finally {
      setBusyMac(null);
    }
  }

  async function handleRemoveConfirm(ap: ApDeviceInfo): Promise<void> {
    setErrorMsg(null);
    setErrorCopy(null);
    setBusyMac(ap.mac);
    try {
      const { operationId } = await decommissionApDevice(ap.mac);
      await mutate("/api/aps");
      if (operationId) {
        setOpStatus({
          state: "pending",
          id: operationId,
          mac: ap.mac,
          verb: "remove",
        });
      }
    } catch (err) {
      const copy = copyForError(err, translateError(err, "network"));
      setErrorCopy(copy);
      setErrorMsg(`${copy.title}. ${copy.body}`);
      throw err;
    } finally {
      setBusyMac(null);
    }
  }

  // Header / empty-state "+ Add extender" dispatch. If there's a
  // single AWAITING_APPROVAL row, pre-fill the dialog for it. If
  // there are several, pre-fill the most-recent one. If there are
  // none yet, open the dialog with a helpful empty-state explainer.
  function handleAddExtenderClick() {
    const awaiting = aps.find(
      (a) => a.status === "AWAITING_APPROVAL" || a.status === "DISCOVERED",
    );
    approveTriggerRef.current = addHeaderRef.current;
    setApproveTarget(awaiting ?? null);
    setApproveDialogOpen(true);
  }

  return (
    <section className="card">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h2 className="type-headline text-[color:var(--text)]">
            Coverage extenders
          </h2>
          <p className="type-footnote text-[color:var(--text-muted)] mt-0.5">
            Extra Wi-Fi access points around your home.
          </p>
        </div>
        <button
          ref={addHeaderRef}
          type="button"
          onClick={handleAddExtenderClick}
          className="btn ghost !min-h-[36px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
        >
          <Plus size={14} aria-hidden /> Add extender
        </button>
      </div>

      {errorMsg ? (
        <div
          role="alert"
          className="mb-3 text-sm text-system-red bg-system-red/10 rounded-md px-3 py-2 flex items-start gap-2"
        >
          <AlertTriangle size={14} aria-hidden className="mt-0.5 shrink-0" />
          <span>
            {errorCopy ? (
              <>
                <strong>{errorCopy.title}.</strong> {errorCopy.body}
              </>
            ) : (
              errorMsg
            )}
          </span>
        </div>
      ) : null}

      {/* WARP-446 (blocker #2): operation-Id banner mirrors /network's
          WARP-40 opStatus pattern so the apply/rollback feedback feels
          consistent across the network surface. */}
      {opStatus.state === "pending" && (
        <div
          role="status"
          className="mb-3 rounded-lg shadow border border-system-blue/30 bg-system-blue/5 flex items-center gap-3 px-3 py-2"
        >
          <Loader2 size={16} className="animate-spin text-system-blue" />
          <p className="type-subheadline text-[color:var(--text)] flex-1">
            Finishing setup… the router is applying the new configuration.
          </p>
        </div>
      )}
      {opStatus.state === "rejected" && (
        <div
          role="status"
          className="mb-3 rounded-lg shadow border border-[var(--card-bd)] bg-[var(--inset)] flex items-center gap-3 px-3 py-2"
        >
          <Info size={16} className="text-[color:var(--text-muted)]" />
          <div className="flex-1">
            <p className="type-subheadline text-[color:var(--text)] font-medium">
              No change made
            </p>
            <p className="type-footnote text-[color:var(--text-muted)]">
              {opStatus.reason ??
                "The router rejected the request, so nothing was changed."}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setOpStatus({ state: "idle" })}
            className="btn ghost !min-h-[36px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
            aria-label="Dismiss"
          >
            Dismiss
          </button>
        </div>
      )}
      {opStatus.state === "rolled_back" && (
        <div
          role="alert"
          className="mb-3 rounded-lg shadow border border-system-red/30 bg-system-red/5 flex items-center gap-3 px-3 py-2"
        >
          <AlertTriangle size={16} className="text-system-red" />
          <div className="flex-1">
            <p className="type-subheadline text-[color:var(--text)] font-medium">
              The change was rolled back
            </p>
            <p className="type-footnote text-[color:var(--text-muted)]">
              {opStatus.reason ??
                "The router reverted to the previous configuration."}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setOpStatus({ state: "idle" })}
            className="btn ghost !min-h-[36px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
            aria-label="Dismiss"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* ADR-005 LRU cap surfacing — when the discovered-list hits the
          25-entry cap (usually only under an mDNS-spoof flood), tell
          the operator their list is bounded so a missing extender
          doesn't look like a discovery bug. */}
      {data?.discoveredCapReached && (
        <div
          role="status"
          className="mb-3 rounded-lg shadow border border-system-orange/30 bg-system-orange/5 flex items-start gap-3 px-3 py-2"
        >
          <AlertTriangle size={16} className="text-system-orange mt-0.5 shrink-0" />
          <p className="type-footnote text-[color:var(--text-muted)] flex-1">
            Showing the {data.discoveredCap} most recently detected access
            points. If yours isn&apos;t listed, unplug it for a moment and
            plug it back in to refresh the list.
          </p>
        </div>
      )}

      {isLoading && !data ? (
        <div
          role="status"
          className="flex items-center gap-2 text-[color:var(--text-muted)] text-sm py-6"
        >
          <Loader2 size={16} className="animate-spin" aria-hidden /> Loading
          extenders…
        </div>
      ) : error ? (
        <div role="alert" className="text-sm text-system-red py-4">
          Couldn&apos;t load extenders right now. We&apos;ll keep retrying.
        </div>
      ) : aps.length === 0 ? (
        <EmptyState onAdd={handleAddExtenderClick} />
      ) : (
        <div
          className="flex flex-col gap-3"
          aria-live="polite"
          aria-label="Coverage extenders"
        >
          {aps.map((ap) => (
            <ApCard
              key={ap.mac}
              ap={ap}
              onApprove={(target, triggerEl) => {
                approveTriggerRef.current = triggerEl;
                setApproveTarget(target);
                setApproveDialogOpen(true);
              }}
              onRequestRemove={(target, triggerEl) => {
                removeTriggerRef.current = triggerEl;
                setRemoveTarget(target);
              }}
              busy={busyMac === ap.mac}
            />
          ))}
        </div>
      )}

      {/* WARP-446 (blocker #3): masked-PSK dialog that replaced the old
          native browser prompt. Read-only network name + show/hide eyeball
          + inline 8–63-char validation. */}
      <ApproveExtenderDialog
        open={approveDialogOpen}
        target={approveTarget}
        triggerRef={approveTriggerRef}
        onClose={() => {
          setApproveDialogOpen(false);
          setApproveTarget(null);
        }}
        onSubmit={handleApproveSubmit}
      />

      {/* WARP-446 (blocker #4): ConfirmDialog replaces window.confirm().
          Destructive variant + home-user copy. */}
      <ConfirmDialog
        open={removeTarget !== null}
        triggerRef={removeTriggerRef}
        title="Remove this extender?"
        description="Devices connected through it will need to reconnect to the main router. This can take up to 30 seconds."
        confirmLabel="Remove"
        cancelLabel="Keep it"
        variant="destructive"
        confirmedIdentifier={
          removeTarget ? displayNameFor(removeTarget) : undefined
        }
        onConfirm={async () => {
          if (removeTarget) {
            await handleRemoveConfirm(removeTarget);
          }
        }}
        onCancel={() => setRemoveTarget(null)}
      />
    </section>
  );
}

// ────────────────────────────────────────────────────────────────────
// EmptyState: friendly explainer + the same "+ Add extender" affordance
// the header uses (blocker #3). Clicking it opens the dialog, which
// will fall through to the "no extender detected yet" helper since
// `aps` is empty.
// ────────────────────────────────────────────────────────────────────
function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex flex-col items-center text-center py-8 px-4">
      <div className="rounded-full bg-[var(--card-inner)] p-3 text-[color:var(--text-faint)] mb-3">
        <Wifi size={28} aria-hidden />
      </div>
      <p className="type-subheadline text-[color:var(--text-muted)] font-medium mb-1">
        No extra access points yet
      </p>
      <p className="type-footnote text-[color:var(--text-muted)] max-w-md">
        Plug a compatible access point into the same network and it will appear
        here for one-tap approval — a Droplet extender, an EasyMesh access point
        (such as TP-Link), or a Ubiquiti unit. New extenders show up within 30
        seconds.
      </p>
      <div className="flex items-center gap-3 mt-4">
        <button
          type="button"
          onClick={onAdd}
          className="btn primary !min-h-[36px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
        >
          <Plus size={14} aria-hidden /> Add extender
        </button>
        <a
          href="/help#extenders"
          className="type-footnote text-[color:var(--text-muted)] hover:text-[color:var(--text)] inline-flex items-center gap-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] rounded-sm"
        >
          Learn more <ArrowUpRight size={12} aria-hidden />
        </a>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// ApproveExtenderDialog — the WARP-446 blocker #3 replacement for the
// old window.prompt() flow. Built on the shared <Dialog> primitive
// (WARP-289) so it inherits ARIA + focus trap + scroll-lock for free.
// Shape mirrors AddDeviceDialog at remote-access/page.tsx:465.
// ────────────────────────────────────────────────────────────────────
function ApproveExtenderDialog({
  open,
  target,
  triggerRef,
  onClose,
  onSubmit,
}: {
  open: boolean;
  target: ApDeviceInfo | null;
  triggerRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  onSubmit: (ap: ApDeviceInfo, psk: string, ssid: string) => Promise<void>;
}) {
  // Default SSID for v1: "Droplet-AI" matches the main router's SSID
  // baked in by the OpenWrt overlay (`droplethome2026` PSK is what
  // the operator types here). Pre-filling avoids the "what should I
  // type in the network name?" confusion for non-technical operators.
  const DEFAULT_SSID = "Droplet-AI";
  const [psk, setPsk] = useState("");
  const [showPsk, setShowPsk] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Stable id for aria-describedby on the PSK input so we don't churn
  // the dialog ref tree between renders.
  const formatHintId = "ap-approve-psk-hint";
  const headingId = "ap-approve-heading";

  // Reset state every time we open with a fresh target.
  useEffect(() => {
    if (open) {
      setPsk("");
      setShowPsk(false);
      setLocalError(null);
      setSubmitting(false);
    }
  }, [open, target?.mac]);

  // Empty-state variant: the operator clicked "+ Add extender" but
  // no AP is awaiting approval yet. Show a friendly helper instead
  // of a PSK form that can't submit.
  const isEmptyMode = open && target === null;

  const handleSubmit = async () => {
    if (!target) return;
    const trimmed = psk;
    if (trimmed.length < 8 || trimmed.length > 63) {
      setLocalError("WiFi password must be 8 to 63 characters.");
      return;
    }
    setSubmitting(true);
    setLocalError(null);
    try {
      await onSubmit(target, trimmed, DEFAULT_SSID);
      // onSubmit handles closing on success via setApproveDialogOpen(false).
    } catch (err) {
      // The parent surfaces the friendly error in the panel banner;
      // here we keep the dialog open AND show the error inline so the
      // user can re-type the password without losing context.
      setLocalError(translateError(err, "network"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      triggerRef={triggerRef}
      labelledBy={headingId}
      describedBy={formatHintId}
      maxWidth="md"
      initialFocusRef={inputRef}
      // Sectioned layout (full-width header divider) — sections own their
      // padding (WARP-1153).
      flush
    >
      <div>
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--card-bd)]">
          <h3 id={headingId} className="type-headline text-[color:var(--text)]">
            Add an extender
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-[color:var(--text-muted)] hover:text-[color:var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] rounded-sm"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        {isEmptyMode ? (
          <div className="p-5 space-y-4">
            <div className="rounded-md bg-system-blue/10 px-3 py-3 type-footnote text-[color:var(--text-muted)]">
              <p className="font-medium text-[color:var(--text)] mb-1">
                No extenders detected yet
              </p>
              <p>
                Plug a compatible access point into the same network — a Droplet
                extender, an EasyMesh access point, or a Ubiquiti unit — then
                come back in 30 seconds. We&apos;ll show it here for one-tap
                approval.
              </p>
            </div>
            <div className="flex items-center justify-end">
              <button
                type="button"
                onClick={onClose}
                className="btn primary !min-h-[36px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
              >
                Got it
              </button>
            </div>
          </div>
        ) : target ? (
          <div className="p-5 space-y-4">
            <div>
              <p className="type-footnote text-[color:var(--text-muted)] mb-1">
                Approving
              </p>
              <p className="type-subheadline text-[color:var(--text)] font-medium">
                {displayNameFor(target)}
              </p>
              {target.model ? (
                <p className="type-footnote text-[color:var(--text-muted)]">
                  {target.model}
                </p>
              ) : null}
            </div>

            <div>
              <label className="type-caption-1 text-[color:var(--text-muted)] mb-1.5 block">
                Network
              </label>
              <div
                className="w-full px-3 py-2.5 cursor-not-allowed select-text"
                style={{
                  background: "var(--surface-2)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-input)",
                  color: "var(--text-muted)",
                }}
                aria-readonly="true"
              >
                {DEFAULT_SSID}
              </div>
              <p className="type-caption-2 text-[color:var(--text-faint)] mt-1.5">
                The extender will join the same network as your main router.
              </p>
            </div>

            <div>
              <label
                htmlFor="ap-approve-psk"
                className="type-caption-1 text-[color:var(--text-muted)] mb-1.5 block"
              >
                WiFi password
              </label>
              <div className="relative">
                <input
                  id="ap-approve-psk"
                  ref={inputRef}
                  type={showPsk ? "text" : "password"}
                  autoComplete="off"
                  value={psk}
                  onChange={(e) => {
                    setPsk(e.target.value);
                    if (localError) setLocalError(null);
                  }}
                  placeholder="At least 8 characters"
                  className="w-full px-3 py-2.5 outline-none focus:border-[var(--brand)] placeholder:text-[var(--text-faint)] transition-colors pr-10"
                  style={{
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius-input)",
                    color: "var(--text)",
                  }}
                  minLength={8}
                  maxLength={63}
                  aria-describedby={formatHintId}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !submitting) {
                      e.preventDefault();
                      void handleSubmit();
                    }
                  }}
                />
                <button
                  type="button"
                  onClick={() => setShowPsk((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-[color:var(--text-muted)] hover:text-[color:var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] rounded-sm"
                  aria-label={showPsk ? "Hide password" : "Show password"}
                  aria-pressed={showPsk}
                >
                  {showPsk ? (
                    <EyeOff size={16} aria-hidden />
                  ) : (
                    <Eye size={16} aria-hidden />
                  )}
                </button>
              </div>
              <p
                id={formatHintId}
                className="type-caption-2 text-[color:var(--text-faint)] mt-1.5"
              >
                Same WiFi password you use to join the network on your phone.
              </p>
            </div>

            {localError ? (
              <div
                role="alert"
                className="rounded-md bg-system-red/10 px-3 py-2 type-footnote text-system-red flex items-start gap-2"
              >
                <AlertTriangle
                  size={14}
                  className="mt-0.5 shrink-0"
                  aria-hidden
                />
                <span>{localError}</span>
              </div>
            ) : null}

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={onClose}
                disabled={submitting}
                className="btn ghost !min-h-[36px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleSubmit()}
                disabled={submitting}
                className="btn primary !min-h-[36px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
                aria-busy={submitting || undefined}
              >
                {submitting ? (
                  <>
                    <Loader2 size={14} className="animate-spin" aria-hidden />
                    Setting up&hellip;
                  </>
                ) : (
                  "Approve"
                )}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

// Re-export the meta so a future Add Extender wizard component can
// share status pill styling without re-deriving it.
export { STATUS_META, AP_ONBOARD_ERROR_COPY };
