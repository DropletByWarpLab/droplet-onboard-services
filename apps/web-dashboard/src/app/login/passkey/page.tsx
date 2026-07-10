"use client";

import {
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  KeyRound,
  Check,
  AlertTriangle,
  ArrowLeft,
  RefreshCw,
  type LucideIcon,
} from "lucide-react";
import type {
  PublicKeyCredentialRequestOptionsJSON,
  AuthenticationResponseJSON,
} from "@simplewebauthn/browser";
import { useAuth } from "@/lib/auth";
import type { AuthUser } from "@/lib/auth";
import { AuroraPanel } from "@/components/auth/AuroraPanel";
import { DropletMark } from "@/components/DropletMark";
import { safeNext } from "@/lib/safe-next";
import {
  isPasskeySupported,
  getPasskeyAuthenticationOptions,
  runPasskeyAuthenticationCeremony,
  verifyPasskeyAuthentication,
  cancelPasskeyCeremony,
} from "@/lib/webauthn";

/**
 * WARP-1054 — the dedicated passkey approval page (`/login/passkey`).
 *
 * Clicking "Sign in with a passkey" on /login lands here. This page owns the
 * whole passwordless ceremony that used to run invisibly behind the login form:
 * it explains what Droplet is waiting for, shows live status, and always offers
 * a way out (cancel, retry, or fall back to the password).
 *
 * The native credential UI — the Touch ID prompt, the security-key blink, the
 * QR code a phone scans — is BROWSER CHROME painted OVER this page. We can't
 * draw or restyle it. This page is the calm stage that sheet performs on: it is
 * deliberately legible even with a native sheet covering its centre third, and
 * it is the surface a future Droplet-app push approval (phase 2) will plug into
 * (which is why the waiting copy already speaks in terms of "your phone").
 *
 * The visuals, copy, tokens and motion are the design brief
 * (PASSKEY-APPROVAL-PAGE-DESIGN-BRIEF.md); copy here ships verbatim.
 */

type PasskeyState =
  | "starting" // fetching assertion options (options round-trip, usually <500ms)
  | "waiting" // browser ceremony in flight — the native sheet is up over us
  | "verifying" // assertion returned, server checking (brief)
  | "success" // verified — confirmation beat, then redirect
  | "failed" // one state, copy varies by cause
  | "unsupported" // direct nav on a browser without WebAuthn
  | "ready"; // contingency: browser refused to auto-start; explicit Continue

/** Why a `failed` state happened. NotAllowedError is deliberately opaque per the
 *  WebAuthn spec (dismiss vs. timeout vs. no-credential are indistinguishable),
 *  so `cancelled` folds dismiss + no-match, and `timeout` is inferred from the
 *  elapsed time against the options' own timeout. */
type FailCause = "cancelled" | "timeout" | "network" | "rejected";

/** Confirmation beat before redirecting on success (design brief §3.4). */
const SUCCESS_HOLD_MS = 600;
/** A NotAllowedError faster than this, on the FIRST auto-started attempt, is
 *  read as "the browser refused to auto-start" (some Safari builds require a
 *  user gesture) → fall back to the `ready` state rather than a scary failure. */
const AUTOSTART_REFUSED_MS = 350;
/** Within this margin of the options' timeout, a NotAllowedError is classified
 *  as a genuine timeout rather than a user dismiss (§3.5 elapsed-time heuristic). */
const TIMEOUT_MARGIN_MS = 3_000;
/** @simplewebauthn/server's generateAuthenticationOptions default (ms) — used
 *  only if the options response omits an explicit `timeout`. */
const DEFAULT_TIMEOUT_MS = 60_000;

/** True when the browser (or the OS) asks us to minimise motion. Guarded for
 *  jsdom, where `matchMedia` may be absent. */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true
  );
}

/** A WebAuthn `NotAllowedError` (dismiss / timeout / no matching passkey),
 *  possibly wrapped by @simplewebauthn/browser (check `.cause` too). */
function isNotAllowedError(err: unknown): boolean {
  const name = (e: unknown) =>
    typeof e === "object" && e !== null
      ? (e as { name?: unknown }).name
      : undefined;
  return (
    name(err) === "NotAllowedError" ||
    name((err as { cause?: unknown } | null)?.cause) === "NotAllowedError"
  );
}

