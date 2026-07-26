/**
 * WARP-1055 — pure state derivation for the /voice surface.
 *
 * Every rendered status on the page traces back to two real endpoints
 * (`/api/voice/status` + `/api/voice/calibration`); this module turns
 * those into the design brief's four hero states (§3.1/§7), the four
 * health-check cards (§3.2) and the single worst-problem-wins drift
 * banner (§6.2). Pure functions — `nowS` is injected so tests are
 * deterministic.
 */
import type { VoiceCalibrationInfo, VoiceStatusInfo } from "@/lib/types";

/* ── Tunables (documented judgment calls, not spec constants) ── */

/** Sustained room level this far above the calibrated floor = noise drift. */
export const NOISE_DRIFT_DB = 12;
/** Consecutive 1 s status polls the elevation must hold before it counts —
 *  bursty speech dips between utterances; a fan or music doesn't. */
export const NOISE_SUSTAIN_POLLS = 30;
/** Quiet-room bar for the wizard's step-1 pass + the noise card. Sits
 *  between the brief's own canonical examples: -41 dB reads as "quiet
 *  enough" (§3.1) and -29 dB as "a constant noise source" (§3.2). */
export const NOISE_FLOOR_PASS_DBFS = -35;
/** Speech-peak bar for the wizard's step-2 pass + the input-level card. */
export const SPEECH_PEAK_PASS_DBFS = -35;
/** "Wake stale" drift: calibration this old with NO wake since it. Two
 *  weeks so a household that simply doesn't talk to the box for a few
 *  days never sees a false "needs attention". */
export const WAKE_STALE_AFTER_S = 14 * 24 * 3600;

/* ── WARP-1520 · busy-capture classification ── */

/**
 * True when an error thrown by the lib/api CAPTURE-family helpers —
 * `measureVoiceLevel` / `runVoiceEchoCheck` / `captureVoiceEnrollmentLine`
 * / `verifyVoiceEnrollment` — means the box's ONE mic capture is
 * already held: voice-io guards every capture window with a
 * non-blocking lock and answers 409 to any overlap, and
 * `throwVoiceError` (lib/api) carries that upstream status on the
 * thrown Error. Scoped to those helpers: `restartVoiceProcessor`'s 409
 * means "a restart is already in progress" and keeps its own message
 * path — it does not route through this classifier. Busy is "wait a
 * beat, then retry" — never "the microphone didn't respond". Lives
 * here rather than beside `isVoiceUnavailableError` in lib/api so
 * component tests that mock `@/lib/api` at the module boundary still
 * exercise the REAL classifier.
 */
export function isVoiceBusyError(err: unknown): boolean {
  return (
    err instanceof Error && (err as Error & { status?: number }).status === 409
  );
}

/* ── WARP-1599 · the admin kill switch ── */

/**
 * Is the assistant switched on?
 *
 * `enabled` is the AUTHORITATIVE field, never `state`: voice-io only
 * reports `state: "off"` when the pipeline is absent, so an out-of-band
 * edit of the on-box flag file can leave a switched-off box reporting
 * `state: "listening"` until it restarts. Reading `enabled` cannot
 * disagree with the switch.
 *
 * A missing field (an older box that predates the switch) and a missing
 * payload (the loading flash before the first poll lands) both read as
 * ON: a box we can't ask must never be rendered as deliberately
 * silenced, which would tell a household the assistant was turned off
 * when nobody touched it.
 */
export function isVoiceOn(status: VoiceStatusInfo | null | undefined): boolean {
  return status?.enabled !== false;
}

/**
 * WARP-1599 — true when a voice write failed because the orchestrator
 * couldn't reach voice-io at all (its explicit 503 `voice_unavailable`).
 *
 * `throwVoiceError` (lib/api) puts that machine string in the Error's
 * MESSAGE, so a handler that toasts `err.message` verbatim shows a
 * household admin the words "voice_unavailable" — and the human copy
 * written for exactly this case never fires. Callers use this to pick
 * their own wording instead. Twin of lib/api's `isVoiceUnavailableError`
 * (which the setup wizard's auto-skip keys on); it lives here for the
 * same reason `isVoiceBusyError` does — component tests mock `@/lib/api`
 * at the module boundary and would otherwise exercise a mock.
 */
