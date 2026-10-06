"use client";

import { useRef, useState } from "react";
import useSWR from "swr";
import { AlertTriangle, Link2, Loader2 } from "lucide-react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useAuth } from "@/lib/auth";
import {
  fetchRouterPairing,
  pairRouter,
  persistRouterPairing,
  type RouterErrorCode,
  type RouterPairingView,
} from "@/lib/api";

/**
 * Router pairing card (ADR-071 slice B, WARP-3739).
 *
 * One component, three states, all driven by `GET /api/network/router/pairing`:
 *
 *  1. PAIR   — the router answers with a rejected credential (AUTH) and its
 *              pairing window is open: "Router … is ready to pair". Pair opens
 *              the standard write confirmation (ADR-014), then claims.
 *  2. ELSEWHERE — the router is enrolled to a different box. Nothing here can
 *              fix that: re-pairing needs the router's button, so the card only
 *              explains, with the first 16 hex of the other device's fingerprint.
 *  3. RETRY  — pairing worked and the router is live, but the password could not
 *              be written to disk. It lives in memory only and is lost on the
 *              next restart; Retry re-runs just the save.
 *
 * Reads run automatically; the two POSTs are owner/admin writes (the server
 * enforces it too). Anyone else sees the same explanation with no button.
 *
 * Renders nothing when routing has no pairing surface (`available: false`) or
 * none of the three states applies, so on an older routing build the page keeps
 * its existing "Credentials rejected" card exactly as before.
 *
 * `routerErrorCode` comes from the page's own status read (it already knows
 * AUTH vs PAIRED_ELSEWHERE); pass null from the healthy page, where only the
 * RETRY state can apply.
 */
export interface RouterPairingCardProps {
  routerErrorCode: RouterErrorCode | null;
  /** Called after a successful pair/retry so the page re-reads its own status. */
  onChanged?: () => void;
}

const SAVE_FAILED = "Paired, but the password could not be saved — it will be lost on the next restart.";

export function RouterPairingCard({ routerErrorCode, onChanged }: RouterPairingCardProps) {
  const { user } = useAuth();
  const canPair = user?.role === "owner" || user?.role === "admin";
  const { data, mutate } = useSWR<RouterPairingView>("/api/network/router/pairing", fetchRouterPairing, {
    refreshInterval: 10_000,
  });

  const [dismissed, setDismissed] = useState(false);
  // Set by a pair whose save failed; routing's own `pendingPersist` takes over on
  // the next poll, so this only bridges the gap and survives a poll that races.
  const [unsaved, setUnsaved] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pairButtonRef = useRef<HTMLButtonElement | null>(null);

  if (!data || !data.available) return null;

  async function onConfirmPair() {
    setError(null);
    let result;
    try {
      result = await pairRouter();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Couldn't pair the router.";
      setError(msg);
      throw e; // keeps the dialog open so the owner can retry or back out
    }
    if (!result.ok) {
      setError(result.error ?? "Couldn't pair the router.");
      throw new Error(result.error ?? "pairing refused");
    }
    if (!result.persisted) setUnsaved(true);
    await mutate();
    onChanged?.();
  }

  async function onRetry() {
    setRetrying(true);
    setError(null);
    try {
      const result = await persistRouterPairing();
      if (result.ok && result.persisted) {
        setUnsaved(false);
        await mutate();
        onChanged?.();
      } else {
        setError(result.error ?? SAVE_FAILED);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : SAVE_FAILED);
    } finally {
      setRetrying(false);
    }
  }

  const errorBox = error && (
    <div
      role="alert"
      className="mt-3 flex items-start gap-2 type-caption-1 text-system-red bg-system-red/10 rounded-sm px-3 py-2 text-left"
    >
      <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
      <span>{error}</span>
    </div>
  );

  // 3. RETRY — checked first: a live router with an unsaved password is the
  //    state with a deadline (the next restart).
  if (unsaved || data.pendingPersist) {
    return (
      <div className="card mb-4" role="alert" data-testid="router-pairing-retry">
        <div className="flex items-start gap-3">
          <AlertTriangle size={18} className="mt-0.5 flex-shrink-0 text-system-orange" aria-hidden="true" />
          <div className="flex-1 min-w-0">
            <h3 className="type-headline" style={{ color: "var(--text)" }}>
              {SAVE_FAILED}
            </h3>
            {canPair ? (
              <>
                <p className="type-caption-1 mt-0.5" style={{ color: "var(--text-muted)" }}>
                  The router is connected now. Save the password so it survives a restart.
                </p>
                <button
                  type="button"
                  className="btn primary sm mt-3"
                  onClick={onRetry}
                  disabled={retrying}
                >
                  {retrying ? (
                    <>
                      <Loader2 size={14} className="animate-spin" aria-hidden="true" /> Retrying…
                    </>
                  ) : (
                    "Retry"
                  )}
                </button>
              </>
            ) : (
              <p className="type-caption-1 mt-0.5" style={{ color: "var(--text-muted)" }}>
                Ask an owner or admin to retry saving it.
              </p>
            )}
            {errorBox}
          </div>
        </div>
      </div>
    );
  }

  // 2. PAIRED ELSEWHERE — explain; the fix is physical.
  if (data.pairedElsewhere || routerErrorCode === "PAIRED_ELSEWHERE") {
    const box = data.pairedBox ? `${data.pairedBox.slice(0, 16)}…` : null;
    return (
      <div className="mt-4" role="status" data-testid="router-pairing-elsewhere">
        <p className="type-subheadline max-w-md mx-auto" style={{ color: "var(--text-muted)" }}>
          This router is paired to another device
          {box ? (
            <>
              {" "}(fingerprint <span className="font-mono">{box}</span>)
            </>
          ) : null}
          . Press the router&apos;s button to re-pair.
        </p>
      </div>
    );
  }

  // 1. PAIR — AUTH + an open window.
  if (routerErrorCode === "AUTH" && data.state === "open" && !dismissed) {
    const where = data.host ? ` at ${data.host}` : "";
    const what = data.model ? `Router ${data.model}` : "Router";
    return (
      <div className="card mt-4 text-left" data-testid="router-pairing-offer">
        <div className="flex items-start gap-3">
          <Link2 size={18} className="mt-0.5 flex-shrink-0" style={{ color: "var(--text-muted)" }} aria-hidden="true" />
          <div className="flex-1 min-w-0">
            <h3 className="type-headline" style={{ color: "var(--text)" }}>
              {what}
              {where} is ready to pair.
            </h3>
            <p className="type-caption-1 mt-0.5" style={{ color: "var(--text-muted)" }}>
              Pairing gives this Droplet control of the router&apos;s network settings.
            </p>
            {canPair ? (
              <div className="flex gap-2 mt-3">
                <button
                  type="button"
                  ref={pairButtonRef}
                  className="btn primary sm"
                  onClick={() => setConfirming(true)}
                >
                  Pair
                </button>
                <button type="button" className="btn ghost sm" onClick={() => setDismissed(true)}>
                  Not now
                </button>
              </div>
            ) : (
              <p className="type-caption-1 mt-3" style={{ color: "var(--text-muted)" }}>
                An owner or admin can pair it from here.
              </p>
            )}
            {errorBox}
          </div>
        </div>
        <ConfirmDialog
          open={confirming}
          onCancel={() => setConfirming(false)}
          onConfirm={onConfirmPair}
          triggerRef={pairButtonRef}
          title="Pair this router?"
          description="Pairing gives this Droplet control of the router's network settings. The router's old password is replaced with one only this Droplet knows."
          confirmLabel="Pair"
          variant="neutral"
        />
      </div>
    );
  }

  return null;
}
