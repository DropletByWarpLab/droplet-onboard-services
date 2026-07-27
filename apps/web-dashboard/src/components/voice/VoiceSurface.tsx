"use client";

/**
 * WARP-1055 — the /voice surface (presentational assembly).
 *
 * Regions per the design brief §3: status hero (the answer at a
 * glance) · health-checks strip · voice profiles · recent voice
 * activity, plus the Flow A calibration wizard. SWR wiring lives in
 * the page wrapper (`app/voice/page.tsx`) — this component maps REAL
 * `/api/voice/status` + `/api/voice/calibration` data onto the §9
 * copy, which ships verbatim from the COPY table below.
 *
 * WARP-1057 wired the §7.3 processor card's "Restart processor" inline
 * action: confirm dialog (~10 s hearing outage) → POST
 * /api/voice/restart-processor → watch the live status poll until
 * `input_flatlined` clears; after two failed restarts the card
 * escalates to the power-cycle copy + Get help.
 *
 * WARP-1056 wired §3.3 for real: profile rows + "Add a voice" + the
 * Flow B EnrollmentWizard (entry points: the section button, a People
 * row's "Add voice" deep-link via `initialEnrollUserId`, the §4-result
 * post-calibration hook, and each row's "Re-record voice"). Entry
 * points disable whenever the box can't enroll — model absent or mic
 * broken (§7.2: never launch a wizard that cannot succeed).
 *
 * WARP-1058 upgraded "Recent voice activity" from the single live
 * last-wake row to the real §3.4 feed: max 5 signed kind=voice rows
 * (time mono · person-or-Guest · what happened), §6.3 self-heal rows
 * rendered without a person, and the "See all in Activity" deep-link
 * pre-filtered to kind=voice.
 *
 * WARP-1599 added the admin kill switch. Off is not a fault and must
 * never wear the red broken styling: it is one calm hero that replaces
 * the mic-status hero, the health strip AND both wizards, because with
 * the pipeline gone those would be reporting on — or trying to drive —
 * something that isn't running. voice-io now refuses every mic-opening
 * endpoint with a 409 while off, so the "no audio is captured" promise
 * is the box's, not this component's; what the gating here buys is that
 * an admin never walks into that error, and that an open wizard closes
 * instead of dead-ending when a SECOND session flips the switch.
 * Voiceprints and the activity feed stay: they're on-box records, and
 * the off event itself lands in that feed.
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, MicOff } from "lucide-react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { SafetyChip } from "@/components/email/SafetyChip";
import { useToast } from "@/components/Toast";
import {
  measureVoiceLevel,
  restartVoiceProcessor,
  setVoiceEnabled,
} from "@/lib/api";
import type {
  VoiceActivityItem,
  VoiceCalibrationInfo,
  VoiceProfileInfo,
  VoiceStatusInfo,
} from "@/lib/types";
import { CalibrationWizard } from "./CalibrationWizard";
import { EnrollmentWizard } from "./EnrollmentWizard";
import { HealthStrip } from "./HealthStrip";
import { VoiceProfilesSection } from "./VoiceProfilesSection";
import { LiveMeter, StatusRing } from "./VoiceBits";
import {
  deriveHealthChecks,
  deriveVoiceSurfaceState,
  formatClock,
  isVoiceBusyError,
  isVoiceOn,
  isVoiceUnreachableError,
  NOISE_FLOOR_PASS_DBFS,
  relTime,
  SPEECH_PEAK_PASS_DBFS,
  type VoiceCheckAction,
  type VoiceHeroKind,
} from "./state";
import "./voice.css";

/* §9 copy block — ships VERBATIM. */
const COPY = {
  heroCalibrated: "Microphone calibrated",
  heroDrift: "Microphone needs attention",
  heroBroken: "Microphone not working",
  heroFirstRun: "Not calibrated yet",
  firstRunSub:
    "Two minutes of guided setup and Droplet will hear you reliably from across the room.",
  ctaFirstRun: "Set up microphone",
  ctaFix: "Fix it",
  ctaRecalibrate: "Recalibrate",
  meterCap: "Live input · processed on this box",
  cancelToast: "Calibration canceled — previous settings kept.",
  activityEmpty: "No voice activity yet. Say 'Hey Droplet' to try it.",
  connecting: "Connecting to the microphone…",
  /* WARP-1599 kill switch. `heroOff` doubles as the switched-off toast:
     the confirmation and the hero the admin is now looking at must say
     the same thing, word for word. */
  heroOff: "Voice is off — Droplet isn't listening.",
  offSub:
    "The wake word does nothing and no audio is captured. Voiceprints and calibration stay on this box.",
  ctaTurnOn: "Turn voice on",
  ctaTurnOff: "Turn off voice",
  toastOn: "Voice is back on — listening for the wake word.",
  offEnrollTitle: "Voice is off — turn it back on to record a voice.",
} as const;