export function isVoiceUnreachableError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err as Error & { code?: string }).code === "voice_unavailable"
  );
}

export type VoiceHeroKind =
  | "calibrated"
  | "attention"
  | "broken"
  | "uncalibrated"
  | "off";
export type VoiceBrokenCause = "no_mic" | "flatlined" | "unavailable";
export type VoiceDriftCause = "wake" | "noise" | "flags";

export interface VoiceSurfaceState {
  kind: VoiceHeroKind;
  brokenCause?: VoiceBrokenCause;
  driftCause?: VoiceDriftCause;
  /** The single drift-banner sentence (§6.2) — only when kind === "attention". */
  banner?: string;
}

export function deriveVoiceSurfaceState(args: {
  status: VoiceStatusInfo | null;
  calibration: VoiceCalibrationInfo | null;
  unavailable: boolean;
  /** WARP-1599 — the kill switch, via `isVoiceOn`. */
  enabled: boolean;
  noiseSustained: boolean;
  nowS: number;
}): VoiceSurfaceState {
  const { status, calibration, unavailable, enabled, noiseSustained, nowS } =
    args;

  if (unavailable) return { kind: "broken", brokenCause: "unavailable" };
  // WARP-1599 — the switch outranks everything the pipeline could say
  // about itself, because while it's off there IS no pipeline: a mic
  // fault, a wedged processor or drifted calibration are all reports on
  // something that isn't running. Only `unavailable` beats it — a box
  // we can't reach hasn't told us the switch state at all.
  if (!enabled) return { kind: "off" };
  if (!status) return { kind: "uncalibrated" };
  if (status.state === "no_mic") return { kind: "broken", brokenCause: "no_mic" };
  if (status.input_flatlined) return { kind: "broken", brokenCause: "flatlined" };

  if (!calibration?.calibrated) return { kind: "uncalibrated" };

  // Drift — worst problem wins the single banner (§6.2). A wake word
  // that stopped responding beats raised noise beats a flagged-but-
  // working calibration.
  const calibratedAt = calibration.calibrated_at ?? null;
  const wakeStale =
    status.wake_loaded === false ||
    (calibratedAt !== null &&
      (status.last_wake_at ?? 0) < calibratedAt &&
      nowS - calibratedAt > WAKE_STALE_AFTER_S);
  if (wakeStale) {
    return {
      kind: "attention",
      driftCause: "wake",
      banner:
        "The wake word hasn't responded since calibration — recalibrating takes about two minutes.",
    };
  }
  if (noiseSustained) {
    const since = calibratedAt ? ` since ${formatCalDate(calibratedAt)}` : "";
    return {
      kind: "attention",
      driftCause: "noise",
      banner: `Background noise near the mic has increased${since} — recalibrating takes about two minutes.`,
    };
  }
  if (calibration.flags && calibration.flags.length > 0) {
    return {
      kind: "attention",
      driftCause: "flags",
      // Flags are stored as user-facing one-liners by the wizard — the
      // first (earliest-step) one is the banner sentence.
      banner: calibration.flags[0],
    };
  }
  return { kind: "calibrated" };
}

/* ── Health-check strip (§3.2) ── */

export type VoiceCheckStatus = "ok" | "warn" | "err" | "dash";
export type VoiceCheckAction =
  | "test-level"
  | "find-noise"
  | "test-wake"
  | "restart-dsp";

export interface VoiceCheckModel {
  id: "level" | "noise" | "wake" | "dsp";
  label: string;
  status: VoiceCheckStatus;
  result: string;
  /** Mono measured value (read-only). */
  value?: string;
  /** Mono timestamp — every reading is time-stamped (§6.1). */
  stamp: string;
  action?: VoiceCheckAction;
  actionLabel?: string;
}

