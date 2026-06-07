"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { motion, useReducedMotion } from "framer-motion";
import { ArrowLeft, ArrowRight, Cpu, FolderOpen, Globe, Video } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { DropletMark } from "@/components/DropletMark";

/**
 * Each step renders its own glyph. A render function (rather than a bare
 * component type) lets a Lucide icon and the bespoke DropletMark coexist
 * without forcing one into the other's prop contract — Lucide's `size` is
 * `string | number`, DropletMark's is `number`, so a shared component type
 * would need a cast. The 26px size lives here at the single call site.
 */
type StepGlyph = (className: string) => ReactNode;

/**
 * Post-setup product tour (PR #382). A focused, full-screen guided
 * walkthrough shown exactly once after the owner finishes the first-run
 * wizard — AuthGate routes a claimed-but-tour-pending owner here, and on
 * finish/skip we persist `userTourCompleted` (via the auth context's
 * completeTour → PATCH /api/setup/state) so the dashboard takes over and the
 * tour never re-traps.
 *
 * Design discipline:
 *   - Tokens only (dp-card / dp-btn-* / type-* / text-label-* /
 *     bg-surface-* / text-accent). No raw hex, no freelance font sizes.
 *   - Offline-first copy, same vocabulary as the wizard + WizardReplay
 *     (ADR-002): files/AI/cameras/remote-access stay on the box; no cloud
 *     or "sync account" language.
 *   - Restrained motion (Emil-Kowalski lens for a home-user surface): a
 *     single short cross-fade/translate per step, fully gated behind
 *     useReducedMotion. No bouncing, no looping, nothing playful.
 *
 * Resumability: the active step index is persisted to localStorage so a
 * refresh mid-tour resumes where the owner was, not back at step 1.
 */

export interface TourStep {
  /** Stable key — also drives the localStorage resume + React keys. */
  key: string;
  /** Renders the step's glyph with the passed token className. */
  glyph: StepGlyph;
  title: string;
  body: string;
}

/**
 * The walkthrough. Five steps: a welcome framing, then the four core
 * privacy-positioning beats the customer saw as cards on first run, now
 * paced one-at-a-time so the post-setup moment reads as a guided tour
 * rather than a wall of cards.
 */
export const TOUR_STEPS: readonly TourStep[] = [
  {
    key: "welcome",
    glyph: (cn) => <DropletMark size={26} className={cn} />,
    title: "Welcome to your Droplet",
    body: "Everything you set up runs on this box, right here on your network. Take a minute to see what that actually means — files, AI, cameras, and remote access, all private by default.",
  },
  {
    key: "files",
    glyph: (cn) => <FolderOpen size={26} className={cn} />,
    title: "Your files live here, not in the cloud",
    body: "When you upload a photo or document, it's stored on this Droplet's drives — no copies in someone else's data centre. If the Droplet is offline, the only thing affected is access. Your files don't disappear.",
  },
  {
    key: "ai",
    glyph: (cn) => <Cpu size={26} className={cn} />,
    title: "The AI runs on your hardware",
    body: "The local models run on the GPU inside this box. Your questions, the model's answers, the whole conversation — none of it leaves the Droplet. Cloud models are an explicit opt-in with your own API key, never the default.",
  },
  {
    key: "cameras",
    glyph: (cn) => <Video size={26} className={cn} />,
    title: "Your camera footage stays put",
    body: "Cameras record straight to the Droplet's Frigate NVR. Review footage, get motion alerts, grant remote access — but the video never streams out to a cloud service. You can isolate cameras on their own network from the Cameras page.",
  },
  {
    key: "remote",
    glyph: (cn) => <Globe size={26} className={cn} />,
    title: "Remote access is end-to-end encrypted",
    body: "Off your home Wi-Fi, your phone reaches the Droplet over WireGuard — a modern VPN whose keys you generated on the box itself. Add a device from the Remote Access page and scan one QR code to connect.",
  },
];

const RESUME_KEY = "droplet-tour-step";

/** Read the persisted resume index, clamped to the valid step range. */
function readResumeIndex(): number {
  if (typeof window === "undefined") return 0;
  try {
    const raw = window.localStorage.getItem(RESUME_KEY);
    if (raw === null) return 0;
    const n = Number.parseInt(raw, 10);
    if (Number.isNaN(n)) return 0;
    return Math.min(Math.max(n, 0), TOUR_STEPS.length - 1);
  } catch {
    return 0;
  }
}

