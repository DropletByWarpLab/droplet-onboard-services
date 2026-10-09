"use client";

import { useRef, useState, type ReactNode } from "react";
import useSWR from "swr";
import { AlertTriangle, Link2, Loader2 } from "lucide-react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useAuth } from "@/lib/auth";
import {
  fetchApPairing,
  fetchRouterPairing,
  fetchSwitchPairing,
  pairAp,
  pairRouter,
  pairSwitch,
  persistApPairing,
  persistRouterPairing,
  persistSwitchPairing,
  type DevicePairResult,
  type DevicePairingRole,
  type DevicePairingView,
  type RouterErrorCode,
} from "@/lib/api";

/**
 * Device pairing card (ADR-071 slices B + C, WARP-3739): the router, the managed
 * switch and each access point share it, with the device role substituted into
 * the ADR §2.2 copy.
 *
 * One component, three states, all driven by that device's own pairing read
 * (`GET /api/network/{router|switch|aps/:mac}/pairing`):
 *
 *  1. PAIR   — the device refused our credential (AUTH) and its pairing window is
 *              open: "<Device> … is ready to pair". Pair opens the standard write
 *              confirmation (ADR-014), then claims. An access point has no
 *              standing credential state to read, so its window being open IS the
 *              offer (the AP list shows it next to Approve).
 *  2. ELSEWHERE — the device is enrolled to a different box. Nothing here can fix
 *              that: re-pairing needs the device's button, so the card only
 *              explains, with the first 16 hex of the other box's fingerprint.
 *  3. RETRY  — pairing worked and the device is live, but the password could not
 *              be written to disk. It lives in memory only and is lost on the
 *              next restart; Retry re-runs just the save.
 *
 * Reads run automatically; the two POSTs are owner/admin writes (the server
 * enforces it too). Anyone else sees the same explanation with no button.
 *
 * Renders nothing when the owning service has no pairing surface
 * (`available: false`) or none of the three states applies, so on an older build
 * the page keeps its existing "Credentials rejected" copy exactly as before.
 *
 * `errorCode`: a page that already reads the device's status passes it (the
 * router's Network page does: it knows AUTH vs PAIRED_ELSEWHERE from the same
 * call that failed; null from the healthy page, where only RETRY can apply).
 * Omit it and the card uses the code on its own pairing read, which is what the
 * switch panel and the AP list do.
 */
export interface DevicePairingCardProps {
  role: DevicePairingRole;
  /** An access point's MAC (required for role "ap"). */
  mac?: string;
  /** See above. `undefined` = use the card's own read; `null` = healthy. */
  errorCode?: RouterErrorCode | null;
  /** Model to name when the pairing read has none (an AP's list row knows it). */
  model?: string | null;
  /** "inline" drops the card chrome, for placing it inside an existing card. */
  variant?: "card" | "inline";
  /** Called after a successful pair/retry so the page re-reads its own status. */
  onChanged?: () => void;
}

const SAVE_FAILED =
  "Paired, but the password could not be saved — it will be lost on the next restart.";

const NOUN: Record<DevicePairingRole, string> = {
  router: "router",
  switch: "switch",
  ap: "access point",
};

/** Outer spacing for the card variant, kept off the .card itself (module-level so
 *  its identity is stable across renders and the children keep their state). */
function Spaced({
  variant,
  spacing,
  children,
}: {
  variant: "card" | "inline";
  spacing: string;
  children: ReactNode;
}) {
  return variant === "card" ? <div className={spacing}>{children}</div> : <>{children}</>;
}

/**
 * Role gate, resolved only by the states that render a write. The card is
 * mounted inside panels (an AP's row, the switch panel) on every page load and
 * renders nothing almost always; reading the auth context here, rather than at
 * the top, keeps that common path free of any AuthProvider requirement.
 */
function CanPair({ children }: { children: (canPair: boolean) => ReactNode }) {
  const { user } = useAuth();
  return <>{children(user?.role === "owner" || user?.role === "admin")}</>;
}

function upperFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Resolved per call, not at module load: only the role in use is touched.
function readerFor(
  role: DevicePairingRole,
  mac?: string,
): () => Promise<DevicePairingView> {
  if (role === "router") return fetchRouterPairing;
  if (role === "switch") return fetchSwitchPairing;
  return () => fetchApPairing(mac ?? "");
}

function pairerFor(
  role: DevicePairingRole,
  mac?: string,
): () => Promise<DevicePairResult> {
  if (role === "router") return pairRouter;
  if (role === "switch") return pairSwitch;
  return () => pairAp(mac ?? "");
}

function persisterFor(
  role: DevicePairingRole,
  mac?: string,
): () => Promise<DevicePairResult> {
  if (role === "router") return persistRouterPairing;
  if (role === "switch") return persistSwitchPairing;
  return () => persistApPairing(mac ?? "");
}