/* Sub-line reasons (§3.1 "always concrete"; §7.2 verbatim). */
const SUB_NO_MIC = "No microphone is detected on this Droplet.";
const SUB_FLATLINED = "The mic processor is not responding.";
const SUB_UNAVAILABLE = "The voice service isn't responding on this Droplet.";

/* §7.3 — escalate the processor card after this many failed restarts. */
const DSP_ESCALATE_AFTER = 2;
/* Wake re-test listening window (health-card "Test again"). */
const WAKE_TEST_WINDOW_MS = 12_000;
/* WARP-1057 — how long a DSP reboot gets before it counts as a failed
   restart. The chip drops off USB + re-enumerates in ~10 s; the pipeline
   then needs a real audio frame to clear `input_flatlined`. */
const RESTART_WAIT_MS = 20_000;

/* §7.3 restart copy. */
const RESTART_CONFIRM_TITLE = "Restart the mic processor?";
const RESTART_CONFIRM_BODY =
  "Droplet's hearing will pause for about 10 seconds while the processor restarts. It comes back on its own — nothing else is interrupted.";
const RESTART_ISSUED_TOAST =
  "Restarting the mic processor — listening pauses for about 10 seconds.";
const RESTART_OK_TOAST = "Mic processor is back — audio is flowing again.";
const RESTART_FAILED_TOAST =
  "The processor didn't come back after the restart.";
const RESTART_REQUEST_FAILED_TOAST =
  "Couldn't restart the processor — the voice service didn't respond.";
/* WARP-1520 — voice-io's exclusive capture lock answered 409: another
   listening window is running (with lib/api's capture gate serializing
   this tab, that means another session or API caller). Busy is "wait a
   beat", never the dead-mic "didn't respond" toast. */
const BUSY_CHECK_TOAST =
  "The microphone is busy with another check — try again in a few seconds.";
const MEASURE_FAILED_TOAST =
  "Couldn't measure — the microphone didn't respond.";
/* WARP-1599 — fallback for a toggle that failed without a message from
   the box (the 409 / 422 / 503 paths all carry their own detail up
   through `throwVoiceError`, which reads better than anything generic). */
const TOGGLE_FAILED_TOAST =
  "Couldn't switch voice — the voice service didn't respond.";

export interface VoiceSurfaceProps {
  status: VoiceStatusInfo | null;
  calibration: VoiceCalibrationInfo | null;
  /** Orchestrator answered 503 voice_unavailable (voice-io down). */
  unavailable: boolean;
  /** WARP-1599 — the admin kill switch (`useVoiceSurfaceData.enabled`,
   *  which reads the authoritative `status.enabled`). Defaults to ON so
   *  a caller without the wiring can't render a working box as
   *  deliberately silenced — but it can only ever be the SECOND vote:
   *  `status.enabled` is required on the payload beside it, and a
   *  caller that passes a silenced status without also passing this
   *  prop must not get a hero that says Droplet is listening. Kept as a
   *  prop purely so tests can inject the switch without a status. */
  enabled?: boolean;
  /** Initial fetches still in flight (§7.8 skeleton). */
  loading: boolean;
  /** Sustained room level above the calibrated floor (drift input). */
  noiseSustained: boolean;
  /** WARP-1056 §3.3 — enrolled voiceprints; null while loading /
   *  voice-io unreachable (renders the empty shell). Optional so the
   *  surface still renders without the profiles wiring. */
  profiles?: VoiceProfileInfo[] | null;
  /** §7.2 gate — false disables every enrollment entry point. */
  speakerModelAvailable?: boolean;
  /** People-page deep-link (`/voice?enroll=<userId>`): open Flow B with
   *  this person preselected. */
  initialEnrollUserId?: string | null;
  onProfilesChanged?: () => void;
  /** WARP-1058 §3.4 feed rows (kind=voice, newest first); null while
   *  loading or when the fetch failed — renders the empty state. */
  activity: VoiceActivityItem[] | null;
  /** Epoch seconds — injectable for deterministic tests. */
  nowS?: number;
  onRefresh: () => void;
  onCalibrationApplied: () => void;
}

