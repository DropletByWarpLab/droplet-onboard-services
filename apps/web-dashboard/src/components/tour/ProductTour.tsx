"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { motion, useReducedMotion } from "framer-motion";
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Check,
  Cpu,
  File as FileIcon,
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
import {
  fetchCameras,
  fetchModelsPage,
  fetchRecents,
  fetchSystemHealth,
  fetchVpnStatus,
  getCameraSnapshotUrl,
  type SystemHealthStatus,
} from "@/lib/api";
import type { FileEntryInfo } from "@/lib/types";
import { formatBytes } from "@/lib/format-bytes";
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
  /** Illustrative motif rendered under the copy, bound to live box data. */
  motif: (live: TourLiveData) => ReactNode;
}

// ── Live box data ───────────────────────────────────────────────────
// The motifs bind to what the owner just configured rather than to fixtures.
// Every field is best-effort: `null` means "not loaded / box unreachable", and
// each motif renders an HONEST fallback (an empty state or a generic label)
// rather than a fabricated value. Fetched once in ProductTour and passed down.

export interface TourLiveData {
  /** Orchestrator health → the recap status word. null until loaded. */
  health: SystemHealthStatus | null;
  /** Most-recent files (already trimmed to a few). null = not loaded; [] = none yet. */
  files: FileEntryInfo[] | null;
  /** Name of the on-device model, e.g. "qwen2.5:7b". null = none/unknown. */
  modelName: string | null;
  /** Configured cameras (already trimmed). null = not loaded; [] = none yet. */
  cameras: { name: string; label: string; live: boolean }[] | null;
}

const EMPTY_LIVE: TourLiveData = {
  health: null,
  files: null,
  modelName: null,
  cameras: null,
};

// ── Beat motifs ────────────────────────────────────────────────────
// Token-only, live-data illustrative recaps that make each privacy beat land
// visually. Each takes its slice of TourLiveData and degrades gracefully.

function MotifRecap({ health }: { health: SystemHealthStatus | null }) {
  const pills: [typeof User, string][] = [
    [User, "Account"],
    [Wifi, "Wi-Fi"],
    [Globe, "Internet address"],
    [HardDrive, "Drives"],
    [Lightbulb, "Smart devices"],
    [Camera, "Cameras"],
    [ShieldCheck, "Remote access"],
    [Sparkles, "Private AI"],
  ];
  // Honest liveness word from the orchestrator; omitted entirely when unknown
  // (never a green "online" claim we can't back).
  const status =
    health === "ok"
      ? { label: "online", cls: "text-system-green" }
      : health === "degraded"
        ? { label: "degraded", cls: "text-system-orange" }
        : health === "down"
          ? { label: "offline", cls: "text-system-red" }
          : null;
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
          This Droplet
          {status ? (
            <>
              {" · "}
              <span className={status.cls}>{status.label}</span>
            </>
          ) : null}
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

function MotifFiles({ files }: { files: FileEntryInfo[] | null }) {
  const rows = (files ?? []).slice(0, 3);
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
      {rows.length === 0 ? (
        <div className="px-3.5 py-4 type-footnote text-label-tertiary">
          {files === null
            ? "Your files will appear here."
            : "No files yet — add some from the Files page."}
        </div>
      ) : (
        rows.map((f, i) => (
          <div
            key={f.path}
            className={`flex items-center gap-3 px-3.5 py-2.5 ${
              i ? "border-t border-separator" : ""
            }`}
          >
            {f.isDirectory ? (
              <Folder size={16} className="text-accent" aria-hidden="true" />
            ) : (
              <FileIcon size={16} className="text-accent" aria-hidden="true" />
            )}
            <span className="flex-1 truncate type-footnote font-semibold text-label-primary">
              {f.name}
            </span>
            <span className="type-caption-1 font-mono text-label-tertiary">
              {f.isDirectory ? "Folder" : formatBytes(f.size)}
            </span>
          </div>
        ))
      )}
    </div>
  );
}

