"use client";

/**
 * WelcomeFlourish — multi-phase completion animation shown after a successful
 * signup or invite acceptance. The choreography (per WARP-216 spec):
 *
 *   Phase 1 (0–500ms)    soft-green ring fades in; check stroke draws via
 *                        framer-motion `pathLength: 0 → 1` (ease-out).
 *   Phase 2 (500–900ms)  ring expands and check fades; logo cross-fades in
 *                        with a real spring (stiffness 220, damping 20).
 *   Phase 3 (900–1200ms) "Welcome, {displayName}" + subtitle + countdown bar
 *                        fade-up, subtitle staggered ~80ms after the heading.
 *   Phase 4 (1200–2500ms) Progress bar drains; on completion we fire
 *                        `onComplete` and `router.push(redirectTo)`.
 *
 * Reduced-motion path: when `useReducedMotion()` returns true we skip phases
 * 1–3 and render the final state immediately, then redirect after 1500ms.
 *
 * All visuals compose from design tokens (no raw hex / px font-size).
 */

import { useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { motion, useReducedMotion } from "framer-motion";
import { DropletMark } from "@/components/DropletMark";

export interface WelcomeFlourishProps {
  /** Used in "Welcome, {displayName}" headline. Falls back to "You're all set". */
  displayName?: string;
  /** Second-line copy. Defaults to "Your Droplet is ready." */
  subtitle?: string;
  /**
   * Where to push after the timer elapses. Defaults to "/". Pass `null` when
   * the parent owns navigation (e.g. DoneStep sequencing into the embedded
   * tour, #9) — then only `onComplete` fires and no internal push happens.
   */
  redirectTo?: string | null;
  /** How long the full motion phase lasts before redirect. Defaults to 2500ms. */
  redirectAfterMs?: number;
  /** Fires once when the redirect timer elapses OR Skip is clicked. */
  onComplete?: () => void;
}

const REDUCED_MOTION_DELAY_MS = 1500;
const PHASE_2_START = 0.5; // s
const PHASE_3_START = 0.9; // s
const PHASE_3_END = 1.2; // s

export function WelcomeFlourish({
  displayName,
  subtitle = "Your Droplet is ready.",
  redirectTo = "/",
  redirectAfterMs = 2500,
  onComplete,
}: WelcomeFlourishProps) {
  const router = useRouter();
  const reduced = useReducedMotion();
  // Guard against double-firing (e.g. user clicks Skip and the timer also
  // resolves before the component unmounts).
  const firedRef = useRef(false);

  // WARP-298: the setup welcome step already shows an <h1>"Welcome to Droplet";
  // duplicating it inside this flourish reads as a glitch. Fallback to a
  // distinct "you're done" line when displayName is missing.
  const headline = displayName ? `Welcome, ${displayName}` : "You're all set";

  const handleComplete = useCallback(() => {
    if (firedRef.current) return;
    firedRef.current = true;
    onComplete?.();
    // `redirectTo === null` → the parent owns navigation; don't push.
    if (redirectTo !== null) {
      router.push(redirectTo);
    }
  }, [onComplete, router, redirectTo]);

  useEffect(() => {
    const wait = reduced ? REDUCED_MOTION_DELAY_MS : redirectAfterMs;
    const id = setTimeout(handleComplete, wait);
    return () => clearTimeout(id);
  }, [reduced, redirectAfterMs, handleComplete]);

  // The progress-bar drain is timed against the *remaining* window after
  // phase 3 ends, so it visually arrives at empty exactly as the redirect
  // fires. Falls back to redirectAfterMs if the user ships an unusually
  // short window.
  const progressDuration = Math.max(
    0.4,
    (redirectAfterMs - PHASE_3_END * 1000) / 1000,
  );

  return (
    <div
      data-testid="welcome-flourish"
      className="text-center w-full max-w-md mx-auto"
      role="status"
      aria-live="polite"
    >
      <div className="relative w-20 h-20 mx-auto mb-6">
        {reduced ? (
          // Reduced-motion: render the final logo state instantly, no draw.
          <div className="absolute inset-0 flex items-center justify-center">
            <DropletMark size={56} className="text-accent" />
          </div>
        ) : (
          <>
            {/* Phase 1: soft green ring fades in & scales gently. */}
            <motion.div
              aria-hidden
              className="absolute inset-0 rounded-full bg-system-green/10"
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{
                opacity: [0, 1, 1, 0],
                scale: [0.8, 1, 1.08, 1.12],
              }}
              transition={{
                duration: PHASE_2_START + 0.4,
                times: [0, 0.45, 0.7, 1],
                ease: "easeOut",
              }}
            />

            {/* Phase 1: drawn checkmark inside the ring. */}
            <motion.svg
              aria-hidden
              viewBox="0 0 24 24"
              className="absolute inset-0 w-full h-full p-5 text-system-green"
              initial={{ opacity: 1 }}
              animate={{ opacity: [1, 1, 0] }}
              transition={{
                duration: PHASE_2_START + 0.3,
                times: [0, 0.65, 1],
                ease: "easeOut",
              }}
            >
              <motion.path
                d="M5 13 L10 18 L19 8"
                fill="none"
                stroke="currentColor"
                strokeWidth={3}
                strokeLinecap="round"
                strokeLinejoin="round"
                initial={{ pathLength: 0 }}
                animate={{ pathLength: 1 }}
                transition={{ duration: 0.45, ease: "easeOut" }}
              />
            </motion.svg>

            {/* Phase 2: logo cross-fades in with a spring. */}
            <motion.div
              className="absolute inset-0 flex items-center justify-center"
              initial={{ opacity: 0, scale: 0.85 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{
                delay: PHASE_2_START,
                type: "spring",
                stiffness: 220,
                damping: 20,
              }}
            >
              <DropletMark size={56} className="text-accent" />
            </motion.div>
          </>
        )}
      </div>

      {/* Phase 3: welcome heading. */}
      <motion.h1
        className="type-large-title text-label-primary mb-2"
        initial={reduced ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: reduced ? 0 : PHASE_3_START, duration: 0.3, ease: "easeOut" }}
      >
        {headline}
      </motion.h1>

      <motion.p
        className="type-subheadline text-label-tertiary mb-8"
        initial={reduced ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{
          delay: reduced ? 0 : PHASE_3_START + 0.08,
          duration: 0.3,
          ease: "easeOut",
        }}
      >
        {subtitle}
      </motion.p>

      {/* Phase 4: countdown progress bar drains to empty as redirect fires. */}
      {!reduced && (
        <div
          aria-hidden
          className="w-full h-1 rounded-full bg-separator/60 overflow-hidden mb-4"
        >
          <motion.div
            className="h-full origin-left bg-accent/60"
            initial={{ scaleX: 1 }}
            animate={{ scaleX: 0 }}
            transition={{
              delay: PHASE_3_END,
              duration: progressDuration,
              ease: "linear",
            }}
          />
        </div>
      )}

      <button
        type="button"
        onClick={handleComplete}
        className="type-subheadline text-label-tertiary hover:text-label-secondary py-2 transition-colors"
      >
        Skip
      </button>
    </div>
  );
}