/** True when the failure is a transport failure (box unreachable) rather than a
 *  server rejection. A dead orchestrator makes `fetch` throw a TypeError; a
 *  reachable box that rejects the passkey answers non-2xx, which postJson turns
 *  into a plain Error. */
function isNetworkError(err: unknown): boolean {
  if (err instanceof TypeError) return true;
  const msg =
    typeof err === "object" && err !== null
      ? String((err as { message?: unknown }).message ?? "")
      : "";
  return /failed to fetch|networkerror|load failed/i.test(msg);
}

/** Guidance paragraph for the `failed` state, chosen by cause (design brief §3.5,
 *  verbatim). The error is stated HERE — the page never also renders the login
 *  page's red error strip (one voice per state). */
function failGuidance(cause: FailCause): string {
  switch (cause) {
    case "timeout":
      return "The request timed out before a passkey was used. You can try again, or sign in with your password.";
    case "network":
      return "We couldn't reach your Droplet to finish signing in. Check that you're on your home network, then try again.";
    case "rejected":
      return "We couldn't verify that passkey. Try again, or use your password — if this keeps happening, you can manage passkeys in Settings after signing in.";
    case "cancelled":
    default:
      return "The passkey request was cancelled or no matching passkey was found on that device. You can try again, or sign in with your password.";
  }
}

type DiscVariant = "accent" | "success" | "failed" | "muted";
type Ring = "none" | "breathe" | "solid";

const DISC_TINT: Record<DiscVariant, string> = {
  accent: "bg-accent-subtle text-accent",
  success: "bg-system-green/10 text-system-green",
  failed: "bg-system-red/10 text-system-red",
  muted: "bg-surface-secondary text-label-tertiary",
};

/** The 72px (64px on mobile) status disc: an icon in a tinted circle. In
 *  `waiting` it gains a 2px accent ring that breathes; in `verifying` the ring
 *  holds solid. The disc + ring are decorative — the headline and guidance
 *  carry all meaning — so they stay out of the a11y tree. */
function StatusDisc({
  icon: Icon,
  variant,
  ring,
}: {
  icon: LucideIcon;
  variant: DiscVariant;
  ring: Ring;
}) {
  return (
    <div className="relative mx-auto mb-5 lg:mb-6 h-16 w-16 lg:h-[72px] lg:w-[72px]">
      <div
        className={`flex h-full w-full items-center justify-center rounded-full ${DISC_TINT[variant]}`}
      >
        {/* 28px below lg, 32px at lg+ (design brief §6). */}
        <Icon className="h-7 w-7 lg:h-8 lg:w-8" strokeWidth={1.5} aria-hidden="true" />
      </div>
      {/* The 2px accent ring sits 6px outside the disc; it breathes while
          waiting and holds solid while verifying. Frozen static under
          prefers-reduced-motion by the global rule in globals.css. */}
      {ring !== "none" && (
        <span
          aria-hidden="true"
          className={`pointer-events-none absolute -inset-1.5 rounded-full border-2 border-accent ${
            ring === "breathe" ? "animate-passkey-breathe" : ""
          }`}
        />
      )}
    </div>
  );
}

interface StateView {
  icon: LucideIcon;
  variant: DiscVariant;
  ring: Ring;
  headline: string;
  guidance: string;
}

