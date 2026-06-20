"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { motion, useReducedMotion } from "framer-motion";
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Check,
  Cpu,
  Folder,
  FolderOpen,
  Globe,
  Lock,
  Smartphone,
  Sparkles,
  Video,
  Wifi,
  HardDrive,
  Lightbulb,
  ShieldCheck,
  User,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { fetchVpnStatus } from "@/lib/api";
import { DropletMark } from "@/components/DropletMark";

/**
 * Each step renders its own glyph. A render function (rather than a bare
 * component type) lets a Lucide icon and the bespoke DropletMark coexist
 * without forcing one into the other's prop contract.
 */
type StepGlyph = (className: string) => ReactNode;

/**
 * Post-setup product walkthrough — the Done-step beats (PR #382, restyled for
 * the Onboarding-Flow redesign). A paced, one-beat-at-a-time recap of what the
 * owner just set up, shown once after the first-run wizard. AuthGate routes a
 * claimed-but-tour-pending owner here; on finish/skip we persist
 * `userTourCompleted` (auth context `completeTour` → PATCH /api/setup/state) so
 * the dashboard takes over and it never re-traps.
 *
 * Onboarding-Flow redesign — each beat now carries an illustrative MOTIF (a
 * recap of configured surfaces, a files list, an on-device AI exchange, camera
 * tiles, a remote-access card) so the privacy positioning lands visually, not
 * just as a paragraph. Mirrors `redesign/OnbWizard.jsx` SetDone. Clickable beat
 * dots let the owner jump between beats; "Go to dashboard" finishes.
 *
 * Design discipline: tokens only (dp-card / type-* / text-label-* /
 * bg-surface-* / text-accent / system-* status colors). Offline-first copy
 * (ADR-002). Restrained motion — a single short cross-fade per beat, fully
 * gated behind `useReducedMotion`.
 *
 * Resumability: the active beat index persists to localStorage so a refresh
 * mid-walkthrough resumes where the owner was.
 */

export interface TourStep {
  /** Stable key — also drives the localStorage resume + React keys. */
  key: string;
  /** Renders the beat's header glyph with the passed token className. */
  glyph: StepGlyph;
  /** Short uppercase kicker above the title (e.g. "Private AI"). */
  kicker: string;
  title: string;
  body: string;
  /** Illustrative motif rendered under the copy. */
  motif: () => ReactNode;
}

// ── Beat motifs ────────────────────────────────────────────────────
// Static, illustrative recaps that make each privacy beat land visually.
// Token-only; no fixtures, no live data — this is a celebratory recap.

function MotifRecap() {
  const pills: [typeof User, string][] = [
    [User, "Account"],
    [Wifi, "Wi-Fi"],
    [Globe, "Internet address"],
    [HardDrive, "Drives"],
    [Lightbulb, "Smart home"],
    [Camera, "Cameras"],
    [ShieldCheck, "Remote access"],
    [Sparkles, "Private AI"],
  ];
  return (
    <div className="w-full rounded-[14px] border border-separator bg-surface-secondary p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="flex h-5 w-5 flex-none items-center justify-center rounded-full bg-system-green/15 text-system-green">
          <Check size={12} aria-hidden="true" />
        </span>
        <span className="type-caption-1 font-bold text-label-secondary">
          Everything configured
        </span>
        <span className="type-caption-2 ml-auto text-label-tertiary">
          droplet-rack-1 · online
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        {pills.map(([Icon, label]) => (
          <span
            key={label}
            className="inline-flex items-center gap-1.5 rounded-full border border-separator bg-surface-primary px-2.5 py-1 type-caption-1 font-semibold text-label-secondary"
          >
            <Icon size={13} className="text-accent" aria-hidden="true" />
            {label}
            <Check size={12} className="text-system-green" aria-hidden="true" />
          </span>
        ))}
      </div>
    </div>
  );
}

