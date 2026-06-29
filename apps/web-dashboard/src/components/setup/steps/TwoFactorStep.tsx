"use client";

import { useCallback, useEffect, useState } from "react";
import { Copy, Check, KeyRound, Loader2, ShieldCheck } from "lucide-react";
import { enrollTotp, verifyTotp } from "@/lib/api";
import { translateError } from "@/lib/friendly-errors";
import { StepShell } from "@/components/setup/StepShell";
import { LearnMoreCard } from "@/components/setup/LearnMoreCard";

/**
 * Two-factor (TOTP) setup — the wizard step that turns on the second factor
 * for the owner account and surfaces the one-time recovery codes.
 *
 * Phase machine:
 *   enroll → enrollment starts AUTOMATICALLY on mount (POST /auth/totp/enroll)
 *            so the QR + manual key are on the first screen; take the 6-digit
 *            confirm (POST /auth/totp/verify). "Skip for now" stays one tap away.
 *   codes  → display the one-time recovery codes ONCE, gate "Continue" behind
 *            an explicit "I've saved them" confirmation
 *
 * WARP-931 — the old "intro" screen (an explainer + a "Set up" button) was
 * removed so the QR shows immediately. Enrolling on mount is server-side
 * harmless (no factor is enabled until the code is verified), and Skip still
 * abandons it. The explainer moved into a LearnMoreCard ("New to authenticator
 * apps?" → /help#two-factor).
 *
 * Design-token discipline (per ui-ux review rules): only dp-* / type-* /
 * text-label-* / text-accent / text-system-red tokens — no freelance
 * colours or font sizes.
 */

type Phase = "enroll" | "codes";

const CODE_RE = /^\d{6}$/;

