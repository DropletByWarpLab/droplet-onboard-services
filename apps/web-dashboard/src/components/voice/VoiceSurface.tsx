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
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { SafetyChip } from "@/components/email/SafetyChip";
import { useToast } from "@/components/Toast";
import { measureVoiceLevel, restartVoiceProcessor } from "@/lib/api";
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
  NOISE_FLOOR_PASS_DBFS,
  relTime,
  SPEECH_PEAK_PASS_DBFS,
  type VoiceCheckAction,
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

export interface VoiceSurfaceProps {
  status: VoiceStatusInfo | null;
  calibration: VoiceCalibrationInfo | null;
  /** Orchestrator answered 503 voice_unavailable (voice-io down). */
  unavailable: boolean;
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

export function VoiceSurface({
  status,
  calibration,
  unavailable,
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

  const surface = deriveVoiceSurfaceState({
    status,
    calibration,
    unavailable,
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
      } catch {
        toast("Couldn't measure — the microphone didn't respond.", "error");
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
      } catch {
        toast("Couldn't measure — the microphone didn't respond.", "error");
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
  const enrollmentAllowed = speakerModelAvailable && surface.kind !== "broken";
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

  /* ── Hero content mapping ── */
  const headline =
    surface.kind === "calibrated"
      ? COPY.heroCalibrated
      : surface.kind === "attention"
        ? COPY.heroDrift
        : surface.kind === "broken"
          ? COPY.heroBroken
          : COPY.heroFirstRun;

  const ringStatus =
    surface.kind === "calibrated"
      ? ("ok" as const)
      : surface.kind === "attention"
        ? ("warn" as const)
        : surface.kind === "broken"
          ? ("err" as const)
          : ("neutral" as const);

  const wizardAllowed =
    surface.kind !== "broken" || surface.brokenCause === "flatlined";

  const meterFlat = surface.kind === "broken" || status?.input_rms_dbfs == null;

  function subline() {
    if (surface.kind === "broken") {
      const text =
        surface.brokenCause === "no_mic"
          ? SUB_NO_MIC
          : surface.brokenCause === "flatlined"
            ? SUB_FLATLINED
            : SUB_UNAVAILABLE;
      return <p className="subline">{text}</p>;
    }
    if (surface.kind === "uncalibrated") {
      return <p className="subline">{COPY.firstRunSub}</p>;
    }
    if (surface.kind === "attention") {
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
      {/* ── Status hero (§3.1) ── */}
      <section className="vcard vhero" aria-labelledby="voice-hero-headline">
        <div className="vhero-corner">
          <SafetyChip safety="Read" />
        </div>
        <div className="vhero-row">
          <StatusRing status={ringStatus} />
          <div className="vhero-stack">
            <h2 className="headline" id="voice-hero-headline">
              {headline}
            </h2>
            {subline()}
            <LiveMeter
              dbfs={status?.input_rms_dbfs ?? null}
              flat={meterFlat}
              caption={COPY.meterCap}
            />
          </div>
          <div className="vhero-cta">{heroCta()}</div>
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

      {/* ── Voice profiles (§3.3 — WARP-1056 Flow B) ── */}
      <VoiceProfilesSection
        profiles={profiles}
        enrollmentAllowed={enrollmentAllowed}
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
          which the closed surface should pay for. ── */}
      {enrollOpen && (
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