export function ProductTour({ onComplete }: { onComplete?: () => void } = {}) {
  const router = useRouter();
  const reduced = useReducedMotion();
  const { completeTour } = useAuth();

  // Hydrate once from the persisted step (resumability). useState's
  // initializer runs only on first render.
  const [index, setIndex] = useState<number>(() => readResumeIndex());
  // Guard the finish path so a double-click (or Skip racing the last Next)
  // can't fire completeTour + navigate twice.
  const finishedRef = useRef(false);

  // Persist the active step so a refresh resumes here.
  useEffect(() => {
    try {
      window.localStorage.setItem(RESUME_KEY, String(index));
    } catch {
      /* private mode — resume just falls back to step 1, acceptable */
    }
  }, [index]);

  const isFirst = index === 0;
  const isLast = index === TOUR_STEPS.length - 1;
  const step = TOUR_STEPS[index];

  const finish = useCallback(async () => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    // Clear the resume marker so a later replay (from Help) starts clean.
    try {
      window.localStorage.removeItem(RESUME_KEY);
    } catch {
      /* ignore */
    }
    // Persist completion (optimistic in-memory flip + server PATCH). Never
    // rejects; routes onward regardless of the round-trip.
    await completeTour();
    // When embedded (e.g. on the Done screen, #9) the parent owns post-tour
    // navigation — call onComplete and skip our own push so we don't
    // double-navigate. Standalone (/tour route) falls back to pushing "/".
    if (onComplete) {
      onComplete();
    } else {
      router.push("/");
    }
  }, [completeTour, router, onComplete]);

  const next = useCallback(() => {
    if (isLast) {
      void finish();
      return;
    }
    setIndex((i) => Math.min(i + 1, TOUR_STEPS.length - 1));
  }, [isLast, finish]);

  const back = useCallback(() => {
    setIndex((i) => Math.max(i - 1, 0));
  }, []);

  return (
    <div className="min-h-dvh bg-surface-primary flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Progress dots — quiet, accent only on the active step. */}
        <div
          className="flex items-center justify-center gap-1.5 mb-8"
          aria-hidden="true"
        >
          {TOUR_STEPS.map((s, i) => (
            <span
              key={s.key}
              className={`h-1.5 rounded-full transition-all duration-300 ease-smooth ${
                i === index
                  ? "w-6 bg-accent"
                  : i < index
                    ? "w-1.5 bg-accent/40"
                    : "w-1.5 bg-separator"
              }`}
            />
          ))}
        </div>

        <div className="dp-card p-8 text-center">
          <div
            className="w-14 h-14 rounded-2xl bg-accent/10 flex items-center justify-center mx-auto mb-6"
            aria-hidden="true"
          >
            {step.glyph("text-accent")}
          </div>

          {/* Re-key the body on `index` so the cross-fade replays per step.
              motion is fully neutralized under reduced-motion. */}
          <motion.div
            key={step.key}
            initial={reduced ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: reduced ? 0 : 0.28, ease: [0.25, 0.1, 0.25, 1] }}
          >
            <p className="type-footnote text-label-tertiary mb-2">
              Step {index + 1} of {TOUR_STEPS.length}
            </p>
            <h1 className="type-title-2 text-label-primary mb-3">
              {step.title}
            </h1>
            <p className="type-body text-label-secondary">{step.body}</p>
          </motion.div>

          <div className="flex items-center justify-between gap-3 mt-8">
            {isFirst ? (
              <span aria-hidden="true" />
            ) : (
              <button
                type="button"
                onClick={back}
                className="dp-btn-secondary"
              >
                <ArrowLeft size={16} aria-hidden="true" />
                Back
              </button>
            )}

            <button
              type="button"
              onClick={next}
              className="dp-btn-primary ml-auto"
            >
              {isLast ? "Go to dashboard" : "Next"}
              {!isLast && <ArrowRight size={16} aria-hidden="true" />}
            </button>
          </div>
        </div>

        <div className="text-center mt-4">
          <button
            type="button"
            onClick={() => void finish()}
            className="type-subheadline text-label-tertiary hover:text-label-secondary py-2 transition-colors"
          >
            Skip the tour
          </button>
        </div>
      </div>
    </div>
  );
}
