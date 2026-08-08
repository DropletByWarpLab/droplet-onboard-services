"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  Globe,
  Loader2,
  Lock,
  Pencil,
  ShieldCheck,
  X,
} from "lucide-react";
import {
  validateBoxName,
  boxNameToFqdn,
  boxNameReasonMessage,
  BOX_NAME_SUFFIX,
} from "@droplet/shared-types";
import { checkBoxName, setBoxName, renameBox, fetchBoxName } from "@/lib/api";
import { StepShell } from "@/components/setup/StepShell";
import { LearnMoreCard } from "@/components/setup/LearnMoreCard";

/**
 * Wizard step — "Name your secure address" (WARP-979, ported from the design
 * handoff's `SetSecured`). Reworks the old informational DuckDNS `address` step
 * into the handoff's flow: the owner TYPES a name for their box and it becomes
 * `<name>.droplet-us.com` — a publicly-trusted address (real green padlock,
 * nothing to install on any device).
 *
 * WARP-1109 — the step has THREE modes, chosen on mount from GET /setup/box-name:
 *   - `fresh`   — no name yet: type + check + POST /setup/box-name (first claim).
 *   - `named`   — the box ALREADY holds a name: show "Your box is named X" (its
 *                 fqdn + padlock) with Keep-this-address / Rename. This is the
 *                 fix for the onboarding bug where an already-named box read
 *                 EVERY name as "taken" — we never render the already-held name
 *                 as a conflict, and the owner renames in place instead.
 *   - `rename`  — Rename was clicked: the same picker, but Continue drives
 *                 POST /setup/box-name/rename (release the old name → claim the
 *                 new one → re-issue), with Cancel back to `named`.
 *
 * The step KEY stays `address` (the STEPS/Step union + state machine are
 * unchanged — wifi/address still both persist as the single `internet`
 * SetupStep). Only this step's PURPOSE + UI changed.
 *
 * Validation mirrors the HQ ruleset via the SHARED `@droplet/shared-types`
 * box-name util so the live client-side check and the orchestrator's server-side
 * re-check can never drift. Availability is checked (debounced) against
 * GET /api/setup/box-name/check.
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

/** Which of the three UI modes is showing. `null` = still resolving the mount
 *  GET (brief) — we render the picker immediately so a slow/failed GET degrades
 *  to the fresh flow, and only switch to `named` if a saved name comes back. */
