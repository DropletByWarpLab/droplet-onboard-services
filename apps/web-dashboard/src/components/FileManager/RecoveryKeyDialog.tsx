"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type RefObject,
} from "react";
import { Check, Copy, KeyRound, Loader2, Printer } from "lucide-react";
import { Dialog } from "@/components/Dialog";
import { DestructiveConfirm } from "@/components/settings/DestructiveConfirm";
import { RecoveryKeyUnavailableError, revealRecoveryKey } from "@/lib/api";
import { printRecoveryKey } from "@/lib/print-recovery-key";
import { friendlyRecordingStorageError } from "@/lib/recording-storage";

/**
 * WARP-3515 — the one-time recovery-key dialog.
 *
 * Every data drive is LUKS2 (ADR-070) and has a recovery key the owner can
 * reveal ONCE (`POST /api/storage/drives/:id/recovery-key/reveal`, a tier-2
 * write: 200 the first time, 410 ever after). Droplet holds an unrevealed key
 * for 7 days, then shreds it. This dialog is where that promise is kept, so it
 * is built around four rules:
 *
 *   1. OPENING IT CONSUMES NOTHING. It opens on an intro that says what is about
 *      to happen; the key is revealed only when the owner clicks "Show recovery
 *      key" — the tier-2 confirmation the contract asks for, in the dialog the
 *      owner is already looking at rather than a second one stacked on top.
 *   2. ONCE SHOWN, IT CANNOT BE DISMISSED BY ACCIDENT. Escape and a backdrop
 *      click are ignored; the only way out is the explicit "I've saved it"
 *      (gated behind a checkbox, the same shape the setup wizard's two-factor
 *      recovery codes use), which wipes the key from state before it closes.
 *      Copy and Print are offered, because a key that is shown once has to
 *      leave the screen some other way.
 *   3. "GONE" IS NOT "BROKEN". A 410 says the key was already shown or has
 *      expired; a flaky network says "try again". The reverse would word a
 *      retryable failure as a lost key.
 *   4. A MISSED KEY IS RECOVERABLE. The "gone" state offers a new key — a tier-3
 *      action behind a typed phrase (the drive's name), because the old key
 *      stops working.
 *
 * The key lives in this component's state and nowhere else — not an SWR cache,
 * not storage, not a URL — and only while the dialog is open. It is never
 * logged. Built on the shared <Dialog> (WARP-289) for the focus trap, scroll
 * lock, focus restore and reduced-motion handling.
 */
export interface RecoveryKeyDialogProps {
  open: boolean;
  /** Customer-facing drive name (never a device path). */
  driveName: string;
  /**
   * The id to reveal the key for, resolved when the owner clicks "Show recovery
   * key". `null` means the drive is not visible yet (right after preparing it,
   * the drive list can lag the host by a few seconds) — the dialog says so and
   * offers "Try again" instead of failing.
   */
  resolveDriveId: () => Promise<string | null>;
  /**
   * Generate a replacement key (tier 3). When given, the "already shown or
   * expired" state offers it behind a typed-name confirm. May throw: the confirm
   * stays open and says why in plain words.
   */
  onRegenerate?: (driveId: string) => Promise<void>;
  /** Called to close: "Not now", "Close", or "I've saved it". */
  onClose: () => void;
  /** Element that opened the dialog — focus returns here on close. */
  triggerRef?: RefObject<HTMLElement | null>;
}

type Phase =
  | { kind: "intro" }
  | { kind: "loading" }
  | { kind: "shown"; key: string }
  | { kind: "gone" }
  | { kind: "missing" }
  | { kind: "forbidden" }
  | { kind: "drive_pending" }
  | { kind: "failed" }
  /** Closed or closing: renders an empty body so no key can outlive the owner's
   *  "I've saved it" while the exit animation finishes. */
  | { kind: "done" };

type CopyState = "idle" | "copied" | "failed";

