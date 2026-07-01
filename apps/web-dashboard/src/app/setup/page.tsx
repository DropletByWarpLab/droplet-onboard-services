"use client";

import { useCallback, useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import { patchSetupStep } from "@/lib/api";
import { DropletMark } from "@/components/DropletMark";
import { WelcomeStep } from "@/components/setup/steps/WelcomeStep";
import { ClaimStep } from "@/components/setup/steps/ClaimStep";
import { AccountStep } from "@/components/setup/steps/AccountStep";
import { OrgStep } from "@/components/setup/steps/OrgStep";
import { TwoFactorStep } from "@/components/setup/steps/TwoFactorStep";
import { WifiStep } from "@/components/setup/steps/WifiStep";
import { AddressStep } from "@/components/setup/steps/AddressStep";
import { StorageStep } from "@/components/setup/steps/StorageStep";
import { DiscoveryStep } from "@/components/setup/steps/DiscoveryStep";
import { CamerasStep } from "@/components/setup/steps/CamerasStep";
import { VpnStep } from "@/components/setup/steps/VpnStep";
import { AiStep } from "@/components/setup/steps/AiStep";
import { TeamStep } from "@/components/setup/steps/TeamStep";
import { DoneStep } from "@/components/setup/steps/DoneStep";
import { STEPS, type Step } from "@/components/setup/wizard-steps";
import { SetupNavProvider } from "@/components/setup/setup-nav";

/**
 * Customer-facing first-run wizard.
 *
 * PR #372 — `AuthGate` routes the customer here when the explicit
 * `/api/setup/state` machine reports the appliance is "unclaimed" (no
 * longer the stateless Nextcloud `installed` check). Once they land we
 * walk them through the wizard step machine, resuming at the persisted
 * `setupState.setupStep`.
 *
 * Each step is its own component under `components/setup/steps/`. This
 * page only owns:
 *   - the current step + cross-step values (displayName, discoveredCount)
 *     that later steps need to render
 *   - the per-step callback wiring that advances `step` on completion
 *
 * The 4-step base flow (welcome → account → discovery → done) shipped in
 * WARP-216 / WARP-298 / WARP-302. The walkthrough extension (WARP-174)
 * slots Internet / Storage / Cameras / VPN / AI between discovery and
 * done in subsequent commits — see `docs/SETUP_WIZARD_WALKTHROUGH.md`
 * and its addendum for the contract.
 *
 * PR #384 — the visual frame is the aurora left-rail `StepShell` (rail on
 * `lg+`, compact progress header below). Each step renders its own
 * `StepShell`; this page no longer paints a centered card or progress
 * dots. The rail's step list is derived from the shared `STEPS` list
 * (`components/setup/wizard-steps`), so the frame and this state machine
 * can never drift. The state machine (STEPS, resumeStepFrom,
 * patchSetupStep) is unchanged.
 */
// The `Step` union and the canonical `STEPS` order now live in
// `components/setup/wizard-steps.ts` (imported above). A Next.js App Router
// `page` module may only export an allow-listed set of names, so exporting
// `STEPS`/`Step` from here breaks `next build`. The list there stays the
// single source of truth the aurora rail derives from.

/**
 * PR #372 — the persisted `setupStep` comes from `/api/setup/state` via the
 * auth context. Resume there if it's a step this wizard can render; fall
 * back to welcome otherwise. With PR #381 every SETUP_STEPS value (claim /
 * org / team included) is now a renderable step. Keeps the resume target
 * congruent with the steps the wizard actually has — no blank screen.
 */
function resumeStepFrom(setupStep: string | undefined): Step {
  // Onboarding-Flow redesign — the orchestrator's Prisma `SetupStep` enum still
  // has the single `internet` value; the wizard splits it into `wifi` → `address`
  // (both client-only, like `twofactor`). A persisted `internet` therefore
  // resumes at the FIRST sub-step, `wifi`.
  if (setupStep === "internet") return "wifi";
  // `done` is resumable too (it used to fall back to `welcome`): the Done
  // screen is no longer an empty terminal — it owns the flourish + EMBEDDED
  // product tour (DoneStep phase machine), and AuthGate deliberately leaves
  // an authenticated owner on /setup while the tour is pending. Excluding it
  // resumed a mid-tour refresh at `welcome` and walked the owner back into a
  // wizard they had already finished. Re-rendering Done is safe:
  // `completeSetup` is an idempotent 200 on an already-ready appliance.
  if (setupStep && (STEPS as readonly string[]).includes(setupStep)) {
    return setupStep as Step;
  }
  return "welcome";
}

/**
 * Map a wizard step onto the value persisted to the orchestrator's
 * `/api/setup/state`. `wifi` and `address` are CLIENT-ONLY sub-steps of the
 * single `internet` `SetupStep` (the Prisma enum is deliberately not migrated
 * for a presentation split), so both persist as `internet`; everything else
 * persists under its own key. Resuming maps `internet` back to `wifi`
 * (`resumeStepFrom`). Keeping the enum untouched means the backend route's
 * `isSetupStep` validation never 400s on a step we send.
 */
function persistedStep(step: Step): string | null {
  if (step === "wifi" || step === "address") return "internet";
  // `twofactor` is client-only with NO SetupStep enum value at all (PR #375)
  // — unlike wifi/address there is nothing to map it to, and sending it gets
  // a silent 400 INVALID_SETUP_STEP on the fire-and-forget PATCH, leaving
  // the stored pointer one step stale (same bug PR #551 fixed). Persist
  // nothing; the pointer catches up on the next persisted step.
  if (step === "twofactor") return null;
  return step;
}

/**
 * WARP-867 — the resume gate. The step machine below hydrates its step from
 * `setupState.setupStep` in a useState INITIALIZER, which runs exactly once
 * on first render. AuthGate deliberately renders public pages before the
 * boot probes settle (the blank-login fix), so on every cold load of /setup
 * the context's `setupState` was still `null` at that first render — the
 * initializer saw `undefined`, resumed to "welcome", and the persisted step
 * was ignored for the whole session. A mid-wizard refresh (or a reboot)
 * always restarted the customer at the beginning, which is how the field
 * report's box walked itself back into the unsatisfiable account step.
 *
 * So: hold the wizard unmounted until the lifecycle probe resolves, showing
 * the same calm connecting/retry surface AuthGate uses for protected pages
 * (it suppresses that surface on public pages — this page owns it instead).
 * Once `setupState` is non-null we mount the machine exactly once with a
 * concrete `initialStep`; later context updates still never yank the
 * customer mid-wizard because the machine keeps its own state from there.
 */
export default function SetupPage() {
  const {
    setupState,
    setupProbeError,
    setupAutoRetrying,
    retrySetupProbe,
  } = useAuth();

  if (setupState == null) {
    return (
      <div className="grid min-h-dvh place-items-center bg-surface-primary p-4">
        <div role="status" aria-live="polite" className="text-center max-w-sm">
          <div
            className={`flex items-center justify-center mx-auto mb-3${
              setupProbeError === null || setupAutoRetrying
                ? " animate-pulse motion-reduce:animate-none"
                : ""
            }`}
          >
            <DropletMark size={32} className="text-accent" />
          </div>
          {setupProbeError === null || setupAutoRetrying ? (
            <>
              <p className="type-headline text-label-primary mb-2">
                Connecting to your Droplet…
              </p>
              <p className="type-subheadline text-label-tertiary">
                Picking up where you left off.
              </p>
            </>
          ) : (
            <>
              <p className="type-headline text-label-primary mb-2">
                Can&apos;t reach your appliance
              </p>
              <p className="type-subheadline text-label-tertiary mb-4">
                {setupProbeError}
              </p>
              <button
                type="button"
                onClick={() => {
                  void retrySetupProbe();
                }}
                className="rounded-full bg-accent px-5 py-2 text-on-accent type-subheadline"
              >
                Retry
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  return <SetupWizard initialStep={resumeStepFrom(setupState.setupStep)} />;
}

function SetupWizard({ initialStep }: { initialStep: Step }) {
  // Hydrate once from the persisted step (resumability). useState's
  // initializer runs only on first render, so later context updates don't
  // yank the customer back mid-wizard. The page above guarantees
  // `initialStep` was derived from a RESOLVED setup state (WARP-867).
  const [step, setStepState] = useState<Step>(initialStep);
  // Furthest step reached this session — drives the clickable rail so a step
  // the customer already completed stays navigable after they jump back to an
  // earlier one. Seeded from the resumed step so a refresh mid-wizard keeps
  // everything up to here unlocked. Not persisted: the orchestrator's
  // `setupStep` is the single resume pointer; "furthest reached" is session UI.
  const [maxReachedIdx, setMaxReachedIdx] = useState<number>(() =>
    Math.max(0, STEPS.indexOf(initialStep)),
  );
  const [displayName, setDisplayName] = useState("");
  const [discoveredCount, setDiscoveredCount] = useState(0);

  // Refs mirror the nav state so setStep/autoSkip/back stay identity-stable
  // (deps []) without reading stale closures.
  const stepRef = useRef<Step>(step);
  const maxReachedRef = useRef<number>(maxReachedIdx);
  // Visited-step stack for the Back button. Auto-skipped hardware steps
  // (storage/cameras with nothing to show) are NOT pushed here, so Back skips
  // over them instead of landing on a step that immediately auto-skips forward
  // again — the "Back goes back too far / bounces" report.
  const historyRef = useRef<Step[]>([]);

  // Forward + rail navigation. Records the step we're leaving (for Back) and
  // persists the resume pointer ONLY when advancing past the furthest-reached
  // step. Persisting on a BACKWARD jump would lower the stored pointer, so a
  // mid-wizard refresh would re-seed `maxReachedIdx` lower and re-lock every
  // completed step past it (PR #518 review: the pointer must be monotonic).
  const setStep = useCallback((next: Step) => {
    const cur = stepRef.current;
    if (cur !== next && STEPS.indexOf(next) > STEPS.indexOf(cur)) historyRef.current = [...historyRef.current, cur];
    setStepState(next);
    stepRef.current = next;
    const nextIdx = STEPS.indexOf(next);
    if (nextIdx > maxReachedRef.current) {
      maxReachedRef.current = nextIdx;
      setMaxReachedIdx(nextIdx);
      // Fire-and-forget; local progress is never gated on the round-trip.
      // wifi/address persist as the `internet` SetupStep; twofactor persists
      // nothing (see persistedStep).
      const persisted = persistedStep(next);
      if (persisted !== null) void patchSetupStep(persisted);
    }
  }, []);

  // A hardware step (storage/cameras) auto-skipping itself on mount because it
  // has nothing to show. Same forward move + monotonic persist as setStep, but
  // it does NOT record history — so Back skips straight over the transparent
  // step rather than bouncing on it.
  const autoSkip = useCallback((next: Step) => {
    setStepState(next);
    stepRef.current = next;
    const nextIdx = STEPS.indexOf(next);
    if (nextIdx > maxReachedRef.current) {
      maxReachedRef.current = nextIdx;
      setMaxReachedIdx(nextIdx);
      const persisted = persistedStep(next);
      if (persisted !== null) void patchSetupStep(persisted);
    }
  }, []);

  // Back button. Pops the visited stack (auto-skipped steps were never pushed,
  // so they're skipped); falls back to the previous step in STEPS when there's
  // no recorded history (e.g. resumed mid-wizard after a refresh). Never lowers
  // the persisted pointer. Clamped to firstNavigableIdx ("org") so that
  // welcome/claim/account can never be reached via direct back() calls (e.g.
  // a future keyboard handler) independently of the UI guard in StepShell.
  const back = useCallback(() => {
    const floor = STEPS.indexOf("org");
    const h = historyRef.current;
    if (h.length > 0) {
      const prev = h[h.length - 1];
      if (STEPS.indexOf(prev) < floor) return;
      historyRef.current = h.slice(0, -1);
      setStepState(prev);
      stepRef.current = prev;
      return;
    }
    const i = STEPS.indexOf(stepRef.current);
    if (i > 0) {
      const target = STEPS[i - 1];
      if (STEPS.indexOf(target) < floor) return;
      setStepState(target);
      stepRef.current = target;
    }
  }, []);

  // PR #384 — each step paints its own full-bleed aurora-rail `StepShell`, so
  // the page is just the step switch. The terminal `done` step is the
  // exception: it's a centered celebration (WelcomeFlourish), so it gets its
  // own centering wrapper rather than the rail frame.
  if (step === "done") {
    return (
      <div className="grid min-h-dvh place-items-center bg-surface-primary p-4">
        <DoneStep displayName={displayName} discoveredCount={discoveredCount} />
      </div>
    );
  }

  return (
    <SetupNavProvider
      value={{
        navigate: setStep,
        maxReachedIdx,
        back,
        // WARP-929 — the Workspace step is the navigation floor: claim/account
        // (and welcome) can't be revisited, so the appliance can't be unclaimed
        // and the owner can't be re-created/abandoned from the wizard.
        firstNavigableIdx: STEPS.indexOf("org"),
      }}
    >
      {step === "welcome" && (
        <WelcomeStep onContinue={() => setStep("claim")} />
      )}

      {step === "claim" && (
        <ClaimStep onComplete={() => setStep("account")} />
      )}

      {step === "account" && (
        <AccountStep
          onComplete={(name) => {
            setDisplayName(name);
            setStep("org");
          }}
        />
      )}

      {step === "org" && <OrgStep onComplete={() => setStep("twofactor")} />}

      {step === "twofactor" && (
        <TwoFactorStep
          onComplete={() => setStep("wifi")}
          onSkip={() => setStep("wifi")}
        />
      )}

      {step === "wifi" && (
        <WifiStep
          onComplete={() => setStep("address")}
          onSkip={() => setStep("address")}
        />
      )}

      {step === "address" && (
        <AddressStep
          onComplete={() => setStep("storage")}
          onSkip={() => setStep("storage")}
        />
      )}

      {step === "storage" && (
        <StorageStep
          onComplete={() => setStep("discovery")}
          onSkip={() => setStep("discovery")}
          onAutoSkip={() => autoSkip("discovery")}
        />
      )}

      {step === "discovery" && (
        <DiscoveryStep
          onContinue={(count) => {
            setDiscoveredCount(count);
            setStep("cameras");
          }}
        />
      )}

      {step === "cameras" && (
        <CamerasStep
          onComplete={() => setStep("vpn")}
          onSkip={() => setStep("vpn")}
          onAutoSkip={() => autoSkip("vpn")}
        />
      )}

      {step === "vpn" && (
        <VpnStep
          onComplete={() => setStep("ai")}
          onSkip={() => setStep("ai")}
          onBackToAddress={() => setStep("address")}
        />
      )}

      {step === "ai" && (
        <AiStep
          onComplete={() => setStep("team")}
          onSkip={() => setStep("team")}
        />
      )}

      {step === "team" && (
        <TeamStep
          onComplete={() => setStep("done")}
          onSkip={() => setStep("done")}
        />
      )}
    </SetupNavProvider>
  );
}
