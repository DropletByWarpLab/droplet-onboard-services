"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  Cpu,
  HardDrive,
  MonitorSmartphone,
  Network,
  ShieldCheck,
} from "lucide-react";
import { fetchApplianceContract, postClaim, ClaimError } from "@/lib/api";
import type { ApplianceContract, ApplianceSpec } from "@/lib/types";
import { DropletMark } from "@/components/DropletMark";
import { StepShell } from "@/components/setup/StepShell";
import { LearnMoreCard } from "@/components/setup/LearnMoreCard";

/**
 * Wizard step — Claim (PR #373, slots FIRST after the welcome splash).
 *
 * The customer confirms the appliance the box detected on the LAN is theirs and
 * binds it to their workspace by entering the claim code shown on the
 * front-panel display. Per #371 handoff §2 + OnbWizard.jsx `WizClaim`.
 *
 * PR #384 — reflowed into the shared aurora-rail `StepShell` (was a bespoke
 * centered column with an in-body CTA). The three phases each render through
 * `StepShell current="claim"`, so the rail is visible the whole time and the
 * CTA sits in the standard footer position. Functional behavior is unchanged:
 *   - loading  → "Looking for your Droplet…" + skeleton card, no actions.
 *   - probeError → "We can't see your Droplet yet" + a single "Try again"
 *     primary; the claim CTA is BLOCKED (claim is not skippable, so the
 *     customer can't proceed without a reachable, claimable box).
 *   - loaded   → detected-appliance card + claim-code input + supply-chain
 *     chip; the single "Claim this Droplet" primary (NOT skippable → no skip
 *     control). Wrong code → inline error, never revealing the real code;
 *     rate-limited (429) → a distinct "too many attempts" message.
 *
 * Design tokens only (no hardcoded hex): the aurora badge composes the shipped
 * `aurora-bg` + `aurora-ring` utilities; card → `dp-card`; input → `dp-input`;
 * status chip → `dp-status-chip`; success chip → the `system-green` family;
 * mono → Tailwind's `font-mono`; type → `type-*`; labels → `text-label-*`.
 */

const SPEC_ICONS = {
  Compute: Cpu,
  Storage: HardDrive,
  Network: Network,
  Display: MonitorSmartphone,
} as const;

/** WARP-631 — format a whole-second remaining time as m:ss (e.g. 90 → "1:30",
 *  15 → "0:15"). Used for the rate-limit retry countdown. */