export function deriveHealthChecks(args: {
  surface: Pick<VoiceSurfaceState, "kind" | "brokenCause" | "driftCause">;
  status: VoiceStatusInfo | null;
  calibration: VoiceCalibrationInfo | null;
  nowS: number;
}): VoiceCheckModel[] | "collapsed" {
  const { surface, status, calibration, nowS } = args;

  // §7.2 — never render four dead cards when there's no mic (or the
  // voice service itself is unreachable, where nothing is knowable).
  if (
    surface.kind === "broken" &&
    (surface.brokenCause === "no_mic" || surface.brokenCause === "unavailable")
  ) {
    return "collapsed";
  }

  // §7.1 first run — em-dash placeholders until the first calibration.
  if (surface.kind === "uncalibrated" || !calibration?.calibrated) {
    const placeholder = (id: VoiceCheckModel["id"]): VoiceCheckModel => ({
      id,
      label: CHECK_LABELS[id],
      status: "dash",
      result: "Runs after the first calibration.",
      value: id === "noise" ? "—" : undefined,
      stamp: "—",
    });
    return [
      placeholder("level"),
      placeholder("noise"),
      placeholder("wake"),
      placeholder("dsp"),
    ];
  }

  // §7.3 — wedged processor: the DSP card carries the fault, the other
  // three explicitly wait rather than showing stale-greens as current.
  // The inline action is the WARP-1057 restart (xvf_host DSP reboot via
  // POST /api/voice/restart-processor); after two failed restarts the
  // surface escalates to the power-cycle copy (HealthStrip dspEscalated).
  if (surface.kind === "broken" && surface.brokenCause === "flatlined") {
    const waiting = (id: VoiceCheckModel["id"]): VoiceCheckModel => ({
      id,
      label: CHECK_LABELS[id],
      status: "dash",
      result: "Waiting on the mic processor.",
      stamp: "—",
    });
    return [
      waiting("level"),
      waiting("noise"),
      waiting("wake"),
      {
        id: "dsp",
        label: CHECK_LABELS.dsp,
        status: "err",
        result: "Not responding.",
        stamp: `Checked ${relTime(nowS, nowS)}`,
        action: "restart-dsp",
        actionLabel: "Restart processor",
      },
    ];
  }

  const calStamp = calibration.calibrated_at
    ? `Checked ${relTime(calibration.calibrated_at, nowS)}`
    : "—";

  // 1 · Input level — from the calibrated speech peak.
  const peak = calibration.speech_peak_dbfs;
  const levelOk = typeof peak === "number" && peak >= SPEECH_PEAK_PASS_DBFS;
  const level: VoiceCheckModel = levelOk
    ? {
        id: "level",
        label: CHECK_LABELS.level,
        status: "ok",
        result: "Speech lands in the right range.",
        stamp: calStamp,
      }
    : {
        id: "level",
        label: CHECK_LABELS.level,
        status: "warn",
        result: "Speech is too quiet from across the room.",
        stamp: calStamp,
        action: "test-level",
        actionLabel: "Test again",
      };

  // 2 · Background noise — calibrated floor + live drift.
  const floor = calibration.noise_floor_dbfs;
  const floorValue = typeof floor === "number" ? `${floor} dB` : "—";
  const noiseDrifting = surface.driftCause === "noise";
  const noiseHigh = typeof floor === "number" && floor > NOISE_FLOOR_PASS_DBFS;
  const noise: VoiceCheckModel =
    noiseDrifting || noiseHigh
      ? {
          id: "noise",
          label: CHECK_LABELS.noise,
          status: "warn",
          result: "A constant noise source is competing with speech.",
          value: floorValue,
          stamp: noiseDrifting ? `Checked ${relTime(nowS, nowS)}` : calStamp,
          action: "find-noise",
          actionLabel: "Find the noise",
        }
      : {
          id: "noise",
          label: CHECK_LABELS.noise,
          status: "ok",
          result: "Quiet enough for reliable listening.",
          value: floorValue,
          stamp: calStamp,
        };

  // 3 · Wake word — live last-wake beats the calibration-time count.
  const wakeDrifting = surface.driftCause === "wake";
  let wake: VoiceCheckModel;
  if (wakeDrifting) {
    wake = {
      id: "wake",
      label: CHECK_LABELS.wake,
      status: "warn",
      result: "The wake word hasn't responded since calibration.",
      stamp: calStamp,
      action: "test-wake",
      actionLabel: "Test again",
    };
  } else if (status?.last_wake_at) {
    wake = {
      id: "wake",
      label: CHECK_LABELS.wake,
      status: "ok",
      result: `Responded to the last test · ${relTime(status.last_wake_at, nowS)}.`,
      stamp: `Checked ${relTime(nowS, nowS)}`,
    };
  } else {
    wake = {
      id: "wake",
      label: CHECK_LABELS.wake,
      status: "ok",
      result: `Responded ${calibration.wake_detections ?? 0} of 3 during calibration.`,
      stamp: calStamp,
    };
  }

  // 4 · Mic processor — audio is flowing (flatline handled above).
  const dsp: VoiceCheckModel = {
    id: "dsp",
    label: CHECK_LABELS.dsp,
    status: "ok",
    result: "Echo cancellation and beamforming active.",
    stamp: status?.last_audio_at
      ? `Checked ${relTime(status.last_audio_at, nowS)}`
      : `Checked ${relTime(nowS, nowS)}`,
  };

  // Exactly one inline action — the card owning the CURRENT worst
  // problem keeps its action, the rest render read-only (§3.2 "each
  // failing card exposes one inline action"; the banner already owns
  // the page-level fix).
  const cards = [level, noise, wake, dsp];
  const priority: VoiceCheckModel["id"][] = ["dsp", "wake", "noise", "level"];
  const failing = priority.find((id) =>
    cards.some((c) => c.id === id && c.action),
  );
  for (const c of cards) {
    if (c.id !== failing) {
      delete c.action;
      delete c.actionLabel;
    }
  }
  return cards;
}

