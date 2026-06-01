"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  Cpu,
  HardDrive,
  MonitorSmartphone,
  Network,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { fetchApplianceContract, postClaim, ClaimError } from "@/lib/api";
import type { ApplianceContract, ApplianceSpec } from "@/lib/types";
import { DropletMark } from "@/components/DropletMark";
import { LearnMoreCard } from "@/components/setup/LearnMoreCard";

/**
 * Wizard step — Claim (PR #373, slots FIRST after the welcome splash).
 *
 * The customer confirms the appliance the box detected on the LAN is theirs and
 * binds it to their workspace by entering the claim code shown on the PyPortal
 * lid display. Per #371 handoff §2 + OnbWizard.jsx `WizClaim`.
 *
 * Structure:
 *   - WizHead: kicker "Step 1" → "We found your Droplet" → sub.
 *   - Appliance card: aurora-badge drop icon + name + appliance_id (mono) +
 *     "Detected on LAN" chip; a 2×2 spec grid (compute/storage/network/display)
 *     rendered from GET /api/setup/appliance.
 *   - Claim-code input + PyPortal hint.
 *   - Supply-chain success chip (TAA / NDAA §889).
 *
 * Edge cases:
 *   - Appliance unreachable (contract fetch fails) → "We can't see your Droplet
 *     yet" + retry; the claim CTA is BLOCKED (claim is not skippable, so the
 *     customer can't proceed without a reachable, claimable box).
 *   - Wrong code → inline error, never revealing the real code; rate-limited
 *     (429) → a distinct "too many attempts" message.
 *
 * Claim is NOT skippable — there is no skip control (the box is useless until
 * claimed; it gates everything after).
 *
 * Design tokens only (no hardcoded hex): the aurora badge composes the shipped
 * `aurora-bg` + `aurora-ring` utilities (the login PR's `.aurora-brand` isn't
 * on this branch); card → `dp-card`; input → `dp-input`; status chip →
 * `dp-status-chip`; success chip → the `system-green` family; mono →
 * Tailwind's `font-mono`; type → `type-*`; labels → `text-label-*`.
 */

const SPEC_ICONS = {
  Compute: Cpu,
  Storage: HardDrive,
  Network: Network,
  Display: MonitorSmartphone,
} as const;

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

  const handleClaim = useCallback(async () => {
    if (!code.trim()) {
      setClaimError("Enter the claim code shown on the PyPortal display.");
      return;
    }
    setClaimError(null);
    setClaiming(true);
    try {
      await postClaim(code);
      // Both a fresh bind and an already-claimed short-circuit advance.
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
    }
  }, [code, onComplete]);

  // ── Appliance unreachable ────────────────────────────────────────
  if (probeError) {
    return (
      <div className="animate-in fade-in duration-300 text-center">
        <div className="mx-auto mb-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-surface-secondary">
          <AlertCircle size={26} className="text-label-tertiary" />
        </div>
        <h1 className="type-title-1 text-label-primary mb-2">
          We can&apos;t see your Droplet yet
        </h1>
        <p className="type-subheadline text-label-secondary mb-8 max-w-sm mx-auto">
          Make sure the appliance is powered on and connected to this network,
          then try again.
        </p>
        <button
          type="button"
          onClick={() => void loadContract()}
          className="dp-btn-primary w-full"
        >
          <RefreshCw size={16} />
          Try again
        </button>
      </div>
    );
  }

  // ── Loading the contract ─────────────────────────────────────────
  if (loading && !contract) {
    return (
      <div className="animate-in fade-in duration-300">
        <div className="mb-7">
          <p className="type-caption-2 font-bold uppercase tracking-wider text-accent">
            Step 1
          </p>
          <h1 className="type-title-1 text-label-primary mt-2">
            Looking for your Droplet…
          </h1>
        </div>
        <div className="dp-card overflow-hidden">
          <div className="flex items-center gap-4 p-5 bg-surface-secondary">
            <div className="h-[52px] w-[52px] rounded-2xl bg-surface-tertiary animate-pulse" />
            <div className="flex-1 space-y-2">
              <div className="h-4 w-32 rounded bg-surface-tertiary animate-pulse" />
              <div className="h-3 w-40 rounded bg-surface-tertiary animate-pulse" />
            </div>
          </div>
        </div>
      </div>
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
  return (
    <div className="animate-in fade-in duration-300">
      {/* WizHead */}
      <div className="mb-7">
        <p className="type-caption-2 font-bold uppercase tracking-wider text-accent">
          Step 1
        </p>
        <h1 className="type-title-1 text-label-primary mt-2">
          We found your Droplet
        </h1>
        <p className="type-subheadline text-label-secondary mt-2">
          This appliance is on your network and waiting to be claimed. Confirm
          it&apos;s yours and we&apos;ll bind it to your workspace.
        </p>
      </div>

      {/* Detected-appliance card */}
      <div className="dp-card overflow-hidden mb-6">
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
          className="dp-input font-mono tracking-wide"
          aria-invalid={claimError !== null}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !claiming) void handleClaim();
          }}
        />
        <span className="type-caption-1 text-label-tertiary mt-1.5 block">
          Shown on the PyPortal display on the front of the unit.
        </span>
      </label>

      {claimError && (
        <div
          role="alert"
          className="mt-3 flex items-start gap-2 type-footnote text-system-red bg-system-red/10 rounded-sm px-3 py-2"
        >
          <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
          <span>{claimError}</span>
        </div>
      )}

      {/* Supply-chain reassurance chip */}
      <div className="mt-4 flex items-center gap-2 rounded-sm bg-system-green/10 px-3.5 py-3 type-footnote text-system-green">
        <ShieldCheck size={15} className="flex-shrink-0" />
        <span>{contract.supply_chain.summary}</span>
      </div>

      {/* Primary CTA — NOT skippable, so no skip control. */}
      <button
        type="button"
        onClick={() => void handleClaim()}
        disabled={claiming}
        className="dp-btn-primary w-full mt-6"
      >
        {claiming ? "Claiming…" : "Claim this Droplet"}
      </button>

      <LearnMoreCard helpAnchor="claim">
        <p>
          Claiming binds this specific appliance to your workspace so only you
          control it. The code lives on the PyPortal screen on the unit — it
          never leaves your network.
        </p>
        <p>
          Don&apos;t see a code? Make sure the display is powered on, or restart
          the appliance and try again.
        </p>
      </LearnMoreCard>
    </div>
  );
}