export function DevicePairingCard({
  role,
  mac,
  errorCode,
  model,
  variant = "card",
  onChanged,
}: DevicePairingCardProps) {
  const noun = NOUN[role];
  const swrKey =
    role === "ap"
      ? `/api/network/aps/${mac ?? ""}/pairing`
      : `/api/network/${role}/pairing`;
  const { data, mutate } = useSWR<DevicePairingView>(
    swrKey,
    readerFor(role, mac),
    {
      refreshInterval: 10_000,
    },
  );

  const [dismissed, setDismissed] = useState(false);
  // Set by a pair whose save failed; the service's own `pendingPersist` takes over
  // on the next poll, so this only bridges the gap and survives a poll that races.
  const [unsaved, setUnsaved] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pairButtonRef = useRef<HTMLButtonElement | null>(null);

  if (!data || !data.available) return null;

  const code = errorCode === undefined ? data.routerErrorCode : errorCode;
  // Page spacing is the page's job (card-outer-margin ratchet): the card
  // variant carries no margin on the .card itself, a plain wrapper does.
  const chrome = variant === "card" ? "card text-left" : "mt-3 text-left";
  const retryChrome = variant === "card" ? "card" : "mt-3 text-left";

  // ADR-071 section 2.3: one AP secret per box, and the address comes from mDNS
  // discovery - name both so the operator can check the target, and say that a
  // second pairing replaces the first AP's password.
  const apNote =
    role === "ap"
      ? ` Target: ${[mac, data.host].filter(Boolean).join(" at ") || "this access point"}. All access points share one password, so pairing this one replaces the password of any access point you paired before - pair them one at a time and re-pair the earlier ones if needed.`
      : "";

  async function onConfirmPair() {
    setError(null);
    let result;
    try {
      result = await pairerFor(role, mac)();
    } catch (e) {
      const msg = e instanceof Error ? e.message : `Couldn't pair the ${noun}.`;
      setError(msg);
      throw e; // keeps the dialog open so the owner can retry or back out
    }
    if (!result.ok) {
      setError(result.error ?? `Couldn't pair the ${noun}.`);
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
      const result = await persisterFor(role, mac)();
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
      <AlertTriangle
        size={14}
        className="mt-0.5 flex-shrink-0"
        aria-hidden="true"
      />
      <span>{error}</span>
    </div>
  );

  // 3. RETRY — checked first: a live device with an unsaved password is the
  //    state with a deadline (the next restart).
  if (unsaved || data.pendingPersist) {
    return (
      <Spaced variant={variant} spacing="mb-4">
      <CanPair>
        {(canPair) => (
          <div
            className={retryChrome}
            role="alert"
            data-testid={`${role}-pairing-retry`}
          >
            <div className="flex items-start gap-3">
              <AlertTriangle
                size={18}
                className="mt-0.5 flex-shrink-0 text-system-orange"
                aria-hidden="true"
              />
              <div className="flex-1 min-w-0">
                <h3 className="type-headline" style={{ color: "var(--text)" }}>
                  {SAVE_FAILED}
                </h3>
                {canPair ? (
                  <>
                    <p
                      className="type-caption-1 mt-0.5"
                      style={{ color: "var(--text-muted)" }}
                    >
                      The {noun} is connected now. Save the password so it
                      survives a restart.
                    </p>
                    <button
                      type="button"
                      className="btn primary sm mt-3"
                      onClick={onRetry}
                      disabled={retrying}
                    >
                      {retrying ? (
                        <>
                          <Loader2
                            size={14}
                            className="animate-spin"
                            aria-hidden="true"
                          />{" "}
                          Retrying…
                        </>
                      ) : (
                        "Retry"
                      )}
                    </button>
                  </>
                ) : (
                  <p
                    className="type-caption-1 mt-0.5"
                    style={{ color: "var(--text-muted)" }}
                  >
                    Ask an owner or admin to retry saving it.
                  </p>
                )}
                {errorBox}
              </div>
            </div>
          </div>
        )}
      </CanPair>
      </Spaced>
    );
  }

  // 2. PAIRED ELSEWHERE — explain; the fix is physical.
  if (data.pairedElsewhere || code === "PAIRED_ELSEWHERE") {
    const box = data.pairedBox ? `${data.pairedBox.slice(0, 16)}…` : null;
    return (
      <div
        className="mt-4"
        role="status"
        data-testid={`${role}-pairing-elsewhere`}
      >
        <p
          className="type-subheadline max-w-md mx-auto"
          style={{ color: "var(--text-muted)" }}
        >
          This {noun} is paired to another device
          {box ? (
            <>
              {" "}
              (fingerprint <span className="font-mono">{box}</span>)
            </>
          ) : null}
          . Press the {noun}&apos;s button to re-pair.
        </p>
      </div>
    );
  }

  // 1. PAIR — AUTH + an open window (an AP: just the open window).
  const offered =
    role === "ap"
      ? data.state === "open"
      : code === "AUTH" && data.state === "open";
  if (offered && !dismissed) {
    const where = data.host ? ` at ${data.host}` : "";
    const named = data.model ?? model ?? null;
    const what = named ? `${upperFirst(noun)} ${named}` : upperFirst(noun);
    return (
      <Spaced variant={variant} spacing="mt-4">
      <CanPair>
        {(canPair) => (
          <div className={chrome} data-testid={`${role}-pairing-offer`}>
            <div className="flex items-start gap-3">
              <Link2
                size={18}
                className="mt-0.5 flex-shrink-0"
                style={{ color: "var(--text-muted)" }}
                aria-hidden="true"
              />
              <div className="flex-1 min-w-0">
                <h3 className="type-headline" style={{ color: "var(--text)" }}>
                  {what}
                  {where} is ready to pair.
                </h3>
                <p
                  className="type-caption-1 mt-0.5"
                  style={{ color: "var(--text-muted)" }}
                >
                  Pairing gives this Droplet control of the {noun}&apos;s
                  network settings.
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
                    <button
                      type="button"
                      className="btn ghost sm"
                      onClick={() => setDismissed(true)}
                    >
                      Not now
                    </button>
                  </div>
                ) : (
                  <p
                    className="type-caption-1 mt-3"
                    style={{ color: "var(--text-muted)" }}
                  >
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
              title={`Pair this ${noun}?`}
              description={`Pairing gives this Droplet control of the ${noun}'s network settings. The ${noun}'s old password is replaced with one only this Droplet knows.${apNote}`}
              confirmLabel="Pair"
              variant="neutral"
            />
          </div>
        )}
      </CanPair>
      </Spaced>
    );
  }

  return null;
}
