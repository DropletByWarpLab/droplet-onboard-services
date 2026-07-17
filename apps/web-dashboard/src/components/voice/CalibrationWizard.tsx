"use client";

/**
 * WARP-1055 — Flow A: the guided mic-calibration wizard (brief §4).
 *
 * 5 steps + result inside the shared <Dialog> (720px, 5 dots,
 * `Write · confirm to apply` chip in the header):
 *
 *   1 · Quiet check   — POST /api/voice/measure {kind: noise_floor}
 *   2 · Talk test     — measure {kind: speech_peak}; auto-gain is
 *                       computed CLIENT-SIDE from the peak (never a
 *                       slider) and carried to the apply payload
 *   3 · Wake word ×3  — passive: watches the live status poll for
 *                       `last_wake_at` changes (3/3 or 2/3-with-note
 *                       passes; ≤1 fails to placement tips)
 *   4 · Echo check    — POST /api/voice/echo-check, fully automatic
 *   5 · Confirm & apply — the ONLY write: POST /api/voice/calibration
 *
 * Cancel-safety (§4.5/§7.4): closing at any point before the result
 * screen writes NOTHING — the parent toasts "Calibration canceled —
 * previous settings kept." Re-entry always restarts at step 1.
 * Every failure maps to a cause + action; never a raw error code.
 * All step copy ships verbatim from §4/§9.
 *
 * WARP-1059: while open, the wizard holds the box in "calibration
 * mode" (enter on open, renew on an interval, exit on close) so the
 * pipeline counts wakes without handling them — no STT/LLM/TTS turn
 * can pollute a measurement window. Best-effort + TTL fail-safe.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ChevronLeft } from "lucide-react";
import { Dialog } from "@/components/Dialog";
import { SafetyChip } from "@/components/email/SafetyChip";
import {
  applyVoiceCalibration,
  enterVoiceCalibrationMode,
  exitVoiceCalibrationMode,
  measureVoiceLevel,
  runVoiceEchoCheck,
} from "@/lib/api";
import type { VoiceCalibrationApply, VoiceStatusInfo } from "@/lib/types";
import {
  CheckState,
  CountdownRing,
  ListeningRing,
  PlaybackArcs,
  ZoneMeter,
} from "./VoiceBits";
import { NOISE_FLOOR_PASS_DBFS, SPEECH_PEAK_PASS_DBFS } from "./state";
import "./voice.css";

/* Capture windows. Step 1 matches the visible 5 s countdown; step 2
   gives a spoken sentence room to land. */
const NOISE_SECONDS = 5;
const SPEECH_SECONDS = 6;
/* WARP-1059 — calibration mode: while the wizard is open, the box
   counts wakes (step 3 rides last_wake_at) but never HANDLES them, so
   the step-2 spec phrase can't start a full turn (STT pausing the
   detector, the LLM reply spoken through the speaker inflating the
   measured peak, a step-2 wake pre-counting for step 3). Fail-safe on
   the box side: the mode auto-expires after the TTL, so we renew well
   inside it and exit explicitly on close — an abandoned tab can never
   leave the assistant deaf. */
const CALIBRATION_MODE_TTL_S = 90;
const CALIBRATION_MODE_RENEW_MS = 30_000;
/* Wake-word listening window before the 3 tries are evaluated. */
const WAKE_WINDOW_MS = 30_000;
/* Brief green-check beat between a pass and the next step. */
const PASS_FLASH_MS = 600;
/* Auto-gain target: put the measured speech peak at a healthy -12 dBFS.
   Clamped so a wild measurement can't produce a distorting gain. */
const TARGET_PEAK_DBFS = -12;
const GAIN_MIN = 0.25;
const GAIN_MAX = 8;

/* Result flags — stored verbatim on the calibration record; the /voice
   page renders flags[0] as the drift banner. */
const FLAG_NOISE =
  "Calibrated over steady background noise — quieting the room and recalibrating will improve range.";
const FLAG_SPEECH =
  "Speech was faint from where you calibrated — moving the box or speaking closer will improve range.";
const FLAG_WAKE =
  "Wake word answered 2 of 3 — worth re-testing after any furniture moves.";
const FLAG_ECHO =
  "Echo check skipped — Droplet may hear you less well while it's playing audio.";

/* §4.2 spoken line + §4.3 wake word — serif capsules, verbatim. */
const TALK_PHRASE = "“Hey Droplet, what's the weather like tomorrow?”";
const WAKE_PHRASE = "“Hey Droplet”";