function MotifFiles() {
  const rows: [string, string][] = [
    ["Wedding Photos", "482 GB"],
    ["Camera Footage", "1.2 TB"],
    ["Client Backups", "96 GB"],
  ];
  return (
    <div className="w-full overflow-hidden rounded-[14px] border border-separator bg-surface-primary text-left">
      <div className="flex items-center gap-2 border-b border-separator bg-surface-secondary px-3.5 py-2.5">
        <FolderOpen size={15} className="text-accent" aria-hidden="true" />
        <span className="type-caption-1 font-semibold text-label-secondary">
          Files · on this Droplet
        </span>
        <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-system-green/15 px-2 py-0.5 type-caption-2 font-semibold text-system-green">
          local
        </span>
      </div>
      {rows.map(([name, size], i) => (
        <div
          key={name}
          className={`flex items-center gap-3 px-3.5 py-2.5 ${
            i ? "border-t border-separator" : ""
          }`}
        >
          <Folder size={16} className="text-accent" aria-hidden="true" />
          <span className="flex-1 type-footnote font-semibold text-label-primary">
            {name}
          </span>
          <span className="type-caption-1 font-mono text-label-tertiary">
            {size}
          </span>
        </div>
      ))}
    </div>
  );
}

function MotifAi() {
  return (
    <div className="flex w-full flex-col gap-2.5 rounded-[14px] border border-separator bg-surface-secondary p-4 text-left">
      <div className="max-w-[78%] self-end rounded-[12px_12px_4px_12px] bg-accent px-3.5 py-2 type-footnote text-on-accent">
        What can you help me with on this box?
      </div>
      <div className="max-w-[85%] self-start rounded-[12px_12px_12px_4px] border border-separator bg-surface-primary px-3.5 py-2">
        <div className="mb-1 flex items-center gap-1.5">
          <Sparkles size={12} className="text-accent" aria-hidden="true" />
          <span className="type-caption-2 font-bold text-label-secondary">
            On-device model
          </span>
          <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-system-green/15 px-1.5 py-0.5 type-caption-2 font-semibold text-system-green">
            on-device
          </span>
        </div>
        <p className="type-footnote text-label-secondary">
          Find files, summarize footage, draft emails — and none of it leaves
          this box.
        </p>
      </div>
    </div>
  );
}

function MotifCameras() {
  return (
    <div className="grid w-full grid-cols-2 gap-3">
      {["Front door", "Driveway"].map((label) => (
        <div
          key={label}
          className="relative h-[104px] overflow-hidden rounded-[12px] border border-separator bg-label-primary/90"
        >
          <span className="absolute inset-0 flex items-center justify-center text-white/15">
            <Camera size={34} aria-hidden="true" />
          </span>
          <div className="absolute left-2.5 top-2.5 flex items-center gap-1.5">
            <span
              className="h-1.5 w-1.5 rounded-full bg-system-red"
              aria-hidden="true"
            />
            <span className="type-caption-2 font-bold tracking-[0.08em] text-white">
              REC
            </span>
          </div>
          <span className="absolute right-2.5 top-2.5 rounded bg-white/20 px-1.5 py-0.5 type-caption-2 font-bold tracking-[0.08em] text-white">
            LOCAL
          </span>
          <span className="absolute bottom-2 left-2.5 type-caption-1 font-semibold text-white">
            {label}
          </span>
        </div>
      ))}
    </div>
  );
}

// Two remote-access motifs, chosen at render by the live ADR-023 signal
// (`VpnStatusInfo.publicFqdn`). Until the box learns its publicly-trusted
// per-device FQDN from HQ, we show the WireGuard/DuckDNS baseline; once it
// has one, we show the real one-URL-everywhere address with a green padlock.

function MotifRemoteVpn() {
  return (
    <div className="flex w-full items-center gap-4 rounded-[14px] border border-separator bg-surface-secondary p-4 text-left">
      <div className="flex h-[88px] w-[88px] flex-none items-center justify-center rounded-[12px] border border-separator bg-surface-primary text-label-primary">
        {/* Decorative QR-ish glyph; the real QR is minted on the Remote Access page. */}
        <Smartphone size={40} aria-hidden="true" />
      </div>
      <div className="min-w-0">
        <div className="mb-1 flex items-center gap-2">
          <Smartphone size={15} className="text-label-tertiary" aria-hidden="true" />
          <span className="type-footnote font-semibold text-label-primary">
            Your phone
          </span>
          <span className="inline-flex items-center gap-1 rounded-full bg-system-green/15 px-2 py-0.5 type-caption-2 font-semibold text-system-green">
            connected
          </span>
        </div>
        <div className="type-caption-1 font-mono text-label-secondary">
          yourstudio.duckdns.org
        </div>
        <div className="mt-1.5 type-caption-1 text-label-tertiary">
          WireGuard · keys generated on the box
        </div>
      </div>
    </div>
  );
}