type Mode = "fresh" | "named" | "rename";

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
  // WARP-1109 — the address the box ALREADY holds (null = none yet, i.e. fresh).
  const [current, setCurrent] = useState<{ name: string; fqdn: string } | null>(
    null,
  );
  const [mode, setMode] = useState<Mode>("fresh");

  // WARP-1109 — learn on mount whether the box already holds a name. If it does,
  // show the "your box is named X" state (Keep / Rename) instead of the
  // fresh-pick flow — an already-named box must NEVER read a name as "taken".
  // Best-effort: a failed GET leaves the fresh flow (the honest fallback).
  useEffect(() => {
    let cancelled = false;
    fetchBoxName()
      .then((r) => {
        if (cancelled || !r.name) return;
        setCurrent({ name: r.name, fqdn: r.fqdn ?? boxNameToFqdn(r.name) });
        setMode("named");
      })
      .catch(() => {
        // Best-effort — the fresh picker is the honest fallback.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Normalize for display + validation. We never rewrite the owner's raw input
  // (they see their own typing); the slug is the normalized form we validate,
  // check, and persist.
  const local = validateBoxName(name);
  const slug = local.slug;
  const fqdn = boxNameToFqdn(slug || "your-box");

  // Cancel a stale in-flight availability check when the input changes.
  const abortRef = useRef<AbortController | null>(null);
  // The slug the LATEST render is interested in. A resolving check whose slug no
  // longer matches this is stale (the owner typed on, possibly into an INVALID
  // name that fired no new check + no abort) and MUST NOT paint its result over
  // the current state — otherwise a slow "available" response could overwrite a
  // freshly-shown "invalid"/"taken", re-enabling Continue for a name that isn't
  // actually valid. `null` = the current input is empty/invalid (discard any
  // in-flight result).
  const wantSlugRef = useRef<string | null>(null);

  const runCheck = useCallback((candidate: string) => {
    const v = validateBoxName(candidate);
    if (!v.ok) {
      wantSlugRef.current = null;
      abortRef.current?.abort();
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
        // Discard if superseded (aborted) OR if the owner has since moved on to a
        // different (or invalid) slug — the ref, not just the abort signal, is
        // authoritative because an invalid keystroke fires no new check to abort
        // this one.
        if (controller.signal.aborted || wantSlugRef.current !== v.slug) return;
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
        if (
          controller.signal.aborted ||
          wantSlugRef.current !== v.slug ||
          (e as Error)?.name === "AbortError"
        ) {
          return;
        }
        setStatus({ kind: "error" });
      });
  }, []);

  // Only the picker modes run the live availability check.
  const picking = mode === "fresh" || mode === "rename";

  // Debounced live validation + availability check as the owner types.
  useEffect(() => {
    if (!picking) return;
    // WARP-1104 — any edit to the name clears a stale claim/save-error banner, so
    // the owner never sees a previous attempt's "already taken" stacked beneath a
    // fresh green "available" for the name they're now typing.
    setSaveError(null);
    if (name.trim().length === 0) {
      wantSlugRef.current = null;
      abortRef.current?.abort();
      setStatus({ kind: "idle" });
      return;
    }
    // Validate immediately (no debounce) so bad input reads as invalid at once;
    // only debounce the network availability check.
    const v = validateBoxName(name);
    if (!v.ok) {
      // Mark the current input as not-checkable and cancel any in-flight check so
      // a slow prior response can't overwrite this invalid state.
      wantSlugRef.current = null;
      abortRef.current?.abort();
      setStatus({
        kind: "invalid",
        message: boxNameReasonMessage(v.reason ?? "empty"),
      });
      return;
    }
    // Record the slug this render wants an answer for; runCheck discards any
    // resolution whose slug no longer matches.
    wantSlugRef.current = v.slug;
    setStatus({ kind: "checking" });
    const t = setTimeout(() => runCheck(name), CHECK_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [name, runCheck, picking]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const isAvailable = status.kind === "available";

  // Enter the rename picker from the named state.
  function startRename() {
    setSaveError(null);
    setName("");
    setStatus({ kind: "idle" });
    setMode("rename");
  }

  // Leave the rename picker, back to the confirmed current-address view.
  function cancelRename() {
    setSaveError(null);
    wantSlugRef.current = null;
    abortRef.current?.abort();
    setName("");
    setStatus({ kind: "idle" });
    setMode("named");
  }

  // Keep the address the box already holds — no re-claim needed, just advance.
  function keepCurrent() {
    onComplete();
  }

  // Persist a name: `setBoxName` for a first claim (fresh), `renameBox`
  // (release-then-claim) for a rename. Shared save/advance/error handling.
  async function submitName(persist: (slug: string) => Promise<unknown>) {
    if (!isAvailable) return;
    // The slug this submit is claiming. The name <input> stays editable while
    // `saving` (StepShell only disables the primary button), so by the time this
    // claim resolves the owner may have typed on to a different name — capture
    // what we submitted so a late rejection can tell whether it's still current.
    const submittedSlug = slug;
    setSaveError(null);
    setSaving(true);
    try {
      await persist(submittedSlug);
      onComplete();
    } catch (e) {
      const code = (e as { code?: unknown })?.code;
      // WARP-1109 — the fresh POST can still race a box that already holds a
      // name; the orchestrator answers 409 { code: "BOX_NAME_ALREADY_NAMED" }.
      // Key the copy off the CODE and point the owner at Rename (NOT the old,
      // now-false "factory reset releases it").
      if (code === "BOX_NAME_ALREADY_NAMED") {
        setSaveError(
          "This box already holds a secure address — use Rename to change it.",
        );
      } else if (code === "BOX_NAME_TAKEN") {
        // WARP-1104 — the inline availability check is format-only
        // (authoritative:false); the claim is the AUTHORITATIVE availability
        // answer, so a name the check reported "available" can still come back
        // taken here. Reconcile the FIELD to `taken` (green check → red X,
        // Continue disabled) instead of leaving a stale green "…is available"
        // beside a detached red "already taken" banner — the check and the claim
        // must agree. Editing the name re-runs the live check and clears this.
        //
        // Staleness guard (same idiom as runCheck / the debounced check): only
        // apply this if the slug we submitted is STILL the one the owner is on.
        // The field is editable while saving, so a late rejection for an OLD
        // name must NOT stomp a fresher "available" for a name typed since —
        // that would re-open the very check/claim disagreement this fixes.
        if (wantSlugRef.current !== submittedSlug) return;
        wantSlugRef.current = null;
        abortRef.current?.abort();
        setStatus({
          kind: "taken",
          message:
            e instanceof Error && e.message
              ? e.message
              : "That name isn't available — pick another.",
        });
      } else {
        setSaveError(
          e instanceof Error
            ? e.message
            : "Couldn't save that name. Try again in a moment.",
        );
      }
    } finally {
      setSaving(false);
    }
  }

  // ── Mode: the box already holds a name — show it + Keep / Rename ──
  if (mode === "named" && current) {
    return (
      <StepShell
        current="address"
        title="Your secure address"
        subtitle="Your Droplet already has a private, publicly-trusted web address. Keep it, or rename it to something new."
        primary={{
          label: "Keep this address",
          onClick: keepCurrent,
          showArrow: true,
        }}
        skip={{ label: "Skip — I'll do this later", onClick: onSkip }}
      >
        {/* The confirmed current address — the padlock is the one bold moment;
            everything around it stays quiet. Never rendered as "taken". */}
        <div className="dp-card !p-4 flex items-center gap-3.5 mb-4">
          <span className="w-11 h-11 rounded-xl flex-none flex items-center justify-center bg-system-green/10 text-system-green">
            <Lock size={22} aria-hidden="true" />
          </span>
          <div className="flex-1 min-w-0">
            <p className="type-footnote text-label-tertiary">
              Your box is named
            </p>
            <div className="flex items-center gap-2 mt-0.5">
              <Lock size={13} className="text-system-green" aria-hidden="true" />
              <span className="font-mono type-subheadline font-semibold text-label-primary truncate">
                {current.fqdn}
              </span>
            </div>
          </div>
        </div>

        {/* Rename — the quiet secondary affordance. Reveals the picker. */}
        <button
          type="button"
          onClick={startRename}
          className="inline-flex items-center gap-2 type-footnote font-semibold text-accent transition-colors hover:text-accent/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30 rounded-md px-1 -mx-1"
        >
          <Pencil size={15} aria-hidden="true" />
          Rename this address
        </button>

        <LearnMoreCard title="What the padlock means" helpAnchor="internet">
          <p>
            The padlock in your browser&rsquo;s address bar tells you two things:
            the connection to this box is <strong>encrypted</strong> (nobody on
            the network can read it), and the box is{" "}
            <strong>who it says it is</strong> — its identity was checked against
            a certificate a trusted authority signed.
          </p>
          <p>
            Renaming issues a fresh publicly-trusted certificate for the new
            address — a real green padlock, zero install, and nothing is ever
            published to the public internet.
          </p>
        </LearnMoreCard>
      </StepShell>
    );
  }

  // ── Mode: fresh pick OR rename — the name picker ──
  const renaming = mode === "rename";

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
      title={renaming ? "Rename your secure address" : "Name your secure address"}
      subtitle={
        renaming
          ? "Pick a new name for your box. We'll release the old address, claim the new one, and re-issue its padlock — nothing to install on any device."
          : "Your Droplet gives itself a private, publicly-trusted web address — pick the name you want and we'll check it's free. The padlock is real, with nothing to install on any device."
      }
      primary={{
        label: renaming ? "Rename" : "Continue",
        loadingLabel: renaming ? "Renaming…" : "Saving…",
        onClick: () => submitName(renaming ? renameBox : setBoxName),
        isLoading: saving,
        disabled: !isAvailable,
        showArrow: true,
        ariaDescribedBy: !isAvailable ? "box-name-status" : undefined,
      }}
      skip={
        renaming
          ? undefined
          : { label: "Skip — I'll do this later", onClick: onSkip }
      }
    >
      {/* Name input with the fixed .droplet-us.com suffix + live status glyph. */}
      <label className="block">
        <span className="type-subheadline text-label-secondary block mb-1.5">
          {renaming ? "Choose a new address" : "Choose your address"}
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
            autoFocus={renaming}
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

      {/* WARP-1109 — while renaming, name the address we're replacing so the
          owner sees exactly what's changing. */}
      {renaming && current && (
        <p className="type-footnote text-label-secondary mt-1.5">
          Replacing <span className="font-mono">{current.fqdn}</span>.
        </p>
      )}

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

      {/* Cancel — return to the current-address view without renaming. Quiet
          text button; only shown in the rename picker. */}
      {renaming && (
        <button
          type="button"
          onClick={cancelRename}
          className="type-footnote font-semibold text-label-tertiary transition-colors hover:text-label-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30 rounded-md px-1 -mx-1 mb-4"
        >
          Cancel
        </button>
      )}

      {/* Two reassurance tiles — ported from the handoff. Shown on the fresh
          pick; the rename picker keeps the surface tighter. */}
      {!renaming && (
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
              the same trusted address resolves on-site and over the VPN
            </div>
          </div>
        </div>
      )}

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