export function computeAutoGain(peakDbfs: number): number {
  const gain = Math.pow(10, (TARGET_PEAK_DBFS - peakDbfs) / 20);
  return Math.round(Math.min(GAIN_MAX, Math.max(GAIN_MIN, gain)) * 100) / 100;
}

type Step = 1 | 2 | 3 | 4 | 5 | "result";
type Phase = "measuring" | "fail" | "pass";
type FailKind = "threshold" | "request";

export function CalibrationWizard({
  open,
  status,
  nowS,
  onClose,
}: {
  open: boolean;
  /** Live-polled /api/voice/status — drives the zone meters + wake ticks. */
  status: VoiceStatusInfo | null;
  /** Epoch seconds "now" — injectable for deterministic tests. */
  nowS?: number;
  /** applied=true only after the result screen (the write happened). */
  onClose: (result: { applied: boolean }) => void;
}) {
  const [step, setStep] = useState<Step>(1);
  const [phase, setPhase] = useState<Phase>("measuring");
  const [failKind, setFailKind] = useState<FailKind>("threshold");
  const [attempt, setAttempt] = useState(0);
  const [tipsOpen, setTipsOpen] = useState(false);
  const [announce, setAnnounce] = useState("");

  // Measured results — persisted across Back navigation.
  const [noiseFloor, setNoiseFloor] = useState<number | null>(null);
  const [speechPeak, setSpeechPeak] = useState<number | null>(null);
  const [peakLocked, setPeakLocked] = useState(false);
  const [hits, setHits] = useState(0);
  const [wakeEvaluated, setWakeEvaluated] = useState(false);
  const [echoOk, setEchoOk] = useState<boolean | null>(null);
  const [flags, setFlags] = useState<string[]>([]);
  const [applying, setApplying] = useState(false);
  const [applyFailed, setApplyFailed] = useState(false);

  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const later = useCallback((fn: () => void, ms: number) => {
    timersRef.current.push(setTimeout(fn, ms));
  }, []);
  useEffect(
    () => () => timersRef.current.forEach(clearTimeout),
    [],
  );

  const closeRef = useRef<HTMLButtonElement | null>(null);

  const pushFlag = useCallback((flag: string) => {
    setFlags((prev) => (prev.includes(flag) ? prev : [...prev, flag]));
  }, []);

  // Review F2 — a step that PASSES clears its own earlier flag, so a
  // fail → "Continue anyway" → Back → pass run applies a clean record
  // instead of a sticky "needs attention" about a fixed problem.
  const removeFlag = useCallback((flag: string) => {
    setFlags((prev) => prev.filter((f) => f !== flag));
  }, []);

  const goto = useCallback((next: Step) => {
    setStep(next);
    setPhase("measuring");
    setFailKind("threshold");
    setTipsOpen(false);
    setApplyFailed(false);
  }, []);

  const passAndAdvance = useCallback(
    (next: Step, message: string) => {
      setPhase("pass");
      setAnnounce(message);
      later(() => goto(next), PASS_FLASH_MS);
    },
    [goto, later],
  );

  // §7.4 — re-entry always restarts at step 1 with a clean slate.
  useEffect(() => {
    if (!open) return;
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
    setStep(1);
    setPhase("measuring");
    setFailKind("threshold");
    setAttempt(0);
    setTipsOpen(false);
    setAnnounce("");
    setNoiseFloor(null);
    setSpeechPeak(null);
    setPeakLocked(false);
    setHits(0);
    setWakeEvaluated(false);
    setEchoOk(null);
    setFlags([]);
    setApplying(false);
    setApplyFailed(false);
  }, [open]);

  /* ── WARP-1059 · calibration mode brackets the whole session ── */
  // Entered on open + renewed on an interval, exited on ANY close path
  // (cancel, X, Esc, Done — the effect cleanup covers them all).
  // Best-effort by design: a box that can't enter the mode (older
  // voice-io, pipeline down) must not block calibration itself, and the
  // TTL auto-expiry is the fail-safe when the exit call never lands.
  useEffect(() => {
    if (!open) return;
    const enter = () => {
      enterVoiceCalibrationMode(CALIBRATION_MODE_TTL_S).catch(() => {});
    };
    enter();
    const renew = setInterval(enter, CALIBRATION_MODE_RENEW_MS);
    return () => {
      clearInterval(renew);
      exitVoiceCalibrationMode().catch(() => {});
    };
  }, [open]);

  /* ── Step 1 · quiet check ── */
  useEffect(() => {
    if (!open || step !== 1) return;
    let stale = false;
    setPhase("measuring");
    measureVoiceLevel("noise_floor", NOISE_SECONDS)
      .then((r) => {
        if (stale) return;
        setNoiseFloor(r.rms_dbfs);
        if (r.rms_dbfs <= NOISE_FLOOR_PASS_DBFS) {
          removeFlag(FLAG_NOISE); // F2 — a pass clears the earlier fail flag
          passAndAdvance(2, "Room noise measured.");
        } else {
          setFailKind("threshold");
          setPhase("fail");
          setAnnounce("The room is too loud to calibrate over.");
        }
      })
      .catch(() => {
        if (stale) return;
        setFailKind("request");
        setPhase("fail");
        setAnnounce("Couldn't measure the room.");
      });
    return () => {
      stale = true;
    };
  }, [open, step, attempt, passAndAdvance, removeFlag]);

  /* ── Step 2 · talk test ── */
  useEffect(() => {
    if (!open || step !== 2) return;
    let stale = false;
    setPhase("measuring");
    setPeakLocked(false);
    measureVoiceLevel("speech_peak", SPEECH_SECONDS)
      .then((r) => {
        if (stale) return;
        setSpeechPeak(r.peak_dbfs);
        setPeakLocked(true);
        if (r.peak_dbfs >= SPEECH_PEAK_PASS_DBFS) {
          removeFlag(FLAG_SPEECH); // F2
          passAndAdvance(3, "Speech level is good.");
        } else {
          setFailKind("threshold");
          setPhase("fail");
          setAnnounce("Speech was too faint to lock a level.");
        }
      })
      .catch(() => {
        if (stale) return;
        setFailKind("request");
        setPhase("fail");
        setAnnounce("Couldn't measure your speech level.");
      });
    return () => {
      stale = true;
    };
  }, [open, step, attempt, passAndAdvance, removeFlag]);

  /* ── Step 3 · wake word ×3 (passive — watches the live status poll) ── */
  const lastSeenWakeRef = useRef<number | null>(null);
  const hitsRef = useRef(0);
  hitsRef.current = hits;

  const evaluateWake = useCallback(
    (count: number) => {
      setWakeEvaluated(true);
      if (count >= 3) {
        removeFlag(FLAG_WAKE); // F2 — a clean 3/3 clears an earlier 2/3 note
        passAndAdvance(4, "Wake word responding, 3 of 3.");
      } else if (count === 2) {
        pushFlag(FLAG_WAKE);
        passAndAdvance(4, "Wake word responding, 2 of 3 — noted.");
      } else {
        setFailKind("threshold");
        setPhase("fail");
        setAnnounce("The wake word isn't landing.");
      }
    },
    [passAndAdvance, pushFlag, removeFlag],
  );

  useEffect(() => {
    if (!open || step !== 3) return;
    // Fresh listening window: baseline the pipeline's last wake so only
    // NEW detections count.
    lastSeenWakeRef.current = status?.last_wake_at ?? null;
    setHits(0);
    setWakeEvaluated(false);
    const timer = setTimeout(() => evaluateWake(hitsRef.current), WAKE_WINDOW_MS);
    return () => clearTimeout(timer);
    // Baseline once per step entry / retry — not on every status poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, step, attempt]);

  useEffect(() => {
    if (!open || step !== 3 || phase !== "measuring" || wakeEvaluated) return;
    const at = status?.last_wake_at;
    if (at == null || at === lastSeenWakeRef.current) return;
    lastSeenWakeRef.current = at;
    setHits((h) => {
      const next = Math.min(3, h + 1);
      setAnnounce(`Wake word detected, ${next} of 3.`);
      return next;
    });
  }, [open, step, phase, wakeEvaluated, status?.last_wake_at]);

  useEffect(() => {
    if (!open || step !== 3 || phase !== "measuring" || wakeEvaluated) return;
    if (hits >= 3) evaluateWake(3);
  }, [open, step, phase, wakeEvaluated, hits, evaluateWake]);

  /* ── Step 4 · echo check ── */
  useEffect(() => {
    if (!open || step !== 4) return;
    let stale = false;
    setPhase("measuring");
    setAnnounce("Playing test sound.");
    runVoiceEchoCheck()
      .then((r) => {
        if (stale) return;
        if (r.heard) {
          setEchoOk(true);
          removeFlag(FLAG_ECHO); // F2 — a skip flag dies when the re-run passes
          passAndAdvance(5, "Echo cancellation tuned.");
        } else {
          setEchoOk(false);
          setFailKind("threshold");
          setPhase("fail");
          setAnnounce("Droplet couldn't hear its own speaker.");
        }
      })
      .catch(() => {
        if (stale) return;
        setEchoOk(false);
        setFailKind("request");
        setPhase("fail");
        setAnnounce("The speaker check didn't run.");
      });
    return () => {
      stale = true;
    };
  }, [open, step, attempt, passAndAdvance, removeFlag]);

  /* ── Step 5 · the single write ── */
  const ready = noiseFloor != null && speechPeak != null;
  const flagged = flags.length > 0;

  async function handleApply() {
    if (!ready || applying) return;
    setApplying(true);
    setApplyFailed(false);
    const payload: VoiceCalibrationApply = {
      noise_floor_dbfs: noiseFloor as number,
      speech_peak_dbfs: speechPeak as number,
      wake_detections: hits,
      echo_ok: echoOk === true,
      flags,
      input_gain: computeAutoGain(speechPeak as number),
    };
    try {
      await applyVoiceCalibration(payload);
      setStep("result");
      setAnnounce(flagged ? "Calibrated, with notes." : "Calibrated.");
    } catch {
      setApplyFailed(true);
    } finally {
      setApplying(false);
    }
  }

  function retry() {
    setAttempt((a) => a + 1);
  }

  function requestClose() {
    // Review F3 — the single write is in flight: closing now would
    // toast "previous settings kept" while voice-io persists + applies
    // the new record. Ignore Esc / backdrop / the X until it lands
    // (success shows the result screen; failure stays on step 5).
    if (applying) return;
    onClose({ applied: step === "result" });
  }

  const speechPeakLabel =
    speechPeak == null
      ? "—"
      : `${speechPeak >= SPEECH_PEAK_PASS_DBFS ? "good" : "faint"} · ${speechPeak} dB`;

  const resultStamp = `Applied just now · ${new Date(
    (nowS ?? Math.floor(Date.now() / 1000)) * 1000,
  ).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  })}, ${new Date((nowS ?? Math.floor(Date.now() / 1000)) * 1000).toLocaleTimeString(
    "en-US",
    { hour: "2-digit", minute: "2-digit", hour12: false },
  )}`;

  /* ── Per-step body ── */
  function body() {
    if (step === 1) {
      return (
        <div>
          <h2 className="instr" id="voice-wizard-title">
            First, let&apos;s listen to the room.
          </h2>
          <p className="body">
            Stay quiet for a few seconds. Droplet measures the background
            noise so it knows what to listen over.
          </p>
          {phase !== "fail" ? (
            <div>
              <CountdownRing
                key={attempt}
                seconds={NOISE_SECONDS}
                running={phase === "measuring"}
              />
              <ZoneMeter
                dbfs={status?.input_rms_dbfs ?? null}
                zoneLabel="acceptable noise zone"
              />
            </div>
          ) : (
            <FailNote
              message={
                failKind === "threshold"
                  ? "There's steady noise near the mic — a fan, appliance, or music. Move it or turn it down, then try again."
                  : "Couldn't measure the room — the microphone didn't respond. Try again in a moment."
              }
            >
              <button type="button" className="btn ghost" onClick={retry}>
                Try again
              </button>
              {failKind === "threshold" && (
                <button
                  type="button"
                  className="vtext-btn"
                  onClick={() => {
                    pushFlag(FLAG_NOISE);
                    goto(2);
                  }}
                >
                  Continue anyway
                </button>
              )}
            </FailNote>
          )}
        </div>
      );
    }
    if (step === 2) {
      return (
        <div>
          <h2 className="instr" id="voice-wizard-title">
            Say this from where you&apos;d normally talk to Droplet.
          </h2>
          <div>
            <span className="vspoken">{TALK_PHRASE}</span>
          </div>
          {phase !== "fail" ? (
            <div>
              <ZoneMeter
                dbfs={status?.input_rms_dbfs ?? null}
                zoneLabel={
                  peakLocked && speechPeak != null
                    ? `speech peak locked · ${speechPeak} dB`
                    : "target zone — just speak normally"
                }
              />
              <p className="microcap">
                Stand where you usually are — the couch, the desk, the
                kitchen. Not next to the box.
              </p>
            </div>
          ) : (
            <FailNote
              message={
                failKind === "threshold"
                  ? "Droplet can hear you, but only faintly from there. Try moving the box, or speak from a bit closer."
                  : "Couldn't measure your speech — the microphone didn't respond. Try again in a moment."
              }
            >
              <button type="button" className="btn ghost" onClick={retry}>
                Try again
              </button>
              {failKind === "threshold" && (
                <button
                  type="button"
                  className="vtext-btn"
                  onClick={() => {
                    pushFlag(FLAG_SPEECH);
                    goto(3);
                  }}
                >
                  Continue anyway
                </button>
              )}
            </FailNote>
          )}
        </div>
      );
    }
    if (step === 3) {
      return (
        <div>
          <h2 className="instr" id="voice-wizard-title">
            Now just the wake word.
          </h2>
          <div>
            <span className="vspoken">{WAKE_PHRASE}</span>
          </div>
          {phase !== "fail" ? (
            <div>
              <ListeningRing state={phase === "pass" ? "ok" : "listening"} />
              <div className="vticks" aria-label="Wake word detections">
                {[0, 1, 2].map((i) => (
                  <span key={i} className={"vtick" + (i < hits ? " hit" : "")}>
                    {i < hits ? <CheckState status="ok" /> : i + 1}
                  </span>
                ))}
                <span className="sr-only">{`${hits} of 3 detected`}</span>
              </div>
              <p className="microcap">
                Say it three times, with a short pause between.
              </p>
            </div>
          ) : (
            <FailNote message="The wake word isn't landing. This is usually distance or noise — let's check placement.">
              <button
                type="button"
                className="vtext-btn"
                aria-expanded={tipsOpen}
                onClick={() => setTipsOpen((v) => !v)}
              >
                {tipsOpen ? "Hide placement tips" : "Review placement tips"}
              </button>
              <button type="button" className="btn ghost" onClick={retry}>
                Try again
              </button>
            </FailNote>
          )}
          {phase === "fail" && tipsOpen && (
            <div className="vnote warn" role="region" aria-label="Placement tips">
              <ul className="tips">
                <li>Keep the box clear of walls and corners</li>
                <li>Place it above counter height</li>
                <li>Keep it away from speakers</li>
              </ul>
            </div>
          )}
        </div>
      );
    }
    if (step === 4) {
      return (
        <div>
          <h2 className="instr" id="voice-wizard-title">
            Droplet will play a short sound and listen to itself.
          </h2>
          <p className="body">
            This tunes echo cancellation so it can hear you even while
            it&apos;s speaking or playing audio.
          </p>
          {phase !== "fail" ? (
            <div>
              <PlaybackArcs playing={phase === "measuring"} />
              <p className="microcap">Playing test sound…</p>
            </div>
          ) : (
            <FailNote
              message={
                failKind === "threshold"
                  ? "Droplet couldn't hear its own speaker. Check that the speaker isn't muted or disconnected."
                  : "Droplet couldn't run the speaker check — the audio device didn't respond. Try again in a moment."
              }
            >
              <button type="button" className="btn ghost" onClick={retry}>
                Try again
              </button>
            </FailNote>
          )}
        </div>
      );
    }
    if (step === 5) {
      return (
        <div>
          <h2 className="instr" id="voice-wizard-title">
            Confirm and apply
          </h2>
          <p className="body">
            Four checks, measured a moment ago. Nothing is written until
            you apply.
          </p>
          <div className="vsummary">
            <div className="srow">
              <CheckState
                status={flags.includes(FLAG_NOISE) ? "warn" : "ok"}
              />
              <span className="lbl">Noise floor</span>
              <span className="val">
                {noiseFloor != null ? `${noiseFloor} dB` : "—"}
              </span>
            </div>
            <div className="srow">
              <CheckState
                status={flags.includes(FLAG_SPEECH) ? "warn" : "ok"}
              />
              <span className="lbl">Speech peak</span>
              <span className="val">{speechPeakLabel}</span>
            </div>
            <div className="srow">
              <CheckState status={hits >= 3 ? "ok" : "warn"} />
              <span className="lbl">Wake word</span>
              <span className="val">{`${hits}/3`}</span>
            </div>
            <div className="srow">
              <CheckState status={echoOk ? "ok" : "warn"} />
              <span className="lbl">Echo cancellation</span>
              <span className="val">{echoOk ? "tuned" : "skipped"}</span>
            </div>
          </div>
          {applyFailed && (
            <FailNote message="Couldn't save the calibration to your Droplet. Nothing changed — try applying again." />
          )}
        </div>
      );
    }
    // Result screen.
    return (
      <div>
        <div className="vresult-hero">
          <h2 id="voice-wizard-title">
          {flagged ? "Calibrated, with notes" : "Calibrated"}
          </h2>
          <p className="stamp">{resultStamp}</p>
        </div>
        {flagged && (
          <div
            style={{
              maxWidth: 460,
              margin: "14px auto 0",
              textAlign: "left",
              display: "grid",
              gap: 8,
            }}
          >
            {flags.map((f) => (
              <div key={f} className="vnote warn" style={{ margin: 0, maxWidth: "none" }}>
                <AlertTriangle size={15} aria-hidden="true" />
                <div>
                  {f}{" "}
                  <span style={{ color: "var(--color-label-tertiary)" }}>
                    — fix later from the Voice page.
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  /* ── Footer ── */
  function footer() {
    if (step === "result") {
      return (
        <div className="right">
          <button
            type="button"
            className="btn primary"
            onClick={() => onClose({ applied: true })}
          >
            Done
          </button>
        </div>
      );
    }
    return (
      <>
        <div className="left">
          {step > 1 && (
            <button
              type="button"
              className="vtext-btn"
              disabled={applying}
              onClick={() => goto((step - 1) as Step)}
            >
              <ChevronLeft size={14} aria-hidden="true" /> Back
            </button>
          )}
        </div>
        <div className="right">
          {step === 4 && phase !== "pass" && (
            <button
              type="button"
              className="vtext-btn"
              onClick={() => {
                pushFlag(FLAG_ECHO);
                setEchoOk(false);
                goto(5);
              }}
            >
              Skip this check
            </button>
          )}
          {step === 5 && (
            <>
              <button
                type="button"
                className="vtext-btn"
                disabled={applying}
                onClick={() => onClose({ applied: false })}
              >
                Not now
              </button>
              <div style={{ textAlign: "right" }}>
                <button
                  type="button"
                  className="btn primary"
                  disabled={!ready || applying}
                  aria-busy={applying || undefined}
                  onClick={() => void handleApply()}
                >
                  {applying ? "Applying…" : "Apply calibration"}
                </button>
                <p className="vmeter-cap" style={{ marginTop: 6 }}>
                  Saves these settings to your Droplet. You can recalibrate
                  anytime.
                </p>
              </div>
            </>
          )}
        </div>
      </>
    );
  }

  return (
    <Dialog
      open={open}
      onClose={requestClose}
      labelledBy="voice-wizard-title"
      maxWidth="2xl"
      initialFocusRef={closeRef}
      // Sectioned scoped design (WARP-1055 brief §4) — `voice.css` owns the
      // wizard's header/body insets (WARP-1153).
      flush
    >
      <div className="voice-wizard">
        <div className="vwiz-h">
          <div className="ttl">
            <span>Microphone setup</span>
            <SafetyChip safety="Write · confirm" />
          </div>
          {step !== "result" ? (
            <div
              className="vdots"
              aria-label={`Step ${step} of 5`}
              role="img"
            >
              {[1, 2, 3, 4, 5].map((n) => (
                <span
                  key={n}
                  className={n === step ? "on" : n < step ? "done" : ""}
                />
              ))}
            </div>
          ) : (
            <span />
          )}
          <button
            ref={closeRef}
            type="button"
            className="close"
            aria-label="Close"
            disabled={applying}
            onClick={requestClose}
          >
            ×
          </button>
        </div>
        <div className="vwiz-body">
          {/* §8 — every visual state change is announced. */}
          <div aria-live="polite" className="sr-only">
            {announce}
          </div>
          {body()}
        </div>
        <div className="vwiz-f">{footer()}</div>
      </div>
    </Dialog>
  );
}

function FailNote({
  message,
  children,
}: {
  message: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="vnote warn">
      <AlertTriangle size={16} aria-hidden="true" />
      <div>
        {message}
        {children ? (
          <div style={{ display: "flex", gap: 10, marginTop: 10, alignItems: "center" }}>
            {children}
          </div>
        ) : null}
      </div>
    </div>
  );
}