const CHECK_LABELS: Record<VoiceCheckModel["id"], string> = {
  level: "Input level",
  noise: "Background noise",
  wake: "Wake word",
  dsp: "Mic processor",
};

/* ── Sustained-noise latch tick ── */

/**
 * One poll tick of the sustained-noise latch (WARP-1055 review F1/F9).
 *
 * Domain contract: BOTH sides of the compare are raw / pre-gain — the
 * pipeline publishes `input_rms_dbfs` BEFORE applying the digital
 * input gain, and the stored floor came from the raw /audio/measure
 * path. `calibration.input_gain` must therefore NEVER enter this
 * comparison; an applied gain of ×8 leaves an unchanged room exactly
 * at its calibrated floor. (Regression-pinned in voice.state.test.ts.)
 *
 * Called from a wall-clock timer, not from data-change effects — SWR
 * keeps the data reference stable when payloads are deep-equal, so
 * counting object-identity changes would stall in a steady room and
 * double-count around calibration revalidations.
 *
 * Returns the new consecutive-tick count; drift is "sustained" once
 * the count reaches NOISE_SUSTAIN_POLLS.
 */
export function nextNoiseCount(
  count: number,
  status: VoiceStatusInfo | null,
  calibration: VoiceCalibrationInfo | null,
): number {
  const rms = status?.input_rms_dbfs;
  const floor = calibration?.noise_floor_dbfs;
  if (
    rms == null ||
    floor == null ||
    !calibration?.calibrated ||
    status?.input_flatlined
  ) {
    return 0;
  }
  return rms > floor + NOISE_DRIFT_DB ? count + 1 : 0;
}

/* ── Formatting helpers (mono, read-only) ── */

/** Live-meter bar fraction from the rolling RMS: -60 dBFS → 0, -15 → 1. */
export function meterFractionFromDbfs(dbfs: number | null | undefined): number {
  if (dbfs == null || !Number.isFinite(dbfs)) return 0;
  return Math.min(1, Math.max(0, (dbfs + 60) / 45));
}

/** Human-relative timestamp: "just now" · "5 min ago" · "3 days ago". */
export function relTime(epochS: number, nowS: number): string {
  const delta = Math.max(0, nowS - epochS);
  if (delta < 90) return "just now";
  if (delta < 3600) return `${Math.round(delta / 60)} min ago`;
  if (delta < 48 * 3600) return `${Math.round(delta / 3600)} h ago`;
  return `${Math.round(delta / 86400)} days ago`;
}

/** Clock time for activity rows — mono "09:41". */
export function formatClock(epochS: number): string {
  const d = new Date(epochS * 1000);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** Banner date — "June 20". */
export function formatCalDate(epochS: number): string {
  return new Date(epochS * 1000).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
  });
}