function MotifAi({ modelName }: { modelName: string | null }) {
  return (
    <div className="flex w-full flex-col gap-2.5 rounded-[14px] border border-separator bg-surface-secondary p-4 text-left">
      <div className="max-w-[78%] self-end rounded-[12px_12px_4px_12px] bg-accent px-3.5 py-2 type-footnote text-on-accent">
        What can you help me with on this box?
      </div>
      <div className="max-w-[85%] self-start rounded-[12px_12px_12px_4px] border border-separator bg-surface-primary px-3.5 py-2">
        <div className="mb-1 flex items-center gap-1.5">
          <Sparkles size={12} className="text-accent" aria-hidden="true" />
          <span className="type-caption-2 font-bold text-label-secondary">
            {modelName ?? "On-device model"}
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

function MotifCameras({
  cameras,
}: {
  cameras: { name: string; label: string; live: boolean }[] | null;
}) {
  const tiles = (cameras ?? []).slice(0, 2);
  if (tiles.length === 0) {
    // Distinguish loading from empty (TourLiveData contract: `null` = not loaded,
    // `[]` = none yet). Without this, a box WITH cameras flashes the empty state
    // for the first second while fetchCameras is still in flight.
    if (cameras === null) {
      return (
        <div className="flex w-full flex-col items-center justify-center gap-1.5 rounded-[12px] border border-dashed border-separator bg-surface-secondary px-4 py-6 text-center">
          <Camera
            size={26}
            className="animate-pulse text-label-quaternary"
            aria-hidden="true"
          />
          <span className="type-footnote font-semibold text-label-tertiary">
            Loading cameras…
          </span>
        </div>
      );
    }
    return (
      <div className="flex w-full flex-col items-center justify-center gap-1.5 rounded-[12px] border border-dashed border-separator bg-surface-secondary px-4 py-6 text-center">
        <Camera size={26} className="text-label-tertiary" aria-hidden="true" />
        <span className="type-footnote font-semibold text-label-secondary">
          No cameras yet
        </span>
        <span className="type-caption-1 text-label-tertiary">
          Add one from the Cameras page — footage records here, never the cloud.
        </span>
      </div>
    );
  }
  return (
    <div className="grid w-full grid-cols-2 gap-3">
      {tiles.map((cam) => (
        <div
          key={cam.name}
          className="relative h-[104px] overflow-hidden rounded-[12px] border border-separator bg-label-primary/90"
        >
          {/* Placeholder glyph sits behind the live snapshot; if the snapshot
              can't load (camera offline) the glyph remains. */}
          <span className="absolute inset-0 flex items-center justify-center text-white/15">
            <Camera size={34} aria-hidden="true" />
          </span>
          <img
            src={getCameraSnapshotUrl(cam.name)}
            alt=""
            aria-hidden="true"
            className="absolute inset-0 h-full w-full object-cover"
            onError={(e) => {
              e.currentTarget.style.display = "none";
            }}
          />
          {cam.live && (
            <div className="absolute left-2.5 top-2.5 flex items-center gap-1.5">
              <span
                className="h-1.5 w-1.5 rounded-full bg-system-red"
                aria-hidden="true"
              />
              <span className="type-caption-2 font-bold tracking-[0.08em] text-white">
                REC
              </span>
            </div>
          )}
          <span className="absolute right-2.5 top-2.5 rounded bg-white/20 px-1.5 py-0.5 type-caption-2 font-bold tracking-[0.08em] text-white">
            LOCAL
          </span>
          <span className="absolute bottom-2 left-2.5 type-caption-1 font-semibold text-white">
            {cam.label}
          </span>
        </div>
      ))}
    </div>
  );
}

// Two remote-access motifs, chosen at render by the live signals from
// GET /api/vpn/status. WARP-993: the away-from-home story (and the ADR-023
// one-URL-everywhere upgrade) is gated on `offLanReachable` — the FQDN alone
// is split-horizon only (no public A record), so until the ADR-025 relay
// lands the honest baseline talks about the home network and flags the relay
// as coming soon.

function MotifRemoteVpn({ away }: { away: boolean }) {
  return (
    <div className="flex w-full items-center gap-4 rounded-[14px] border border-separator bg-surface-secondary p-4 text-left">
      <div className="flex h-[88px] w-[88px] flex-none items-center justify-center rounded-[12px] border border-separator bg-surface-primary text-label-primary">
        {/* Decorative padlock glyph; the box's real address shows once HQ assigns it. */}
        <Lock size={40} aria-hidden="true" />
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
        <div className="type-caption-1 text-label-secondary">
          Your box&rsquo;s own secure web address
        </div>
        <div className="mt-1.5 type-caption-1 text-label-tertiary">
          {away
            ? "One tap on Connect · same address anywhere"
            : "Works across your office Wi-Fi · away access coming soon"}
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
          Same secure address on-site and away
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
    motif: (live) => <MotifRecap health={live.health} />,
  },
  {
    key: "files",
    glyph: (cn) => <FolderOpen size={26} className={cn} />,
    kicker: "Files",
    title: "Your files live here, not in the cloud",
    body: "When you upload a photo or document, it's stored on this Droplet's drives — no copies in someone else's data centre. If the Droplet is offline, the only thing affected is access. Your files don't disappear.",
    motif: (live) => <MotifFiles files={live.files} />,
  },
  {
    key: "ai",
    glyph: (cn) => <Cpu size={26} className={cn} />,
    kicker: "Private AI",
    title: "The AI runs on your hardware",
    body: "The local models run on the GPU inside this box. Your questions, the model's answers, the whole conversation — none of it leaves the Droplet. Cloud models are an explicit opt-in with your own API key, never the default.",
    motif: (live) => <MotifAi modelName={live.modelName} />,
  },
  {
    key: "cameras",
    glyph: (cn) => <Video size={26} className={cn} />,
    kicker: "Cameras",
    title: "Your camera footage stays put",
    body: "Cameras record straight to the Droplet's NVR. Review footage, get motion alerts, grant remote access — but the video never streams out to a cloud service. You can isolate cameras on their own network from the Cameras page.",
    motif: (live) => <MotifCameras cameras={live.cameras} />,
  },
  {
    key: "remote",
    glyph: (cn) => <Globe size={26} className={cn} />,
    kicker: "Remote access",
    title: "Remote access is automatic and private",
    // WARP-993: the honest baseline. Until the box reports offLanReachable
    // (ADR-025 relay live, or a real public endpoint), the secure address only
    // resolves on the local network — so the default beat never promises away
    // access; it flags the relay as coming soon instead.
    body: "Your box has its own secure web address on your office network. Open it from any of your devices at the office — encrypted, with a green padlock, and nothing extra to install. Away-from-office access arrives with the secure relay — coming soon.",
    motif: (_live) => <MotifRemoteVpn away={false} />,
  },
];

/**
 * The remote-access beat with the away-from-office promise, applied ONLY when
 * the box reports `offLanReachable: true` (WARP-993). Same beat key/shape, so
 * the resume index, beat dots, and tests are unaffected.
 */
function withAwayRemoteStep(steps: readonly TourStep[]): TourStep[] {
  return steps.map((s) =>
    s.key === "remote"
      ? {
          ...s,
          body:
            "Your box has its own secure web address — the same one in the office and away. When you're out, open the Droplet app and turn on Connect: your phone links straight to the box, encrypted end to end, and you open that same address with a green padlock. No dynamic DNS, no subdomain, nothing to install.",
          motif: (_live) => <MotifRemoteVpn away />,
        }
      : s,
  );
}

/**
 * The remote-access beat upgraded for a box that has learned its
 * publicly-trusted per-device FQDN (ADR-023) AND reports it reachable from
 * outside the LAN. Same WireGuard framing, plus the one-URL-everywhere +
 * green-padlock payoff, showing the box's real address. Returned as a fresh
 * array (same length/keys) so the resume index, beat dots, and tests are
 * unaffected.
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
            "Your box answers at its own secure web address, the same one in the office and away. When you're out, open the Droplet app and turn on Connect — your phone links straight to the box, encrypted end to end, and you open that same address with a real certificate and a green padlock. No “Not secure” warning, no dynamic DNS, and nothing to install on each device.",
          motif: (_live) => <MotifRemoteFqdn fqdn={fqdn} />,
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

  // Ask the box how reachable it really is. WARP-993: the away-from-home
  // promise keys on `offLanReachable` (honest, deterministic — false while the
  // FQDN is split-horizon only); the ADR-023 one-URL/green-padlock upgrade
  // additionally needs the publicly-trusted address itself. Best-effort — a
  // failed/empty fetch keeps the honest home-network baseline (no over-promise).
  const [remote, setRemote] = useState<{ fqdn: string | null; away: boolean }>({
    fqdn: null,
    away: false,
  });
  useEffect(() => {
    let alive = true;
    fetchVpnStatus()
      .then((s) => {
        if (alive) {
          setRemote({
            fqdn: s?.publicFqdn?.trim() || null,
            away: s?.offLanReachable === true,
          });
        }
      })
      .catch(() => {
        /* no signal — keep the honest home-network baseline */
      });
    return () => {
      alive = false;
    };
  }, []);

  // Recap health rides the SAME SWR cache the shell status chip uses
  // ("/api/orchestrator/health", 15s interval). Keying on the shared string
  // dedupes the in-flight request instead of firing a duplicate fetch on every
  // tour mount; the data shape into `live.health` is unchanged.
  const { data: healthData } = useSWR<SystemHealthStatus | null>(
    "/api/orchestrator/health",
    () => fetchSystemHealth().then((h) => h?.status ?? null),
    { refreshInterval: 15_000 },
  );

  // Live data for the files / AI / cameras motifs — what the owner just
  // configured, not fixtures. All best-effort and independent: each source that
  // resolves fills its beat; each that rejects leaves that beat's honest
  // fallback. `allSettled` so one slow/dead endpoint never blocks the others.
  // After the batch settles, files/cameras flip from `null` (loading) to `[]`
  // (settled, none) — even on rejection — so motifs distinguish "loading" from
  // "none yet" (TourLiveData contract) and never strand on a loading state.
  const [live, setLive] = useState<TourLiveData>(EMPTY_LIVE);
  useEffect(() => {
    let alive = true;
    void (async () => {
      const [filesR, modelsR, camsR] = await Promise.allSettled([
        fetchRecents(3),
        fetchModelsPage(),
        fetchCameras(),
      ]);
      if (!alive) return;
      // A resolved promise is not a trusted shape — a 200 with an unexpected
      // body must degrade to the fallback, never crash the walkthrough.
      const camsList =
        camsR.status === "fulfilled" && Array.isArray(camsR.value)
          ? camsR.value
          : [];
      setLive((prev) => ({
        ...prev,
        files:
          filesR.status === "fulfilled" && Array.isArray(filesR.value)
            ? filesR.value
            : [],
        modelName:
          modelsR.status === "fulfilled"
            ? (modelsR.value?.local?.[0]?.name ?? null)
            : null,
        cameras: camsList
          .filter((c) => c.enabled)
          .slice(0, 2)
          .map((c) => ({
            name: c.name,
            label: c.displayName || c.name,
            live: c.status === "recording" || c.status === "detecting",
          })),
      }));
    })();
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

  // Merge the SWR-sourced health into the batched live data passed to motifs.
  const liveData: TourLiveData = { ...live, health: healthData ?? null };

  // WARP-993: honest baseline unless the box is genuinely reachable off-LAN;
  // then the away promise, upgraded further with the real FQDN when known.
  const steps = remote.away
    ? remote.fqdn
      ? withFqdnRemoteStep(TOUR_STEPS, remote.fqdn)
      : withAwayRemoteStep(TOUR_STEPS)
    : TOUR_STEPS;
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
            {step.motif(liveData)}
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
