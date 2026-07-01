"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Globe, Loader2, Lock, ShieldCheck, X } from "lucide-react";
import {
  validateBoxName,
  boxNameToFqdn,
  boxNameReasonMessage,
  BOX_NAME_SUFFIX,
} from "@droplet/shared-types";
import { checkBoxName, setBoxName } from "@/lib/api";
import { StepShell } from "@/components/setup/StepShell";
import { LearnMoreCard } from "@/components/setup/LearnMoreCard";

/**
 * Wizard step — "Name your secure address" (WARP-979, ported from the design
 * handoff's `SetSecured`). Reworks the old informational DuckDNS `address` step
 * into the handoff's flow: the owner TYPES a name for their box and it becomes
 * `<name>.droplet-us.com` — a publicly-trusted address (real green padlock,
 * nothing to install on any device).
 *
 * The step KEY stays `address` (the STEPS/Step union + state machine are
 * unchanged — wifi/address still both persist as the single `internet`
 * SetupStep). Only this step's PURPOSE + UI changed.
 *
 * Validation mirrors the HQ ruleset via the SHARED `@droplet/shared-types`
 * box-name util (lowercase DNS-safe slug, 3–40 chars, no leading/trailing/double
 * hyphen, reserved blocklist, `d-<16hex>` lookalike rejection) so the live
 * client-side check here and the orchestrator's server-side re-check can never
 * drift. Availability is checked (debounced) against
 * GET /api/setup/box-name/check. Continue is disabled until a valid + available
 * name is chosen; Skip is always allowed. On Continue the chosen name is POSTed
 * to POST /api/setup/box-name so the box's tls-issuance requests
 * `<name>.droplet-us.com`.
 */

/** Debounce (ms) before the availability check fires as the owner types. */
const CHECK_DEBOUNCE_MS = 450;

type CheckStatus =
  | { kind: "idle" }
  | { kind: "invalid"; message: string }
  | { kind: "checking" }
  | { kind: "available" }
  | { kind: "taken"; message: string }
  | { kind: "error" };