export function RecoveryKeyDialog({
  open,
  driveName,
  resolveDriveId,
  onRegenerate,
  onClose,
  triggerRef,
}: RecoveryKeyDialogProps) {
  const titleId = useId();
  const descId = useId();
  const savedId = useId();

  const [phase, setPhase] = useState<Phase>(open ? { kind: "intro" } : { kind: "done" });
  const [saved, setSaved] = useState(false);
  const [copyState, setCopyState] = useState<CopyState>("idle");
  // A replacement key was just generated: the intro says so.
  const [regenerated, setRegenerated] = useState(false);
  const [regenOpen, setRegenOpen] = useState(false);
  const [regenError, setRegenError] = useState<string | null>(null);

  // Every open starts from the intro with nothing in memory; every close wipes
  // the key. Adjusting state while rendering (the documented pattern for a prop
  // change) rather than in an effect, so there is no one-frame flash of an empty
  // body when the dialog opens.
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    setPhase(open ? { kind: "intro" } : { kind: "done" });
    setSaved(false);
    setCopyState("idle");
    setRegenerated(false);
    setRegenOpen(false);
    setRegenError(null);
  }

  // A request that resolves after the dialog closed (or re-opened) must not put
  // a key on screen: each open/close bumps the epoch, and a stale reply is
  // dropped.
  const epoch = useRef(0);
  useEffect(() => {
    epoch.current += 1;
  }, [open]);
  const inFlight = useRef(false);

  const showBtnRef = useRef<HTMLButtonElement | null>(null);
  const regenBtnRef = useRef<HTMLButtonElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const keyRef = useRef<HTMLDivElement | null>(null);
  const copyTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  // The dialog's own focus handling only runs on open/close. When the body
  // swaps (intro → key, intro → "already shown") the focused button unmounts, so
  // put focus where the new content starts — the key itself, so a screen reader
  // reads it, or the heading for the terminal states.
  useEffect(() => {
    if (phase.kind === "shown") keyRef.current?.focus();
    else if (
      phase.kind === "gone" ||
      phase.kind === "missing" ||
      phase.kind === "forbidden" ||
      phase.kind === "drive_pending" ||
      phase.kind === "failed"
    ) {
      headingRef.current?.focus();
    } else if (phase.kind === "intro" && regenerated) {
      // Back at the start after a replacement key: the way forward, not <body>.
      showBtnRef.current?.focus();
    }
  }, [phase.kind, regenerated]);

  const requestKey = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const startedIn = epoch.current;
    setPhase({ kind: "loading" });
    try {
      const id = await resolveDriveId();
      if (epoch.current !== startedIn) return;
      if (!id) {
        setPhase({ kind: "drive_pending" });
        return;
      }
      const key = await revealRecoveryKey(id);
      if (epoch.current !== startedIn) return; // closed meanwhile — drop it
      setPhase({ kind: "shown", key });
    } catch (err) {
      if (epoch.current !== startedIn) return;
      if (err instanceof RecoveryKeyUnavailableError) {
        setPhase({
          kind:
            err.reason === "gone"
              ? "gone"
              : err.reason === "forbidden"
                ? "forbidden"
                : "missing",
        });
      } else {
        // Transport / 5xx: we asked, and could not tell what happened. Retry is
        // honest — if the server did hand the key over, the retry reads 410 and
        // says so (and "generate a new key" is the way out).
        setPhase({ kind: "failed" });
      }
    } finally {
      inFlight.current = false;
    }
  }, [resolveDriveId]);

  const copyKey = useCallback(async (key: string) => {
    try {
      await navigator.clipboard.writeText(key);
      setCopyState("copied");
    } catch {
      // No clipboard (insecure context, denied) — the key is still on screen,
      // selectable, for the owner to copy by hand.
      setCopyState("failed");
    }
    window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopyState("idle"), 3000);
  }, []);

  const finish = () => {
    // Wipe first, close second: the exit animation must not keep the key in the
    // DOM for the owner's "I've saved it" to be a lie.
    setPhase({ kind: "done" });
    onClose();
  };

  // Tier 3: replace the key. The drive id is resolved here, at the moment of the
  // confirm, exactly as for the reveal.
  const regenerate = async () => {
    setRegenError(null);
    try {
      const id = await resolveDriveId();
      if (!id || !onRegenerate) {
        setRegenError(`We can't find ${driveName} yet. Give it a few seconds, then try again.`);
        throw new Error("drive not found");
      }
      await onRegenerate(id);
      setRegenOpen(false);
      setRegenerated(true);
      setPhase({ kind: "intro" });
    } catch (err) {
      setRegenError((current) => current ?? friendlyRecordingStorageError(err, "regenerate"));
      throw err;
    }
  };

  // Escape (and nothing else — the backdrop is inert): ignored while the key is
  // on screen or being fetched, because dismissing then would lose a key that
  // can never be shown again.
  const handleDialogClose = () => {
    if (phase.kind === "shown" || phase.kind === "loading") return;
    onClose();
  };

  const loading = phase.kind === "loading";
  const retryable = phase.kind === "failed" || phase.kind === "drive_pending";

  const description =
    phase.kind === "shown"
      ? "This is the only time Droplet will show this key. Save it somewhere that isn't this Droplet before you close this window."
      : phase.kind === "gone"
        ? "This recovery key has already been shown, or it expired — Droplet only holds an unshown key for 7 days. If you saved it, you're all set."
        : phase.kind === "missing"
          ? `Droplet doesn't have a recovery key for ${driveName}.`
          : phase.kind === "forbidden"
            ? "Only the owner can view a recovery key."
            : phase.kind === "drive_pending"
              ? `We can't find ${driveName} yet. Give it a few seconds, then try again.`
              : regenerated
                ? `A new recovery key is ready for ${driveName}. Show it and save it somewhere that isn't this Droplet — the old one no longer works. Droplet shows it once and can't show it again.`
                : `The recovery key for ${driveName} unlocks it if this Droplet can't — for example after a hardware change. Droplet shows it once and can't show it again, so save it before you close this window. Droplet only holds an unshown key for 7 days.`;

  const title =
    phase.kind === "gone"
      ? "Recovery key already shown"
      : phase.kind === "missing"
        ? "No recovery key available"
        : phase.kind === "forbidden"
          ? "Owner only"
          : "Save your recovery key";

  return (
    <>
      <Dialog
        open={open}
        onClose={handleDialogClose}
        triggerRef={triggerRef}
        labelledBy={titleId}
        describedBy={descId}
        maxWidth="md"
        initialFocusRef={showBtnRef}
        // A stray click outside must never dismiss a key that cannot be shown again.
        closeOnBackdrop={false}
      >
        {phase.kind === "done" ? (
          <div aria-hidden="true" />
        ) : (
          <div className="space-y-4">
            <div className="flex items-start gap-3">
              <span
                className="flex-none mt-0.5 flex h-9 w-9 items-center justify-center rounded-full"
                style={{ background: "var(--brand-subtle)", color: "var(--brand)" }}
                aria-hidden="true"
              >
                <KeyRound size={18} />
              </span>
              <div className="min-w-0">
                <h2
                  id={titleId}
                  ref={headingRef}
                  tabIndex={-1}
                  className="type-headline outline-none"
                  style={{ color: "var(--text)" }}
                >
                  {title}
                </h2>
                <p
                  id={descId}
                  className="type-subheadline mt-1.5"
                  style={{ color: "var(--text-muted)" }}
                >
                  {description}
                </p>
              </div>
            </div>

            {phase.kind === "failed" && (
              <p
                role="alert"
                className="type-footnote rounded-[var(--radius-input)] px-3 py-2"
                style={{
                  color: "var(--danger-ink)",
                  background: "color-mix(in srgb, var(--danger-ink) 8%, transparent)",
                }}
              >
                We couldn&apos;t reach your Droplet. Try again in a moment.
              </p>
            )}

            {phase.kind === "shown" && (
              <div className="space-y-3">
                <div
                  ref={keyRef}
                  tabIndex={-1}
                  data-testid="recovery-key-value"
                  aria-label={`Recovery key for ${driveName}`}
                  className="font-mono break-all select-all rounded-[var(--radius-input)] px-3 py-3 outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
                  style={{
                    background: "var(--inset)",
                    border: "1px solid var(--border)",
                    color: "var(--text)",
                    fontSize: "15px",
                    letterSpacing: "0.03em",
                    lineHeight: 1.6,
                  }}
                >
                  {phase.key}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void copyKey(phase.key)}
                  >
                    {copyState === "copied" ? (
                      <Check size={15} aria-hidden="true" />
                    ) : (
                      <Copy size={15} aria-hidden="true" />
                    )}
                    {copyState === "copied" ? "Copied" : "Copy"}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() =>
                      printRecoveryKey({ driveName, recoveryKey: phase.key })
                    }
                  >
                    <Printer size={15} aria-hidden="true" />
                    Print
                  </button>
                </div>

                <p
                  role="status"
                  aria-live="polite"
                  className={copyState === "idle" ? "sr-only" : "type-footnote"}
                  style={{
                    color:
                      copyState === "failed" ? "var(--danger-ink)" : "var(--text-muted)",
                  }}
                >
                  {copyState === "copied"
                    ? "Copied to your clipboard."
                    : copyState === "failed"
                      ? "Couldn't copy — select the key above and copy it by hand."
                      : ""}
                </p>

                <label
                  htmlFor={savedId}
                  className="flex items-start gap-2 type-footnote cursor-pointer"
                  style={{ color: "var(--text)" }}
                >
                  <input
                    id={savedId}
                    type="checkbox"
                    checked={saved}
                    onChange={(e) => setSaved(e.target.checked)}
                    className="mt-0.5"
                    style={{ accentColor: "var(--brand)" }}
                  />
                  <span>I&apos;ve saved this recovery key somewhere safe.</span>
                </label>
              </div>
            )}

            <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
              {phase.kind === "shown" ? (
                <button
                  type="button"
                  className="btn primary min-h-[44px]"
                  disabled={!saved}
                  onClick={finish}
                >
                  I&apos;ve saved it
                </button>
              ) : phase.kind === "gone" ||
                phase.kind === "missing" ||
                phase.kind === "forbidden" ? (
                <>
                  {phase.kind === "gone" && onRegenerate && (
                    <button
                      ref={regenBtnRef}
                      type="button"
                      className="btn min-h-[44px]"
                      onClick={() => {
                        setRegenError(null);
                        setRegenOpen(true);
                      }}
                    >
                      Generate a new recovery key
                    </button>
                  )}
                  <button type="button" className="btn primary min-h-[44px]" onClick={onClose}>
                    Close
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="btn ghost min-h-[44px]"
                    onClick={onClose}
                    disabled={loading}
                  >
                    Not now
                  </button>
                  <button
                    ref={showBtnRef}
                    type="button"
                    className="btn primary min-h-[44px]"
                    // aria-disabled (not `disabled`) while the request is out, so
                    // focus is not dropped to <body> mid-flight; the in-flight guard
                    // in requestKey is what actually prevents a second request.
                    aria-disabled={loading || undefined}
                    aria-busy={loading || undefined}
                    onClick={() => void requestKey()}
                  >
                    {loading ? (
                      <>
                        <Loader2 size={15} className="animate-spin" aria-hidden="true" />
                        Getting your key…
                      </>
                    ) : retryable ? (
                      "Try again"
                    ) : (
                      "Show recovery key"
                    )}
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </Dialog>

      {/* Tier 3: replace the key. The same typed-name DestructiveConfirm the
          drive flows use — the old key stops working, so a click is not enough. */}
      {onRegenerate && (
        <DestructiveConfirm
          open={regenOpen && open}
          triggerRef={regenBtnRef}
          onCancel={() => setRegenOpen(false)}
          onConfirm={regenerate}
          title="Generate a new recovery key?"
          consequence={`This replaces the recovery key for ${driveName}. The old key will stop working, so anywhere you saved it needs the new one. Droplet shows the new key once.`}
          affectedSummary={`${driveName} · recovery key`}
          confirmPhrase={driveName}
          confirmLabel="Generate new key"
          progressMessage="Generating a new key — this can take a moment. Keep this open until it finishes."
          errorMessage={regenError ?? undefined}
        />
      )}
    </>
  );
}