function formatCountdown(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function SpecCell({ spec, divideRight, divideTop }: {
  spec: ApplianceSpec;
  divideRight: boolean;
  divideTop: boolean;
}) {
  const Icon = SPEC_ICONS[spec.label as keyof typeof SPEC_ICONS] ?? Cpu;
  return (
    <div
      className={[
        "flex gap-3 p-4",
        divideRight ? "border-r border-separator" : "",
        divideTop ? "border-t border-separator" : "",
      ].join(" ")}
    >
      <Icon size={17} className="text-label-tertiary mt-0.5 flex-shrink-0" />
      <div className="min-w-0">
        <p className="type-footnote font-medium text-label-primary">
          {spec.label}
        </p>
        <p className="type-caption-1 text-label-tertiary leading-snug">
          {spec.value}
        </p>
      </div>
    </div>
  );
}

export function ClaimStep({ onComplete }: { onComplete: () => void }) {
  const [contract, setContract] = useState<ApplianceContract | null>(null);
  const [loading, setLoading] = useState(true);
  const [probeError, setProbeError] = useState(false);
  const [code, setCode] = useState("");
  const [claiming, setClaiming] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  // WARP-631 — live retry countdown on a rate-limited (429) claim. `> 0` means
  // we're locked out: the form is disabled and the inline message shows m:ss.
  const [secondsLeft, setSecondsLeft] = useState(0);
  // WARP-631 (a11y) — one-shot screen-reader announcement of the lockout. The
  // visible countdown ticks every second and is purely visual; this string is
  // written ONCE when the lockout starts and cleared when it ends, so a polite
  // live region announces "too many attempts" a single time instead of
  // re-reading the whole line on every tick.
  const [lockoutAnnouncement, setLockoutAnnouncement] = useState("");
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /** Stop any running countdown interval (idempotent). Also clears the one-shot
   *  SR announcement so it isn't left in the live region after the lockout. */
  const stopCountdown = useCallback(() => {
    if (countdownRef.current !== null) {
      clearInterval(countdownRef.current);
      countdownRef.current = null;
    }
    setLockoutAnnouncement("");
  }, []);

  /** Start (or restart) the 1s retry countdown from `seconds`. At zero it
   *  clears itself, drops the lockout, and clears the inline error so the
   *  customer can try again cleanly. */
  const startCountdown = useCallback(
    (seconds: number) => {
      stopCountdown();
      setSecondsLeft(seconds);
      // Write the SR announcement ONCE for this lockout. Phrased in whole
      // seconds (not the ticking m:ss) precisely so it never needs rewriting —
      // the visible countdown carries the live digits, this carries the alert.
      setLockoutAnnouncement(
        `Too many attempts. Try again in about ${Math.max(0, Math.floor(seconds))} seconds.`,
      );
      countdownRef.current = setInterval(() => {
        setSecondsLeft((prev) => {
          if (prev <= 1) {
            stopCountdown();
            setClaimError(null);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    },
    [stopCountdown],
  );

  // Clear the interval on unmount so it never fires into an unmounted tree.
  useEffect(() => stopCountdown, [stopCountdown]);

  const loadContract = useCallback(async () => {
    setLoading(true);
    setProbeError(false);
    try {
      setContract(await fetchApplianceContract());
    } catch {
      // Appliance unreachable / contract 5xx — block continue, offer retry.
      setProbeError(true);
      setContract(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadContract();
  }, [loadContract]);

  // Scan-to-claim deep link (design handoff): the front-panel claim screen's QR
  // encodes `/setup?c=<CODE>`, so landing here from a scan prefills the field.
  // Read once on mount from window.location (this is a client component; no
  // useSearchParams so the page never needs a Suspense boundary for it).
  // Normalized the same way the server's normalizeClaimCode() does — junk
  // params degrade to the normal empty field. Prefill ONLY: never overwrite a
  // typed value, never auto-submit (claiming stays a deliberate action under
  // the WARP-631 rate-limit posture).
  useEffect(() => {
    const param = new URLSearchParams(window.location.search).get("c");
    if (!param) return;
    const scanned = param.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    if (!scanned) return;
    setCode((prev) => prev || scanned);
  }, []);

  const handleClaim = useCallback(async () => {
    // While the rate-limit countdown is running the controls are disabled, but
    // guard here too so a stray Enter/programmatic call can't fire mid-lockout.
    if (secondsLeft > 0) return;
    if (!code.trim()) {
      setClaimError("Enter the claim code shown on the display.");
      return;
    }
    setClaimError(null);
    setClaiming(true);
    try {
      await postClaim(code);
      // Both a fresh bind and an already-claimed short-circuit advance. Tidy up
      // any leftover countdown before leaving the step (WARP-631).
      stopCountdown();
      setSecondsLeft(0);
      onComplete();
    } catch (err) {
      // The server never echoes the real code, so neither do we — just the
      // failure-kind message (wrong code vs rate-limited).
      const msg =
        err instanceof ClaimError
          ? err.message
          : "Couldn't claim the appliance. Try again in a moment.";
      setClaimError(msg);
      setClaiming(false);
      // WARP-631 — a rate-limited 429 carries the wait; start the live
      // countdown so the form locks until the backoff window elapses.
      if (err instanceof ClaimError && err.retryAfterSeconds) {
        startCountdown(err.retryAfterSeconds);
      }
    }
  }, [code, onComplete, secondsLeft, startCountdown, stopCountdown]);

  // ── Appliance unreachable ────────────────────────────────────────
  // A single "Try again" primary; NO skip — claim is not skippable, and an
  // unreachable box can't be claimed, so the customer can't proceed.
  if (probeError) {
    return (
      <StepShell
        current="claim"
        title="We can't see your Droplet yet"
        subtitle="Make sure the appliance is powered on and connected to this network, then try again."
        primary={{
          label: "Try again",
          loadingLabel: "Looking…",
          onClick: () => void loadContract(),
          isLoading: loading,
          showArrow: false,
        }}
      >
        <div className="dp-card flex items-start gap-3 !p-4">
          <AlertCircle size={18} className="text-label-tertiary flex-shrink-0 mt-0.5" />
          <p className="type-footnote text-label-secondary">
            We probe the local network for your appliance. If it just powered
            on, give it a few seconds and try again.
          </p>
        </div>
      </StepShell>
    );
  }

  // ── Loading the contract ─────────────────────────────────────────
  if (loading && !contract) {
    return (
      <StepShell current="claim" title="Looking for your Droplet…">
        <div className="dp-card overflow-hidden">
          <div className="flex items-center gap-4 p-5 bg-surface-secondary">
            <div className="h-[52px] w-[52px] rounded-2xl bg-surface-tertiary animate-pulse" />
            <div className="flex-1 space-y-2">
              <div className="h-4 w-32 rounded bg-surface-tertiary animate-pulse" />
              <div className="h-3 w-40 rounded bg-surface-tertiary animate-pulse" />
            </div>
          </div>
        </div>
      </StepShell>
    );
  }

  if (!contract) return null;

  const specs = [
    contract.compute,
    contract.storage,
    contract.network,
    contract.display,
  ];

  // ── Claim card ───────────────────────────────────────────────────
  // The single "Claim this Droplet" primary lives in the StepShell footer.
  // NOT skippable → no skip control.
  return (
    <StepShell
      current="claim"
      title="We found your Droplet"
      subtitle="This appliance is on your network and waiting to be claimed. Confirm it's yours and we'll bind it to your workspace."
      primary={{
        label: "Claim this Droplet",
        loadingLabel: "Claiming…",
        onClick: () => void handleClaim(),
        isLoading: claiming,
        // WARP-631 — locked out during the retry countdown.
        disabled: secondsLeft > 0,
      }}
    >
      {/* Detected-appliance card */}
      <div data-testid="claim-appliance-card" className="dp-card overflow-hidden mb-6">
        <div className="flex items-center gap-4 p-5 bg-surface-secondary border-b border-separator">
          <span className="aurora-bg aurora-ring flex h-[52px] w-[52px] flex-shrink-0 items-center justify-center rounded-2xl">
            <DropletMark size={26} className="text-accent" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="type-headline text-label-primary truncate">
              Droplet appliance
            </p>
            <p className="type-caption-1 font-mono text-label-tertiary truncate">
              {contract.appliance_id}
            </p>
          </div>
          <span className="dp-status-chip flex-shrink-0">
            <span className="h-2 w-2 rounded-full bg-system-green" />
            Detected on LAN
          </span>
        </div>
        <div className="grid grid-cols-2">
          {specs.map((spec, i) => (
            <SpecCell
              key={spec.label}
              spec={spec}
              divideRight={i % 2 === 0}
              divideTop={i >= 2}
            />
          ))}
        </div>
      </div>

      {/* Claim-code field */}
      <label className="block">
        <span className="type-footnote font-medium text-label-secondary mb-1.5 block">
          Claim code
        </span>
        <input
          type="text"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="DRPL · 7K2Q · 9F4M"
          autoComplete="off"
          spellCheck={false}
          // WARP-631 — locked while the retry countdown runs.
          disabled={secondsLeft > 0}
          className="dp-input font-mono tracking-wide"
          aria-invalid={claimError !== null}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !claiming && secondsLeft === 0)
              void handleClaim();
          }}
        />
        <span className="type-caption-1 text-label-secondary mt-1.5 block">
          Look at the screen on the front of your Droplet — it shows a short
          code like DRPL · XXXX · XXXX.
        </span>
      </label>

      {/* WARP-631 — while rate-limited, the inline slot shows a calm retry
          countdown (m:ss) instead of the wrong-code error. Same slot, so
          there's no layout jump between the two states.
          a11y: this visible block is PURELY VISUAL — its m:ss text ticks every
          second, so it must NOT be a live region (a screen reader would
          re-announce the whole line on every tick). The one-shot announcement
          lives in the sr-only polite region rendered alongside it below. */}
      {secondsLeft > 0 ? (
        <div className="mt-3 flex items-start gap-2 type-footnote text-system-red bg-system-red/10 rounded-sm px-3 py-2">
          <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
          {/* tabular-nums on the line so the m:ss digits don't twitch each tick.
              Kept as one text node so the countdown copy stays greppable. */}
          <span className="tabular-nums">
            Too many attempts — try again in {formatCountdown(secondsLeft)}
          </span>
        </div>
      ) : (
        claimError && (
          <div
            role="alert"
            className="mt-3 flex items-start gap-2 type-footnote text-system-red bg-system-red/10 rounded-sm px-3 py-2"
          >
            <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
            <span>{claimError}</span>
          </div>
        )
      )}

      {/* WARP-631 (a11y) — visually-hidden polite live region that announces the
          lockout ONCE. Its text is set a single time when the countdown starts
          and cleared when it ends, so the screen reader speaks "too many
          attempts" once per lockout rather than on every visible-countdown
          tick. Always mounted so the announcement fires on text change. */}
      <span
        className="sr-only"
        aria-live="polite"
        aria-atomic="true"
        data-testid="claim-lockout-announcement"
      >
        {lockoutAnnouncement}
      </span>

      {/* Supply-chain reassurance chip */}
      <div className="mt-4 flex items-center gap-2 rounded-sm bg-system-green/10 px-3.5 py-3 type-footnote text-system-green">
        <ShieldCheck size={15} className="flex-shrink-0" />
        <span>{contract.supply_chain.summary}</span>
      </div>

      <LearnMoreCard helpAnchor="claim">
        <p>
          Claiming binds this specific appliance to your workspace so only you
          control it. The code lives on the display on the unit — it
          never leaves your network.
        </p>
        <p>
          Don&apos;t see a code? Make sure the display is powered on, or restart
          the appliance and try again.
        </p>
      </LearnMoreCard>
    </StepShell>
  );
}
