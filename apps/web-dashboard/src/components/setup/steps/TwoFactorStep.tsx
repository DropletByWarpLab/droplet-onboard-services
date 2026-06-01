"use client";

import { useState } from "react";
import { ShieldCheck, Copy, Check, KeyRound } from "lucide-react";
import { enrollTotp, verifyTotp } from "@/lib/api";
import { StepShell } from "@/components/setup/StepShell";

/**
 * Two-factor (TOTP) setup — the wizard step that turns on the second factor
 * for the owner account and surfaces the one-time recovery codes.
 *
 * Phase machine:
 *   intro  → explain the benefit, "Set up" (POST /auth/totp/enroll) or skip
 *   enroll → show the QR + otpauth secret, take the 6-digit confirm
 *            (POST /auth/totp/verify)
 *   codes  → display the one-time recovery codes ONCE, gate "Continue" behind
 *            an explicit "I've saved them" confirmation
 *
 * Design-token discipline (per ui-ux review rules): only dp-* / type-* /
 * text-label-* / text-accent / text-system-red tokens — no freelance
 * colours or font sizes. Motion is restrained: StepShell fades each phase
 * in; the copy affordance swaps its glyph instantly, no decorative bounce.
 */

type Phase = "intro" | "enroll" | "codes";

const CODE_RE = /^\d{6}$/;

export function TwoFactorStep({
  onComplete,
  onSkip,
}: {
  onComplete: () => void;
  onSkip: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("intro");
  const [otpauthUri, setOtpauthUri] = useState("");
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [code, setCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const [savedConfirmed, setSavedConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  // The otpauth secret, pulled from the URI for manual entry when a camera
  // can't scan the QR (`secret=` query param).
  const manualSecret = (() => {
    const m = otpauthUri.match(/[?&]secret=([^&]+)/);
    return m ? decodeURIComponent(m[1]!) : "";
  })();

  async function handleStart() {
    setError(null);
    setIsBusy(true);
    try {
      const res = await enrollTotp();
      setOtpauthUri(res.otpauthUri);
      setQrDataUrl(res.qrDataUrl);
      setPhase("enroll");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start two-factor setup");
    } finally {
      setIsBusy(false);
    }
  }

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
      setError(err instanceof Error ? err.message : "That code didn't match. Try again.");
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

  // ── intro ──────────────────────────────────────────────────────────────
  if (phase === "intro") {
    return (
      <StepShell
        title="Add two-factor authentication"
        subtitle="A second factor keeps your Droplet yours, even if your password leaks."
        icon={
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-accent-subtle">
            <ShieldCheck size={28} className="text-accent" />
          </div>
        }
        primary={{
          label: "Set up",
          loadingLabel: "Starting…",
          onClick: handleStart,
          isLoading: isBusy,
          showArrow: true,
        }}
        skip={{ label: "Skip for now", onClick: onSkip }}
      >
        <div className="dp-card p-4">
          <p className="type-footnote text-label-secondary">
            Scan a QR code with an authenticator app (Google Authenticator, 1Password,
            Authy…). You&apos;ll confirm one 6-digit code, then save a set of one-time
            recovery codes.
          </p>
        </div>
        {error && (
          <p className="type-footnote text-system-red bg-system-red/10 rounded-sm px-3 py-2 mt-4">
            {error}
          </p>
        )}
      </StepShell>
    );
  }

  // ── enroll ─────────────────────────────────────────────────────────────
  if (phase === "enroll") {
    return (
      <StepShell
        title="Scan the QR code"
        subtitle="Open your authenticator app and scan this, then enter the code it shows."
        primary={{
          label: "Verify & enable",
          loadingLabel: "Verifying…",
          onClick: handleVerify,
          isLoading: isBusy,
        }}
      >
        <div className="space-y-4">
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
                Can&apos;t scan? Enter this key instead
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
        </div>
      </StepShell>
    );
  }

  // ── codes ──────────────────────────────────────────────────────────────
  return (
    <StepShell
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