/** §3.4: "A short list (max 5)". The API asks for 5; slice defends the
 *  render if a caller ever passes more. */
const ACTIVITY_MAX_ROWS = 5;

/**
 * Hero headline + ring for the four LIVE states.
 *
 * `off` is deliberately excluded by the TYPE (WARP-1599): it renders its
 * own hero from COPY.heroOff / COPY.offSub with a neutral MicOff ring,
 * and while these were plain if-chains it also fell through them to the
 * first-run copy — two answers to "what does the hero say when voice is
 * off", one of them dead. Only the narrowed non-off branch below can
 * index these, so there is now exactly one.
 */
type LiveHeroKind = Exclude<VoiceHeroKind, "off">;

const HERO_HEADLINE: Record<LiveHeroKind, string> = {
  calibrated: COPY.heroCalibrated,
  attention: COPY.heroDrift,
  broken: COPY.heroBroken,
  uncalibrated: COPY.heroFirstRun,
};

const HERO_RING: Record<LiveHeroKind, "ok" | "warn" | "err" | "neutral"> = {
  calibrated: "ok",
  attention: "warn",
  broken: "err",
  uncalibrated: "neutral",
};

export function VoiceSurface({
  status,
  calibration,
  unavailable,
  enabled = true,
  loading,
  noiseSustained,
  profiles = null,
  speakerModelAvailable = false,
  initialEnrollUserId = null,
  onProfilesChanged,
  activity,
  nowS,
  onRefresh,
  onCalibrationApplied,
}: VoiceSurfaceProps) {
  const { toast } = useToast();
  const now = nowS ?? Math.floor(Date.now() / 1000);

  const [wizardOpen, setWizardOpen] = useState(false);
  // WARP-1056 — Flow B. `enrollPreset` carries the person a deep-link /
  // re-record picked; null lets the wizard preselect the signed-in user.
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [enrollPreset, setEnrollPreset] = useState<string | null>(null);
  const [dspRetries, setDspRetries] = useState(0);
  const [wakeTestArmed, setWakeTestArmed] = useState(false);
  const wakeBaselineRef = useRef<number | null>(null);
  // WARP-1057 — restart flow: confirm dialog → issued (pending) →
  // success (flatline clears) or failed (still flatlined at deadline).
  const [restartConfirmOpen, setRestartConfirmOpen] = useState(false);
  const [restartPending, setRestartPending] = useState(false);
  // WARP-1599 — one toggle in flight at a time. voice-io serializes
  // concurrent toggles with a non-blocking lock and answers 409, so a
  // double-click would earn the admin an error toast for a switch that
  // is working perfectly.
  const [togglePending, setTogglePending] = useState(false);

  // WARP-1599 — BOTH votes, and either one can silence. The prop is the
  // wired-up answer (`useVoiceSurfaceData.enabled`, itself `isVoiceOn`
  // of this same payload) but it defaults to true, so on its own it
  // would out-vote a `status.enabled: false` from a caller that simply
  // didn't pass it — rendering a silenced box as listening, the exact
  // failure this feature exists to prevent.
  const on = enabled && isVoiceOn(status);

  const surface = deriveVoiceSurfaceState({
    status,
    calibration,
    unavailable,
    enabled: on,
    noiseSustained,
    nowS: now,
  });
  const checks = deriveHealthChecks({ surface, status, calibration, nowS: now });

  // §7.3 — the failed-restart counter resets the moment audio flows again.
  useEffect(() => {
    if (!status?.input_flatlined && dspRetries !== 0) setDspRetries(0);
  }, [status?.input_flatlined, dspRetries]);

  // WARP-1057 — a pending restart succeeds when the live status poll
  // shows the flatline cleared (the pipeline saw a real audio frame).
  useEffect(() => {
    if (!restartPending) return;
    if (status && !status.input_flatlined) {
      setRestartPending(false);
      toast(RESTART_OK_TOAST, "success");
    }
  }, [restartPending, status, toast]);
  // …and fails when the deadline passes with the flatline still up:
  // count it toward the §7.3 escalation (two failures → power-cycle copy).
  useEffect(() => {
    if (!restartPending) return;
    const timer = setTimeout(() => {
      setRestartPending(false);
      setDspRetries((n) => n + 1);
      toast(RESTART_FAILED_TOAST, "error");
      onRefresh();
    }, RESTART_WAIT_MS);
    return () => clearTimeout(timer);
    // onRefresh is stable from the page wrapper; re-arming the deadline
    // on a re-render identity change would silently extend the window.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restartPending, toast]);

  // Runs inside ConfirmDialog's onConfirm contract: resolving closes
  // the dialog, so request-level failures are caught (not rethrown) —
  // they count toward §7.3 escalation rather than inviting a blind
  // retry of a tool that isn't there.
  async function handleRestartConfirm() {
    try {
      await restartVoiceProcessor();
    } catch (err) {
      setDspRetries((n) => n + 1);
      toast(
        err instanceof Error && err.message
          ? err.message
          : RESTART_REQUEST_FAILED_TOAST,
        "error",
      );
      return;
    }
    toast(RESTART_ISSUED_TOAST, "info");
    setRestartPending(true);
    onRefresh();
  }

  // WARP-1599 — the kill switch. No ConfirmDialog: nothing is
  // destroyed and the same button undoes it, so a confirm would only
  // add ceremony. The write is the source of truth for the toast —
  // a non-2xx never gets to claim the box changed state.
  async function handleToggleEnabled(next: boolean) {
    setTogglePending(true);
    let applied: boolean;
    try {
      // The APPLIED value, not the requested one: the box's response is
      // what actually happened, and it is what the hero will show once
      // the poll lands.
      ({ enabled: applied } = await setVoiceEnabled(next));
    } catch (err) {
      // The box's own detail says more than any copy we could write —
      // except on the 503, whose "detail" is the machine string
      // `voice_unavailable` (throwVoiceError puts it in the message).
      // Same classifier shape the measure handlers below use.
      toast(
        err instanceof Error && err.message && !isVoiceUnreachableError(err)
          ? err.message
          : TOGGLE_FAILED_TOAST,
        "error",
      );
      return;
    } finally {
      setTogglePending(false);
    }
    // Kick a re-poll so the hero catches up (fire-and-forget — the
    // toast below announces the value the box just returned, not the
    // one the refresh will eventually bring back).
    onRefresh();
    toast(applied ? COPY.toastOn : COPY.heroOff, "success");
  }

  // Health-card wake re-test: watch the live poll for a fresh wake.
  useEffect(() => {
    if (!wakeTestArmed) return;
    const at = status?.last_wake_at ?? null;
    if (at != null && at !== wakeBaselineRef.current) {
      setWakeTestArmed(false);
      toast("Wake word responded just now.", "success");
    }
  }, [wakeTestArmed, status?.last_wake_at, toast]);
  useEffect(() => {
    if (!wakeTestArmed) return;
    const timer = setTimeout(() => {
      setWakeTestArmed(false);
      toast("No wake word heard — try again from a bit closer.", "error");
    }, WAKE_TEST_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [wakeTestArmed, toast]);

  async function handleCheckAction(action: VoiceCheckAction) {
    if (action === "find-noise") {
      toast("Listening for steady noise…", "info");
      try {
        const r = await measureVoiceLevel("noise_floor", 5);
        // Plain word first, measured value as the em-dash aside — a
        // bare number tells a home user nothing.
        toast(
          r.rms_dbfs <= NOISE_FLOOR_PASS_DBFS
            ? `Background level is steady — quiet enough at ${r.rms_dbfs} dB.`
            : `A constant noise source is nearby — about ${r.rms_dbfs} dB at the mic.`,
          "info",
        );
      } catch (err) {
        toast(
          isVoiceBusyError(err) ? BUSY_CHECK_TOAST : MEASURE_FAILED_TOAST,
          "error",
        );
      }
      return;
    }
    if (action === "test-level") {
      toast("Listening — speak normally from where you usually are…", "info");
      try {
        const r = await measureVoiceLevel("speech_peak", 5);
        // Mirrors the wizard's step-2 good/faint wording.
        toast(
          r.peak_dbfs >= SPEECH_PEAK_PASS_DBFS
            ? `Speech came through — good at ${r.peak_dbfs} dB.`
            : `Speech came through — faint at ${r.peak_dbfs} dB. Try from a bit closer.`,
          "info",
        );
      } catch (err) {
        toast(
          isVoiceBusyError(err) ? BUSY_CHECK_TOAST : MEASURE_FAILED_TOAST,
          "error",
        );
      }
      return;
    }
    if (action === "test-wake") {
      wakeBaselineRef.current = status?.last_wake_at ?? null;
      setWakeTestArmed(true);
      toast('Listening — say "Hey Droplet"…', "info");
      return;
    }
    // restart-dsp (WARP-1057) — §7.3: confirm the ~10 s hearing outage
    // before issuing the reboot.
    setRestartConfirmOpen(true);
  }

  function handleWizardClose(result: { applied: boolean; addVoice?: boolean }) {
    setWizardOpen(false);
    if (result.applied) {
      onCalibrationApplied();
      // §4-result forward hook: "Add my voice" → Flow B, preselecting
      // the signed-in user (the wizard's own default).
      if (result.addVoice) {
        setEnrollPreset(null);
        setEnrollOpen(true);
      }
    } else {
      toast(COPY.cancelToast, "info");
    }
  }

  // WARP-1056 — People-row "Add voice" deep-link (/voice?enroll=<id>):
  // open Flow B once with that person preselected, when enrollment can
  // actually run here (§7.2 — never launch a wizard that cannot succeed).
  const enrollLinkConsumedRef = useRef(false);
  // Broken covers unavailable / no_mic / flatlined — a mic that can't
  // capture real audio can't enroll a voice either.
  //
  // WARP-1599 — and `off` joins them, for the reverse reason: Flow B's
  // captures land on voice-io's `_capture_speaker_pcm`, which now
  // refuses (409) while the switch is off, because recording four
  // scripted lines under a hero promising "no audio is captured" would
  // make that promise false — and a false privacy promise on the
  // kill-switch page is the worst thing this surface could ship. So the
  // gate here isn't the enforcement, it's the courtesy: no entry point
  // into a flow whose every capture would error (§7.2). Nothing is lost
  // by waiting either — a voiceprint enrolled while voice is off can't
  // match anything until voice is back on.
  const enrollmentAllowed =
    speakerModelAvailable &&
    surface.kind !== "broken" &&
    surface.kind !== "off";
  useEffect(() => {
    if (!initialEnrollUserId || enrollLinkConsumedRef.current) return;
    if (!enrollmentAllowed) return;
    enrollLinkConsumedRef.current = true;
    setEnrollPreset(initialEnrollUserId);
    setEnrollOpen(true);
  }, [initialEnrollUserId, enrollmentAllowed]);

  function handleEnrollClose(result: { saved: boolean; name?: string }) {
    setEnrollOpen(false);
    setEnrollPreset(null);
    if (result.saved) {
      toast(
        result.name
          ? `Saved ${result.name}'s voice — stored on this box only.`
          : "Voice saved — stored on this box only.",
        "success",
      );
      onProfilesChanged?.();
    } else {
      toast("Voice enrollment canceled — nothing was saved.", "info");
    }
  }

  // WARP-1599 — an open Flow B whose preconditions went away mid-flow is
  // over, not paused. The render gate below unmounts it; this runs the
  // ordinary cancel path so the admin gets the "nothing was saved" toast
  // instead of a wizard silently vanishing, and so `enrollOpen` doesn't
  // pop it back open the moment voice comes back on. The on-box session
  // is left to speaker_id.py's SESSION_TTL_S, the same fail-safe a
  // closed browser tab relies on.
  useEffect(() => {
    if (enrollOpen && !enrollmentAllowed) handleEnrollClose({ saved: false });
    // handleEnrollClose is redefined every render; listing it would
    // re-run this on every render instead of on the gate flipping.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enrollOpen, enrollmentAllowed]);

  /* ── §7.8 loading skeleton ── */
  if (loading) {
    return (
      <div className="voice-surface">
        <div className="vcard vhero">
          <div className="vhero-row">
            <span className="vskel" style={{ width: 72, height: 72, borderRadius: "50%" }} />
            <div className="vhero-stack">
              <span className="vskel" style={{ width: 220, height: 16 }} />
              <br />
              <span className="vskel" style={{ width: 320, height: 12, marginTop: 8 }} />
              <LiveMeter dbfs={null} flat caption={COPY.connecting} />
            </div>
            <span className="vskel" style={{ width: 130, height: 36, borderRadius: 8 }} />
          </div>
        </div>
        <div className="vchecks">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="vcard vcheck">
              <div className="vcheck-top">
                <span className="vskel" style={{ width: 28, height: 28, borderRadius: 8 }} />
                <span className="vskel" style={{ width: 90, height: 12 }} />
              </div>
              <span className="vskel" style={{ width: "80%", height: 11 }} />
              <span className="vskel" style={{ width: "45%", height: 10 }} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  // WARP-1599 — while voice is off the wizard can only dead-end:
  // voice-io answers 409 on `/audio/measure`, `/audio/test-record` and
  // `/audio/echo-check` (it refuses to open the mic at all while the
  // switch is off), so every step of Flow A would fail. Not mounted.
  const wizardAllowed =
    surface.kind !== "off" &&
    (surface.kind !== "broken" || surface.brokenCause === "flatlined");

  // The switch needs a real answer from the box to act on: while
  // voice-io is unreachable the POST could only 503, and §7.2 says
  // never render an entry point to a flow that cannot succeed.
  const toggleAvailable = !unavailable && status != null;
  // Off carries its own hero with its own primary action, so the quiet
  // ghost switch only rides the on-state hero.
  const showTurnOff = toggleAvailable && surface.kind !== "off";

  const meterFlat = surface.kind === "broken" || status?.input_rms_dbfs == null;

  /* The live-hero sub-line. Takes the NARROWED kind for the same reason
     HERO_HEADLINE / HERO_RING are keyed on it — the off hero says
     COPY.offSub and nothing here may quietly answer for it too. */
  function subline(kind: LiveHeroKind) {
    if (kind === "broken") {
      const text =
        surface.brokenCause === "no_mic"
          ? SUB_NO_MIC
          : surface.brokenCause === "flatlined"
            ? SUB_FLATLINED
            : SUB_UNAVAILABLE;
      return <p className="subline">{text}</p>;
    }
    if (kind === "uncalibrated") {
      return <p className="subline">{COPY.firstRunSub}</p>;
    }
    if (kind === "attention") {
      const reason =
        surface.driftCause === "noise"
          ? "Background noise has increased since calibration."
          : surface.driftCause === "wake"
            ? "The wake word hasn't responded since calibration."
            : (calibration?.flags?.[0] ?? "Calibration needs a re-run.");
      return <p className="subline">{reason}</p>;
    }
    const floor = calibration?.noise_floor_dbfs;
    return (
      <p className="subline">
        {calibration?.calibrated_at
          ? `Calibrated ${relTime(calibration.calibrated_at, now)}`
          : "Calibrated"}
        {typeof floor === "number" ? (
          <>
            {" · "}
            <span className="mono">{`noise floor ${floor} dB`}</span>
          </>
        ) : null}
        {" · wake word responding"}
      </p>
    );
  }

  function heroCta() {
    if (surface.kind === "uncalibrated") {
      return (
        <button
          type="button"
          className="btn primary"
          onClick={() => setWizardOpen(true)}
        >
          {COPY.ctaFirstRun}
        </button>
      );
    }
    if (surface.kind === "calibrated") {
      return (
        <button
          type="button"
          className="btn ghost"
          onClick={() => setWizardOpen(true)}
        >
          {COPY.ctaRecalibrate}
        </button>
      );
    }
    if (surface.kind === "attention" || surface.brokenCause === "flatlined") {
      return (
        <button
          type="button"
          className="btn primary"
          onClick={() => setWizardOpen(true)}
        >
          {COPY.ctaFix}
        </button>
      );
    }
    // no_mic / unavailable — never launch a wizard that cannot succeed.
    return (
      <>
        <Link href="/help" className="vtext-btn">
          Get help <ArrowRight size={13} aria-hidden="true" />
        </Link>
        <button
          type="button"
          className="btn primary"
          onClick={onRefresh}
        >
          Check again
        </button>
      </>
    );
  }

  /* ── Recent voice activity (§3.4): max-5 signed kind=voice rows ── */
  const activityRows = (activity ?? []).slice(0, ACTIVITY_MAX_ROWS);

  return (
    <div className="voice-surface">
      {surface.kind === "off" ? (
        /* ── Switched off (WARP-1599): one hero, no live meter, no
             health strip, no calibration entry. Quiet and neutral —
             this is a decision the admin made, not a failure. ── */
        <section className="vcard vhero" aria-labelledby="voice-hero-headline">
          <div className="vhero-corner">
            <SafetyChip safety="Read" />
          </div>
          <div className="vhero-row">
            <StatusRing status="neutral" icon={MicOff} />
            <div className="vhero-stack">
              <h2 className="headline" id="voice-hero-headline">
                {COPY.heroOff}
              </h2>
              <p className="subline">{COPY.offSub}</p>
            </div>
            <div className="vhero-cta">
              <button
                type="button"
                className="btn primary"
                disabled={togglePending}
                onClick={() => void handleToggleEnabled(true)}
              >
                {COPY.ctaTurnOn}
              </button>
            </div>
          </div>
        </section>
      ) : (
        <>
          {/* ── Status hero (§3.1) ── */}
          <section className="vcard vhero" aria-labelledby="voice-hero-headline">
            <div className="vhero-corner">
              <SafetyChip safety="Read" />
            </div>
            <div className="vhero-row">
              <StatusRing status={HERO_RING[surface.kind]} />
              <div className="vhero-stack">
                <h2 className="headline" id="voice-hero-headline">
                  {HERO_HEADLINE[surface.kind]}
                </h2>
                {subline(surface.kind)}
                <LiveMeter
                  dbfs={status?.input_rms_dbfs ?? null}
                  flat={meterFlat}
                  caption={COPY.meterCap}
                />
              </div>
              <div className="vhero-cta">
                {/* WARP-1599 — the switch rides the hero's ACTION area,
                    beside the calibration CTA, not the corner: that
                    corner is the SafetyChip's, and the chip reads "Read ·
                    stays on LAN" — the most consequential write on this
                    page must not sit inside a label that calls the card
                    read-only. Same place the off hero puts "Turn voice
                    on". Deliberately quiet (ghost): silencing the
                    household assistant is an admin decision, not the
                    page's suggestion. */}
                {showTurnOff && (
                  <button
                    type="button"
                    className="btn ghost sm"
                    disabled={togglePending}
                    onClick={() => void handleToggleEnabled(false)}
                  >
                    {COPY.ctaTurnOff}
                  </button>
                )}
                {heroCta()}
              </div>
            </div>
            {/* Drift banner (§6.2) — max one, worst problem wins. */}
            {surface.kind === "attention" && surface.banner && (
              <div className="vbanner" role="status">
                <span className="txt">{surface.banner}</span>
                <button
                  type="button"
                  className="btn primary sm"
                  onClick={() => setWizardOpen(true)}
                >
                  {COPY.ctaRecalibrate}
                </button>
              </div>
            )}
          </section>

          {/* ── Health checks strip (§3.2) ── */}
          <HealthStrip
            checks={checks}
            dspEscalated={dspRetries >= DSP_ESCALATE_AFTER}
            onAction={(action) => void handleCheckAction(action)}
          />
        </>
      )}

      {/* ── Voice profiles (§3.3 — WARP-1056 Flow B) ── */}
      <VoiceProfilesSection
        profiles={profiles}
        enrollmentAllowed={enrollmentAllowed}
        enrollmentBlockedReason={
          surface.kind === "off" ? COPY.offEnrollTitle : undefined
        }
        nowS={now}
        onAddVoice={() => {
          setEnrollPreset(null);
          setEnrollOpen(true);
        }}
        onReRecord={(userId) => {
          setEnrollPreset(userId);
          setEnrollOpen(true);
        }}
        onProfilesChanged={() => onProfilesChanged?.()}
      />

      {/* ── Recent voice activity (§3.4 feed + §6.3 self-heal rows) ── */}
      <section aria-labelledby="voice-activity-h">
        <div className="vsect-h">
          <h2 id="voice-activity-h">Recent voice activity</h2>
        </div>
        <div className="vcard">
          {activityRows.length > 0 ? (
            <>
              <ul className="vact">
                {activityRows.map((row) => (
                  <li key={row.id}>
                    <span className="t">{formatClock(row.atS)}</span>
                    {/* §3.4: person-or-Guest. Self-heal rows (§6.3 —
                        DSP wedge/recovery, restarts, calibration) have
                        no speaker: em-dash, muted, quiet competence. */}
                    <span className={row.person ? "who" : "who sys"}>
                      {row.person ?? "—"}
                    </span>
                    <span className="what">{row.what}</span>
                  </li>
                ))}
              </ul>
              <div className="vact-foot">
                <Link href="/admin/audit?kind=voice" className="vtext-btn">
                  See all in Activity{" "}
                  <ArrowRight size={13} aria-hidden="true" />
                </Link>
              </div>
            </>
          ) : (
            <div className="vempty">{COPY.activityEmpty}</div>
          )}
        </div>
      </section>

      {/* ── Flow A (§4) ── */}
      {wizardAllowed && (
        <CalibrationWizard
          open={wizardOpen}
          status={status}
          nowS={nowS}
          // §4-result forward hook — only when no voice is enrolled yet
          // and enrollment can actually run here.
          enrollHook={enrollmentAllowed && (profiles?.length ?? 0) === 0}
          onClose={handleWizardClose}
        />
      )}

      {/* ── Flow B (§5 — WARP-1056). Mounted only while open: the
          wizard reads the auth context + fetches the roster, neither of
          which the closed surface should pay for.

          WARP-1599 — and only while enrollment is still ALLOWED, the
          same way Flow A above rides `wizardAllowed`. `enrollmentAllowed`
          gated the entry points but not an already-open wizard, so a
          second admin session (or a second tab) could switch voice off
          while this one recorded scripted lines — the reader of the off
          hero being told no audio was captured while it was. voice-io
          now refuses those captures outright (409); closing the wizard
          is what keeps the admin from walking into that error. Dropping
          the session is safe: it lives in RAM behind speaker_id.py's
          15-minute SESSION_TTL_S, whose docstring names "browser tab
          closed mid-flow" as exactly this case. ── */}
      {enrollOpen && enrollmentAllowed && (
        <EnrollmentWizard
          open
          profiles={profiles}
          presetUserId={enrollPreset}
          onClose={handleEnrollClose}
        />
      )}

      {/* ── §7.3 restart confirm (WARP-1057) ── */}
      <ConfirmDialog
        open={restartConfirmOpen}
        onConfirm={handleRestartConfirm}
        onCancel={() => setRestartConfirmOpen(false)}
        title={RESTART_CONFIRM_TITLE}
        description={RESTART_CONFIRM_BODY}
        confirmLabel="Restart processor"
        variant="neutral"
        accessory={<SafetyChip safety="Write · confirm" />}
      />
    </div>
  );
}