function viewFor(state: PasskeyState, cause: FailCause | null): StateView {
  switch (state) {
    case "starting":
      return {
        icon: KeyRound,
        variant: "accent",
        ring: "none",
        headline: "Getting ready",
        guidance: "Contacting your Droplet…",
      };
    case "waiting":
      return {
        icon: KeyRound,
        variant: "accent",
        ring: "breathe",
        headline: "Approve this sign-in",
        guidance:
          "Use your passkey to continue — your screen lock on this device, a security key, or your phone. If your passkey is on your phone, check it now for a prompt or QR code.",
      };
    case "verifying":
      return {
        icon: KeyRound,
        variant: "accent",
        ring: "solid",
        headline: "Almost there",
        guidance: "Confirming with your Droplet…",
      };
    case "success":
      return {
        icon: Check,
        variant: "success",
        ring: "none",
        headline: "You're in",
        guidance: "Taking you to your dashboard…",
      };
    case "failed":
      return {
        icon: AlertTriangle,
        variant: "failed",
        ring: "none",
        headline: "That didn't go through",
        guidance: failGuidance(cause ?? "cancelled"),
      };
    case "unsupported":
      return {
        icon: KeyRound,
        variant: "muted",
        ring: "none",
        headline: "Passkeys aren't available here",
        guidance:
          "This browser doesn't support passkeys. Sign in with your password instead, or open this page in a browser that supports passkeys.",
      };
    case "ready":
      return {
        icon: KeyRound,
        variant: "accent",
        ring: "none",
        headline: "Sign in with your passkey",
        guidance:
          "Continue with your screen lock, a security key, or a passkey on your phone.",
      };
  }
}

/** The local-first reassurance line, shown in every state except success (the
 *  page is leaving on success). Same promise the login page makes. */
const REASSURANCE = "Sign-in happens on your local network — nothing leaves the box.";

function PasskeyApprovalInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { setUserFromPasskey } = useAuth();

  const [state, setState] = useState<PasskeyState>("starting");
  const [cause, setCause] = useState<FailCause | null>(null);

  // The raw `?next=` rides through untouched; we only resolve it with the shared
  // hardened guard at the moment we actually redirect (success), and we preserve
  // it verbatim when bailing back to /login.
  const rawNext = searchParams.get("next");
  const loginHref = "/login" + (rawNext ? `?next=${encodeURIComponent(rawNext)}` : "");

  // `aliveRef` flips false on unmount; `runSeqRef` tags each ceremony run so a
  // superseded/cancelled run's async continuation becomes a no-op (bulletproof
  // against React 18 StrictMode's mount→unmount→mount double-invoke, and against
  // a stale run writing state after Cancel/Try-again). A run is "current" only
  // while mounted AND it is the latest run.
  const aliveRef = useRef(true);
  const runSeqRef = useRef(0);
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  const runCeremony = useCallback(
    (auto: boolean) => {
      const myId = ++runSeqRef.current;
      const isCurrent = () => aliveRef.current && runSeqRef.current === myId;
      const fail = (c: FailCause) => {
        setCause(c);
        setState("failed");
      };

      setCause(null);
      setState("starting");

      void (async () => {
        // 1) starting — fetch the single-use assertion options.
        let options: PublicKeyCredentialRequestOptionsJSON;
        try {
          options = await getPasskeyAuthenticationOptions();
        } catch {
          if (!isCurrent()) return;
          fail("network");
          return;
        }
        if (!isCurrent()) return;

        // 2) waiting — raise the native sheet. This is the state the page exists
        //    for. Time it so a NotAllowedError can be classified.
        setState("waiting");
        const startedAt = performance.now();
        let assertion: AuthenticationResponseJSON;
        try {
          assertion = await runPasskeyAuthenticationCeremony(options);
        } catch (err) {
          if (!isCurrent()) return; // our own cancel/unmount — say nothing
          const elapsed = performance.now() - startedAt;
          if (isNotAllowedError(err)) {
            if (auto && elapsed < AUTOSTART_REFUSED_MS) {
              // Browser likely refused to auto-start without a user gesture —
              // offer an explicit Continue rather than a failure.
              setState("ready");
              return;
            }
            const timeoutMs =
              typeof options.timeout === "number"
                ? options.timeout
                : DEFAULT_TIMEOUT_MS;
            fail(elapsed >= timeoutMs - TIMEOUT_MARGIN_MS ? "timeout" : "cancelled");
          } else {
            // AbortError from our own cancel is already filtered by isCurrent();
            // anything else here is a generic ceremony failure.
            fail("cancelled");
          }
          return;
        }
        if (!isCurrent()) return;

        // 3) verifying — post the assertion; the server issues the cookie.
        setState("verifying");
        let user: AuthUser;
        try {
          user = await verifyPasskeyAuthentication(assertion);
        } catch (err) {
          if (!isCurrent()) return;
          fail(isNetworkError(err) ? "network" : "rejected");
          return;
        }
        if (!isCurrent()) return;

        // 4) success — hydrate the context; the redirect effect takes it home.
        setUserFromPasskey(user);
        setState("success");
      })();
    },
    [setUserFromPasskey],
  );

  // Mount: probe support and auto-start (the user just clicked a button on
  // /login, so activation is fresh). Direct nav / bookmark on a non-WebAuthn
  // browser skips the ceremony entirely and shows the unsupported state.
  useEffect(() => {
    aliveRef.current = true;
    if (!isPasskeySupported()) {
      setState("unsupported");
    } else {
      runCeremony(true);
    }
    return () => {
      aliveRef.current = false;
      runSeqRef.current += 1; // stale any in-flight run
      cancelPasskeyCeremony(); // abort the browser ceremony if the sheet is up
    };
  }, [runCeremony]);

  // Success → redirect after a short confirmation beat (skipped under reduced
  // motion). `replace`, not `push`, so Back doesn't land on a dead approval page.
  useEffect(() => {
    if (state !== "success") return;
    const dest = safeNext(rawNext);
    if (prefersReducedMotion()) {
      router.replace(dest);
      return;
    }
    const id = window.setTimeout(() => router.replace(dest), SUCCESS_HOLD_MS);
    return () => window.clearTimeout(id);
  }, [state, rawNext, router]);

  // A11y: move focus to the status heading on every state change so screen
  // readers announce the new state (the guidance region is also aria-live).
  // `preventScroll` so a focus mid-ceremony doesn't jump the viewport.
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, [state, cause]);

  // Cancel / "Use your password instead": stop any in-flight run from painting a
  // later state, abort the browser ceremony, and return to /login with ?next=
  // intact. An orphaned ceremony can otherwise keep the sheet up or reject after
  // we've navigated.
  const bailToLogin = useCallback(() => {
    runSeqRef.current += 1;
    cancelPasskeyCeremony();
    router.replace(loginHref);
  }, [router, loginHref]);

  const tryAgain = useCallback(() => runCeremony(false), [runCeremony]);

  const view = viewFor(state, cause);
  const isWaiting = state === "waiting";
  // verifying + success are transient (well under a second) and carry no
  // actions; success also drops the reassurance footer (the page is leaving).
  const hasActions = state !== "verifying" && state !== "success";
  const showFooter = state !== "success";

  return (
    <div className="min-h-dvh grid lg:grid-cols-[1.05fr_1fr] bg-surface-primary">
      <AuroraPanel className="hidden lg:flex" />

      {/* Right panel. The waiting state keeps its content top-aligned below lg
          (Cancel above the native bottom-sheet zone) and — via the column's
          own min-height + space-between at lg+ — spreads the headline high and
          Cancel low around a centered native sheet (design brief §3.2 / §6).
          Every other state is simply centered. */}
      <div
        className={`flex flex-col items-center p-6 sm:p-10 ${
          isWaiting
            ? "justify-start pt-12 sm:pt-16 lg:justify-center lg:pt-10"
            : "justify-center"
        }`}
      >
        {/* Compact wordmark — stands in for the brand panel below lg */}
        <div className="lg:hidden flex items-center gap-2 mb-8">
          <DropletMark size={24} className="text-accent" />
          <span className="type-headline text-label-primary">Droplet</span>
        </div>

        {/* Keyed by state so each transition replays the 200ms cross-fade
            (instant under prefers-reduced-motion via the global rule) and the
            focus effect re-runs. */}
        <div
          key={`${state}:${cause ?? ""}`}
          className={`w-full max-w-[380px] flex flex-col items-center text-center animate-passkey-state-in ${
            isWaiting ? "lg:min-h-[640px] lg:justify-between" : ""
          }`}
        >
          <div className="flex flex-col items-center">
            <StatusDisc icon={view.icon} variant={view.variant} ring={view.ring} />

            <h1
              ref={headingRef}
              tabIndex={-1}
              className="type-title-1 text-label-primary outline-none"
            >
              {view.headline}
            </h1>

            <p
              aria-live="polite"
              className="type-subheadline text-label-secondary mt-2.5 max-w-[340px] [text-wrap:pretty]"
            >
              {view.guidance}
            </p>
          </div>

          <div className="w-full flex flex-col items-center">
            {hasActions && (
              <div className="w-full flex flex-col items-center gap-3 mt-7">
                <StateActions
                  state={state}
                  onBail={bailToLogin}
                  onRetry={tryAgain}
                />
              </div>
            )}

            {showFooter && (
              <p className="type-caption-1 text-label-tertiary text-center mt-6">
                {REASSURANCE}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// Button treatments. Primary = the canonical accent `dp-btn-primary`. Secondary
// is neutral (surface-secondary + separator border) — matching SignInForm's SSO
// buttons and the design brief's secondary-button token — not the accent-tinted
// default `dp-btn-secondary`, so it reads as a calm "get me out" rather than a
// second call to action. The link is a footnote accent link (44px hit target).
const PK_PRIMARY = "dp-btn-primary w-full";
const PK_SECONDARY =
  "dp-btn-secondary w-full !bg-surface-secondary !text-label-primary border border-separator hover:border-label-tertiary/40";
const PK_LINK =
  "type-footnote font-medium text-accent hover:underline underline-offset-[3px] inline-flex items-center justify-center gap-1.5 min-h-[44px] self-center px-2";

/** The per-state action stack. Every state has at least one way out (there is
 *  no dead end), except the two transient states (verifying / success) which
 *  finish on their own in well under a second. */
function StateActions({
  state,
  onBail,
  onRetry,
}: {
  state: PasskeyState;
  onBail: () => void;
  onRetry: () => void;
}): ReactNode {
  const passwordLink = (
    <button type="button" onClick={onBail} className={PK_LINK}>
      Use your password instead
    </button>
  );

  switch (state) {
    case "starting":
      // Keep an exit visible from the first frame, where the buttons will land.
      return (
        <button type="button" onClick={onBail} className={PK_LINK}>
          <ArrowLeft size={13} aria-hidden="true" />
          Back to sign in
        </button>
      );
    case "waiting":
      return (
        <>
          <button type="button" onClick={onBail} className={PK_SECONDARY}>
            Cancel
          </button>
          {passwordLink}
        </>
      );
    case "ready":
      return (
        <>
          <button type="button" onClick={onRetry} className={PK_PRIMARY}>
            Continue
          </button>
          {passwordLink}
        </>
      );
    case "failed":
      return (
        <>
          <button type="button" onClick={onRetry} className={PK_PRIMARY}>
            <RefreshCw size={15} aria-hidden="true" />
            Try again
          </button>
          <button type="button" onClick={onBail} className={PK_SECONDARY}>
            Use your password instead
          </button>
        </>
      );
    case "unsupported":
      return (
        <button type="button" onClick={onBail} className={PK_PRIMARY}>
          <ArrowLeft size={15} aria-hidden="true" />
          Back to sign in
        </button>
      );
    case "verifying":
    case "success":
    default:
      return null;
  }
}

/**
 * The approval page reads `?next=` via `useSearchParams()`, which in the App
 * Router requires a `<Suspense>` boundary (same rationale as the login page —
 * without one Next opts the whole route into a client-side-rendering bailout and
 * ships a blank page until hydration). The boundary paints the brand shell
 * immediately while the search-param-dependent state machine resolves.
 */
export default function PasskeyApprovalPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-dvh grid lg:grid-cols-[1.05fr_1fr] bg-surface-primary">
          <AuroraPanel className="hidden lg:flex" />
          <div className="flex items-center justify-center p-6 sm:p-10">
            <div className="w-full max-w-[380px]">
              <div className="lg:hidden flex items-center gap-2 mb-8">
                <DropletMark size={24} className="text-accent" />
                <span className="type-headline text-label-primary">Droplet</span>
              </div>
              <div className="text-center">
                <div className="mx-auto mb-5 lg:mb-6 h-16 w-16 lg:h-[72px] lg:w-[72px] rounded-full bg-accent-subtle" />
                <h1 className="type-title-1 text-label-primary">Getting ready</h1>
              </div>
            </div>
          </div>
        </div>
      }
    >
      <PasskeyApprovalInner />
    </Suspense>
  );
}