export function TwoFactorStep({
  onComplete,
  onSkip,
}: {
  onComplete: () => void;
  onSkip: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("enroll");
  const [otpauthUri, setOtpauthUri] = useState("");
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [code, setCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const [savedConfirmed, setSavedConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // `enrolling` covers the on-mount POST /auth/totp/enroll (drives the QR
  // skeleton); `isBusy` covers the verify round-trip — kept separate so the
  // "Verify & enable" busy state doesn't fire during the initial fetch.
  const [enrolling, setEnrolling] = useState(true);
  const [isBusy, setIsBusy] = useState(false);
  // WARP-931 — true when enroll comes back 409 TOTP_ALREADY_ENABLED, i.e. the
  // owner navigated BACK to a 2FA step they already completed (the nav floor
  // keeps this step reachable). Auto-enroll would otherwise 409 forever behind a
  // "Try again" loop with the wrong copy; instead we show a calm "already on"
  // confirmation with a Continue.
  const [alreadyEnabled, setAlreadyEnabled] = useState(false);

  // The otpauth secret, pulled from the URI for manual entry when a camera
  // can't scan the QR (`secret=` query param).
  const manualSecret = (() => {
    const m = otpauthUri.match(/[?&]secret=([^&]+)/);
    return m ? decodeURIComponent(m[1]!) : "";
  })();

  // WARP-931 — auto-start enrollment so the QR is on the first screen.
  // Idempotent server-side (the factor isn't active until verify), so a retry
  // just mints a fresh pending secret.
  const handleStart = useCallback(async (signal?: AbortSignal) => {
    setError(null);
    setEnrolling(true);
    try {
      const res = await enrollTotp(signal);
      setOtpauthUri(res.otpauthUri);
      setQrDataUrl(res.qrDataUrl);
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") return;
      // Returning to an already-completed 2FA step: the orchestrator answers
      // 409 TOTP_ALREADY_ENABLED. Treat it as "done", not an error — otherwise
      // the enroll-failed card loops "Try again" → 409 forever.
      if ((err as { code?: unknown })?.code === "TOTP_ALREADY_ENABLED") {
        setAlreadyEnabled(true);
      } else {
        setError(translateError(err, "auth"));
      }
    } finally {
      setEnrolling(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void handleStart(controller.signal);
    return () => controller.abort();
  }, [handleStart]);

  async function handleVerify() {
    setError(null);
    if (!CODE_RE.test(code.trim())) {
      setError("Enter the 6-digit code from your authenticator app");
      return;
    }
    setIsBusy(true);
    try {
      const res = await verifyTotp(code.trim());
      setRecoveryCodes(res.recoveryCodes ?? []);
      setPhase("codes");
    } catch (err) {
      // WARP-646: never surface the raw error. A typed orchestrator code
      // (TOTP_INVALID / RECOVERY_INVALID / …) gets precise copy via the
      // translator; everything else falls back to the dominant verify
      // failure — a wrong or expired code.
      const e = err as { code?: unknown };
      setError(
        typeof e?.code === "string"
          ? translateError(err, "auth")
          : "That code didn't match. Check your authenticator app and try again.",
      );
    } finally {
      setIsBusy(false);
    }
  }

  async function handleCopyCodes() {
    try {
      await navigator.clipboard.writeText(recoveryCodes.join("\n"));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable (e.g. insecure context) — the codes are still
      // visible on screen for the user to copy by hand.
    }
  }

  // ── already enabled ─────────────────────────────────────────────────────
  // Reached by navigating BACK to a 2FA step that was already completed this
  // run. No QR / no re-enroll — just confirm it's on and let them move forward.
  if (alreadyEnabled) {
    return (
      <StepShell
        current="twofactor"
        title="Two-factor is already on"
        subtitle="You set up two-factor authentication for this account. You're all set."
        icon={
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-accent-subtle">
            <ShieldCheck size={28} className="text-accent" />
          </div>
        }
        primary={{ label: "Continue", onClick: onComplete, showArrow: true }}
      >
        <div className="dp-card p-4">
          <p className="type-footnote text-label-secondary">
            Keep your authenticator app — you&rsquo;ll use it the next time you
            sign in. To change or turn off two-factor, head to Settings after
            setup.
          </p>
        </div>
      </StepShell>
    );
  }

  // ── enroll ─────────────────────────────────────────────────────────────
  if (phase === "enroll") {
    const qrReady = qrDataUrl !== "";
    return (
      <StepShell
        current="twofactor"
        title="Scan the QR code"
        subtitle="Open your authenticator app and scan this, then enter the code it shows."
        primary={{
          label: "Verify & enable",
          loadingLabel: "Verifying…",
          onClick: handleVerify,
          isLoading: isBusy,
          disabled: !qrReady,
        }}
        skip={{ label: "Skip for now", onClick: onSkip }}
      >
        <div className="space-y-4">
          {enrolling ? (
            // Enrolling — QR skeleton while POST /auth/totp/enroll is in flight.
            <div
              className="flex items-center justify-center py-10"
              role="status"
              aria-label="Preparing your QR code"
            >
              <Loader2 size={24} className="animate-spin text-label-tertiary" />
            </div>
          ) : !qrReady ? (
            // Enrollment finished but produced no QR — it failed; offer a retry.
            <div className="dp-card p-4 text-center space-y-3">
              <p className="type-footnote text-system-red">
                {error ?? "We couldn't start two-factor setup. Try again."}
              </p>
              <button
                type="button"
                onClick={() => void handleStart()}
                className="dp-btn-secondary"
              >
                Try again
              </button>
            </div>
          ) : (
            <>
              <div className="flex justify-center">
                {/* eslint-disable-next-line @next/next/no-img-element -- data-url QR, not a static asset */}
                <img
                  src={qrDataUrl}
                  alt="Two-factor QR code"
                  width={176}
                  height={176}
                  className="rounded-md bg-white p-2"
                />
              </div>

              {manualSecret && (
                <div className="dp-card p-3">
                  <p className="type-caption-1 text-label-tertiary mb-1">
                    Can&apos;t scan? Enter this key into your authenticator app
                    instead
                  </p>
                  <p className="type-footnote text-label-secondary font-mono break-all">
                    {manualSecret}
                  </p>
                </div>
              )}

              <div>
                <label
                  htmlFor="totp-code"
                  className="type-subheadline text-label-secondary block mb-1.5"
                >
                  6-digit code
                </label>
                <input
                  id="totp-code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                  onKeyDown={(e) => e.key === "Enter" && handleVerify()}
                  placeholder="123456"
                  className="dp-input text-center tracking-[0.5em] font-mono"
                  autoFocus
                />
              </div>

              {error && (
                <p className="type-footnote text-system-red bg-system-red/10 rounded-sm px-3 py-2">
                  {error}
                </p>
              )}

              {/* WARP-931 (T2) — first-timers' guidance + a link to the full how-to
                  (/help#two-factor). Only shown when the QR is on screen so the
                  "scan the code above" copy is accurate. */}
              <LearnMoreCard
                title="New to authenticator apps?"
                helpAnchor="two-factor"
              >
                <p>
                  An authenticator app makes a fresh 6-digit code every 30 seconds.
                  On an iPhone, get one free from the App Store; on Android, from the
                  Play Store. Popular choices are Google Authenticator, 1Password,
                  and Authy.
                </p>
                <p>
                  Once it&rsquo;s installed, scan the code above and type the 6
                  digits it shows.
                </p>
              </LearnMoreCard>
            </>
          )}
        </div>
      </StepShell>
    );
  }

  // ── codes ──────────────────────────────────────────────────────────────
  return (
    <StepShell
      current="twofactor"
      title="Save your recovery codes"
      subtitle="Each code works once if you ever lose your authenticator. Store them somewhere safe — you won't see them again."
      icon={
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-accent-subtle">
          <KeyRound size={28} className="text-accent" />
        </div>
      }
      primary={{
        label: "I've saved them — continue",
        onClick: onComplete,
        disabled: !savedConfirmed,
        showArrow: true,
      }}
    >
      <div className="space-y-4">
        <div className="dp-card p-4">
          <ul className="grid grid-cols-2 gap-x-4 gap-y-2">
            {recoveryCodes.map((rc) => (
              <li
                key={rc}
                className="type-footnote text-label-primary font-mono text-center"
              >
                {rc}
              </li>
            ))}
          </ul>
        </div>

        <button
          type="button"
          onClick={handleCopyCodes}
          className="dp-btn-secondary w-full"
        >
          {copied ? <Check size={16} /> : <Copy size={16} />}
          {copied ? "Copied" : "Copy codes"}
        </button>

        <label className="flex items-start gap-2 type-footnote text-label-secondary cursor-pointer">
          <input
            type="checkbox"
            checked={savedConfirmed}
            onChange={(e) => setSavedConfirmed(e.target.checked)}
            className="mt-0.5 accent-accent"
          />
          <span>I&apos;ve saved these recovery codes somewhere safe.</span>
        </label>
      </div>
    </StepShell>
  );
}