export function AddressStep({
  onComplete,
  onSkip,
}: {
  onComplete: () => void;
  onSkip: () => void;
}) {
  const [name, setName] = useState("");
  const [status, setStatus] = useState<CheckStatus>({ kind: "idle" });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Normalize for display + validation. We never rewrite the owner's raw input
  // (they see their own typing); the slug is the normalized form we validate,
  // check, and persist.
  const local = validateBoxName(name);
  const slug = local.slug;
  const fqdn = boxNameToFqdn(slug || "your-box");

  // Cancel a stale in-flight availability check when the input changes.
  const abortRef = useRef<AbortController | null>(null);

  const runCheck = useCallback((candidate: string) => {
    const v = validateBoxName(candidate);
    if (!v.ok) {
      setStatus({
        kind: "invalid",
        message: boxNameReasonMessage(v.reason ?? "empty"),
      });
      return;
    }
    setStatus({ kind: "checking" });
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    checkBoxName(v.slug, controller.signal)
      .then((res) => {
        if (controller.signal.aborted) return;
        if (res.available) {
          setStatus({ kind: "available" });
        } else {
          setStatus({
            kind: "taken",
            message:
              res.message ??
              "That name isn't available — pick another.",
          });
        }
      })
      .catch((e) => {
        if (controller.signal.aborted || (e as Error)?.name === "AbortError") {
          return;
        }
        setStatus({ kind: "error" });
      });
  }, []);

  // Debounced live validation + availability check as the owner types.
  useEffect(() => {
    if (name.trim().length === 0) {
      setStatus({ kind: "idle" });
      return;
    }
    // Validate immediately (no debounce) so bad input reads as invalid at once;
    // only debounce the network availability check.
    const v = validateBoxName(name);
    if (!v.ok) {
      setStatus({
        kind: "invalid",
        message: boxNameReasonMessage(v.reason ?? "empty"),
      });
      return;
    }
    setStatus({ kind: "checking" });
    const t = setTimeout(() => runCheck(name), CHECK_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [name, runCheck]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const isAvailable = status.kind === "available";

  async function handleContinue() {
    if (!isAvailable) return;
    setSaveError(null);
    setSaving(true);
    try {
      await setBoxName(slug);
      onComplete();
    } catch (e) {
      setSaveError(
        e instanceof Error
          ? e.message
          : "Couldn't save that name. Try again in a moment.",
      );
    } finally {
      setSaving(false);
    }
  }

  // Ring + status glyph mirror the handoff's live-validation affordance, in our
  // tokens: accent while checking, green when available, red when invalid/taken.
  const ringClass =
    status.kind === "available"
      ? "border-system-green ring-2 ring-system-green/20"
      : status.kind === "invalid" || status.kind === "taken"
        ? "border-system-red ring-2 ring-system-red/20"
        : "border-separator focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/20";

  return (
    <StepShell
      current="address"
      title="Name your secure address"
      subtitle="Your Droplet gives itself a private, publicly-trusted web address — pick the name you want and we'll check it's free. The padlock is real, with nothing to install on any device."
      primary={{
        label: "Continue",
        loadingLabel: "Saving…",
        onClick: handleContinue,
        isLoading: saving,
        disabled: !isAvailable,
        showArrow: true,
        ariaDescribedBy: !isAvailable ? "box-name-status" : undefined,
      }}
      skip={{ label: "Skip — I'll do this later", onClick: onSkip }}
    >
      {/* Name input with the fixed .droplet-us.com suffix + live status glyph. */}
      <label className="block">
        <span className="type-subheadline text-label-secondary block mb-1.5">
          Choose your address
        </span>
        <div
          className={`flex items-center gap-2 h-12 px-3.5 rounded-xl bg-surface-primary border transition-[border-color,box-shadow] duration-200 ${ringClass}`}
        >
          <Globe
            size={16}
            className="text-label-tertiary flex-none"
            aria-hidden="true"
          />
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="your-box"
            aria-label="Box name"
            className="flex-1 min-w-0 border-none outline-none bg-transparent font-mono type-body font-semibold text-label-primary placeholder:text-label-quaternary"
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            maxLength={40}
          />
          <span className="font-mono type-body text-label-tertiary flex-none">
            {BOX_NAME_SUFFIX}
          </span>
          <span className="flex-none flex items-center ml-auto" aria-hidden="true">
            {status.kind === "checking" && (
              <Loader2 size={16} className="text-label-tertiary animate-spin" />
            )}
            {status.kind === "available" && (
              <Check size={16} className="text-system-green" />
            )}
            {(status.kind === "invalid" || status.kind === "taken") && (
              <X size={16} className="text-system-red" />
            )}
          </span>
        </div>
      </label>

      {/* Live status line — announced politely so a screen reader hears the
          availability result without stealing focus. */}
      <div
        id="box-name-status"
        role="status"
        aria-live="polite"
        className="min-h-[1.5rem] mt-2 mb-4 type-footnote"
      >
        {status.kind === "checking" && (
          <span className="text-label-tertiary">
            Checking <span className="font-mono">{fqdn}</span>…
          </span>
        )}
        {status.kind === "available" && (
          <span className="text-system-green inline-flex items-center gap-1.5">
            <Check size={13} aria-hidden="true" />
            <span>
              <span className="font-mono">{fqdn}</span> is available
            </span>
          </span>
        )}
        {status.kind === "invalid" && (
          <span className="text-system-red">{status.message}</span>
        )}
        {status.kind === "taken" && (
          <span className="text-system-red">
            <span className="font-mono">{fqdn}</span> — {status.message}
          </span>
        )}
        {status.kind === "error" && (
          <span className="text-label-tertiary">
            Couldn&rsquo;t check that name right now — try again in a moment.
          </span>
        )}
      </div>

      {/* Padlock preview card — dims until a valid, available name is chosen. */}
      <div
        className={`dp-card !p-4 flex items-center gap-3.5 mb-4 transition-opacity duration-200 ${
          isAvailable ? "opacity-100" : "opacity-50"
        }`}
      >
        <span className="w-11 h-11 rounded-xl flex-none flex items-center justify-center bg-system-green/10 text-system-green">
          <Lock size={22} aria-hidden="true" />
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <Lock size={13} className="text-system-green" aria-hidden="true" />
            <span className="font-mono type-subheadline font-semibold text-label-primary truncate">
              {fqdn}
            </span>
          </div>
          <p className="type-caption-1 text-label-tertiary mt-0.5">
            Trusted certificate · auto-issued once you confirm · renews itself
          </p>
        </div>
      </div>

      {/* Two reassurance tiles — ported from the handoff. */}
      <div className="flex items-stretch gap-2">
        <div className="flex-1 min-w-0 dp-card !p-3.5">
          <ShieldCheck size={17} className="text-accent" aria-hidden="true" />
          <div className="type-footnote font-semibold mt-1.5 text-label-primary">
            Nothing to install
          </div>
          <div className="type-caption-1 text-label-tertiary mt-0.5 leading-snug">
            no per-device certificate, no security warning to click through
          </div>
        </div>
        <div className="flex-1 min-w-0 dp-card !p-3.5">
          <Globe size={17} className="text-accent" aria-hidden="true" />
          <div className="type-footnote font-semibold mt-1.5 text-label-primary">
            One address everywhere
          </div>
          <div className="type-caption-1 text-label-tertiary mt-0.5 leading-snug">
            the same trusted address resolves at home and over the VPN
          </div>
        </div>
      </div>

      {saveError && (
        <div
          role="alert"
          className="mt-4 flex items-start gap-2 type-footnote text-system-red bg-system-red/10 rounded-sm px-3 py-2"
        >
          <X size={14} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
          <span>{saveError}</span>
        </div>
      )}

      <LearnMoreCard title="What the padlock means" helpAnchor="internet">
        <p>
          The padlock in your browser&rsquo;s address bar tells you two things:
          the connection to this box is <strong>encrypted</strong> (nobody on the
          network can read it), and the box is <strong>who it says it is</strong>{" "}
          — its identity was checked against a certificate a trusted authority
          signed.
        </p>
        <p>
          Older setups served a <strong>self-signed</strong> certificate the
          browser didn&rsquo;t recognise, so every phone and laptop hit a
          &ldquo;your connection is not private&rdquo; warning and had to run a
          trust script. Now the box issues itself a{" "}
          <strong>publicly-trusted</strong> certificate for its own private
          address (<span className="font-mono">{"<name>"}{BOX_NAME_SUFFIX}</span>)
          — a real green padlock, zero install, and nothing is ever published to
          the public internet.
        </p>
      </LearnMoreCard>
    </StepShell>
  );
}