function MotifRemoteFqdn({ fqdn }: { fqdn: string }) {
  return (
    <div className="flex w-full flex-col gap-3 rounded-[14px] border border-separator bg-surface-secondary p-4 text-left">
      {/* A browser address bar: the box's real publicly-trusted URL with a green
          padlock, resolving the same on home Wi-Fi and over the WireGuard tunnel
          (ADR-023 split-horizon). The opaque per-device name carries no PII. */}
      <div className="flex items-center gap-2 rounded-full border border-separator bg-surface-primary px-3 py-2">
        <Lock size={14} className="flex-none text-system-green" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate type-caption-1 font-mono text-label-secondary">
          {fqdn}
        </span>
        <span className="inline-flex flex-none items-center gap-1 rounded-full bg-system-green/15 px-2 py-0.5 type-caption-2 font-semibold text-system-green">
          trusted
        </span>
      </div>
      <div className="flex items-center gap-2">
        <Smartphone size={15} className="flex-none text-label-tertiary" aria-hidden="true" />
        <span className="type-caption-1 text-label-secondary">
          Same secure address at home and away
        </span>
        <span className="ml-auto inline-flex flex-none items-center gap-1 type-caption-1 text-label-tertiary">
          <ShieldCheck size={13} aria-hidden="true" />
          WireGuard
        </span>
      </div>
    </div>
  );
}

/**
 * The walkthrough. Five beats: a welcome framing, then the four core
 * privacy-positioning beats — paced one at a time, each with its motif.
 */
export const TOUR_STEPS: readonly TourStep[] = [
  {
    key: "welcome",
    glyph: (cn) => <DropletMark size={26} className={cn} />,
    kicker: "You're all set",
    title: "Your Droplet is live",
    body: "Everything you just set up runs on this box, right here on your network. Take a minute to see what that actually means — files, AI, cameras, and remote access, all private by default.",
    motif: () => <MotifRecap />,
  },
  {
    key: "files",
    glyph: (cn) => <FolderOpen size={26} className={cn} />,
    kicker: "Files",
    title: "Your files live here, not in the cloud",
    body: "When you upload a photo or document, it's stored on this Droplet's drives — no copies in someone else's data centre. If the Droplet is offline, the only thing affected is access. Your files don't disappear.",
    motif: () => <MotifFiles />,
  },
  {
    key: "ai",
    glyph: (cn) => <Cpu size={26} className={cn} />,
    kicker: "Private AI",
    title: "The AI runs on your hardware",
    body: "The local models run on the GPU inside this box. Your questions, the model's answers, the whole conversation — none of it leaves the Droplet. Cloud models are an explicit opt-in with your own API key, never the default.",
    motif: () => <MotifAi />,
  },
  {
    key: "cameras",
    glyph: (cn) => <Video size={26} className={cn} />,
    kicker: "Cameras",
    title: "Your camera footage stays put",
    body: "Cameras record straight to the Droplet's NVR. Review footage, get motion alerts, grant remote access — but the video never streams out to a cloud service. You can isolate cameras on their own network from the Cameras page.",
    motif: () => <MotifCameras />,
  },
  {
    key: "remote",
    glyph: (cn) => <Globe size={26} className={cn} />,
    kicker: "Remote access",
    title: "Remote access is end-to-end encrypted",
    body: "Off your home Wi-Fi, your phone reaches the Droplet over WireGuard — a modern VPN whose keys you generated on the box itself. Add a device from the Remote Access page and scan one QR code to connect.",
    motif: () => <MotifRemoteVpn />,
  },
];

/**
 * The remote-access beat upgraded for a box that has learned its
 * publicly-trusted per-device FQDN (ADR-023). Same WireGuard framing, plus the
 * one-URL-everywhere + green-padlock payoff, showing the box's real address.
 * Returned as a fresh array (same length/keys) so the resume index, beat dots,
 * and tests are unaffected.
 */
function withFqdnRemoteStep(
  steps: readonly TourStep[],
  fqdn: string,
): TourStep[] {
  return steps.map((s) =>
    s.key === "remote"
      ? {
          ...s,
          body:
            "Off your home Wi-Fi, your phone reaches the Droplet over WireGuard — a modern VPN whose keys you generated on the box itself. Add a device from the Remote Access page, scan one QR code, and you're on. You then open the same secure web address at home or away — a real certificate and a green padlock, with no “Not secure” warning and nothing to install on each device.",
          motif: () => <MotifRemoteFqdn fqdn={fqdn} />,
        }
      : s,
  );
}

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

  // Hydrate once from the persisted step (resumability).
  const [index, setIndex] = useState<number>(() => readResumeIndex());
  // Guard the finish path so a double-click can't fire completeTour + navigate twice.
  const finishedRef = useRef(false);

  // ADR-023: ask the box whether it has a publicly-trusted per-device FQDN. When
  // it does, the remote-access beat upgrades to the one-URL/green-padlock story
  // with the box's real address; until then the WireGuard/DuckDNS default stands.
  // Best-effort — a failed/empty fetch just keeps the default (no over-promise).
  const [remoteFqdn, setRemoteFqdn] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    fetchVpnStatus()
      .then((s) => {
        if (alive) setRemoteFqdn(s?.publicFqdn?.trim() || null);
      })
      .catch(() => {
        /* no signal — keep the WireGuard/DuckDNS baseline */
      });
    return () => {
      alive = false;
    };
  }, []);

  // Persist the active step so a refresh resumes here.
  useEffect(() => {
    try {
      window.localStorage.setItem(RESUME_KEY, String(index));
    } catch {
      /* private mode — resume just falls back to step 1, acceptable */
    }
  }, [index]);

  const steps = remoteFqdn ? withFqdnRemoteStep(TOUR_STEPS, remoteFqdn) : TOUR_STEPS;
  const isFirst = index === 0;
  const isLast = index === steps.length - 1;
  const step = steps[index];

  const finish = useCallback(async () => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    try {
      window.localStorage.removeItem(RESUME_KEY);
    } catch {
      /* ignore */
    }
    await completeTour();
    // Embedded (Done screen): the parent owns post-tour navigation. Standalone
    // (/tour route): fall back to pushing "/".
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
    <div
      className={
        // Embedded on the Done screen, the setup page supplies the full-height
        // centered surface; standalone (/tour) keeps its own full-screen surface.
        onComplete
          ? "w-full flex items-center justify-center"
          : "min-h-dvh bg-surface-primary flex items-center justify-center p-4"
      }
    >
      <div className="w-full max-w-[560px]">
        <div className="dp-card p-8">
          {/* Clickable beat dots — quiet, accent on the active beat. */}
          <div className="mb-6 flex items-center gap-1.5">
            {steps.map((s, i) => (
              <button
                key={s.key}
                type="button"
                onClick={() => setIndex(i)}
                aria-label={`Go to ${s.kicker}`}
                aria-current={i === index ? "step" : undefined}
                className={`h-1.5 rounded-full transition-all duration-300 ease-smooth focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                  i === index
                    ? "w-6 bg-accent"
                    : i < index
                      ? "w-1.5 bg-accent/40"
                      : "w-1.5 bg-separator"
                }`}
              />
            ))}
          </div>

          <span
            className="aurora-brand mb-5 flex h-14 w-14 items-center justify-center rounded-2xl text-white"
            aria-hidden="true"
          >
            {step.glyph("text-white")}
          </span>

          {/* Re-key on `index` so the cross-fade replays per beat; neutralised
              under reduced-motion. */}
          <motion.div
            key={step.key}
            initial={reduced ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: reduced ? 0 : 0.28, ease: [0.25, 0.1, 0.25, 1] }}
          >
            <p className="type-caption-1 font-bold uppercase tracking-[0.06em] text-accent">
              {step.kicker} · {index + 1} of {TOUR_STEPS.length}
            </p>
            <h1 className="type-title-2 text-label-primary mt-2 mb-3">
              {step.title}
            </h1>
            <p className="type-body text-label-secondary mb-6">{step.body}</p>
            {step.motif()}
          </motion.div>

          <div className="mt-8 flex items-center justify-between gap-3">
            {isFirst ? (
              <span aria-hidden="true" />
            ) : (
              <button type="button" onClick={back} className="dp-btn-secondary">
                <ArrowLeft size={16} aria-hidden="true" />
                Back
              </button>
            )}

            <div className="ml-auto flex items-center gap-3">
              {!isLast && (
                <button
                  type="button"
                  onClick={() => void finish()}
                  className="type-footnote font-semibold text-label-tertiary transition-colors hover:text-label-secondary"
                >
                  Skip the tour
                </button>
              )}
              <span className="type-caption-1 text-label-quaternary">
                {index + 1} / {TOUR_STEPS.length}
              </span>
              <button type="button" onClick={next} className="dp-btn-primary">
                {isLast ? "Go to dashboard" : "Next"}
                {!isLast && <ArrowRight size={16} aria-hidden="true" />}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
