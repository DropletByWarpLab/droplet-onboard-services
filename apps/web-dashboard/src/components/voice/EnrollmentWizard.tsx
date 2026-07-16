"use client";

/**
 * WARP-1056 — Flow B: voice enrollment ("so it knows it's me"), §5.
 *
 * Same modal shell as Flow A (shared <Dialog>, `Write · confirm to
 * apply` chip, dots top-center): 3 steps + confirm.
 *
 *   1 · Who is this   — person picker over the EXISTING directory
 *                       (minus already-enrolled); the always-visible
 *                       privacy panel. Continue opens the on-box
 *                       enrollment session.
 *   2 · Read the lines — 4 scripted phrases, one serif capsule at a
 *                       time, auto-advance on capture; per-line "Redo";
 *                       the §5 too-quiet re-prompt (once, automatic)
 *                       and the §7.5 crosstalk guard.
 *   3 · Prove it works — the no-script verify. Success shows the plain
 *                       confidence word (High / Good — NEVER a
 *                       percentage). First mismatch appends 2 sharpen
 *                       lines and re-tests; second mismatch falls back
 *                       honestly (enrollment still saves, flagged
 *                       "Learning").
 *   4 · Confirm       — "Save [Name]'s voice" is the ONE write.
 *
 * Cancel-safety: any close before the commit fires DELETE
 * /api/voice/enroll/:session — the box discards the captured
 * embeddings immediately ("Cancel deletes these recordings now."), and
 * nothing was ever persisted. All §5/§7.5/§9 copy ships verbatim.
 *
 * HARD RULE (§5 note): a saved voiceprint personalizes — it never
 * authenticates. Confirm-tier actions a recognized speaker asks for
 * still route to the dashboard/phone.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, RotateCcw, ShieldCheck, UserRound } from "lucide-react";
import { Dialog } from "@/components/Dialog";
import { SafetyChip } from "@/components/email/SafetyChip";
import { useAuth } from "@/lib/auth";
import {
  cancelVoiceEnrollment,
  captureVoiceEnrollmentLine,
  commitVoiceEnrollment,
  fetchUsers,
  startVoiceEnrollment,
  verifyVoiceEnrollment,
} from "@/lib/api";
import type { RosterUser, VoiceProfileInfo } from "@/lib/types";
import { CheckState, ListeningRing } from "./VoiceBits";
import "./voice.css";

/* §5 step 2 — the four scripted lines, verbatim. */
const SCRIPTED_LINES = [
  "“Hey Droplet, turn off the kitchen lights.”",
  "“Hey Droplet, what's on my calendar today?”",
  "“Hey Droplet, is anyone at the front door?”",
  "“Hey Droplet, remind me to call back after lunch.”",
] as const;

/* §5 step 3 — the two sharpen lines appended after a first mismatch
   ("Two more lines will sharpen it."). Same spoken-dialogue styling. */
const SHARPEN_LINES = [
  "“Hey Droplet, what time is it?”",
  "“Hey Droplet, play something quiet in the kitchen.”",
] as const;

const ALL_LINES = [...SCRIPTED_LINES, ...SHARPEN_LINES];

/* Verbatim guard + step copy (§5 / §7.5 / §9). */
const COPY = {
  whoTitle: "Whose voice is this?",
  privacyPanel:
    "Your voiceprint is a mathematical summary of how you sound — not a recording. It's created and stored on this box, never uploaded, and deleted the moment you remove it.",
  linesTitle: "Read each line naturally.",
  tooQuiet: "That one was hard to hear — once more.",
  crosstalk:
    "It sounds like more than one person is talking. Enrollment works best solo — find a quiet moment and try again.",
  captureRequestFail:
    "The microphone didn't respond. Try again in a moment.",
  verifyTitle: "One more time, no script.",
  verifyBody: "Say anything to Droplet — ask it something real.",
  mismatchOnce:
    "Droplet heard you but wasn't sure it was you. Two more lines will sharpen it.",
  fallback:
    "Recognition isn't reliable in this room yet. Your voice is saved and will improve as you use it, or you can re-record later from the Voice page.",
  cancelNote: "Cancel deletes these recordings now.",
} as const;

type Step = "who" | "lines" | "verify" | "confirm";
const STEP_ORDER: Step[] = ["who", "lines", "verify", "confirm"];

export interface EnrollmentWizardProps {
  open: boolean;
  /** Enrolled voiceprints — filters the picker (minus already-enrolled). */
  profiles: VoiceProfileInfo[] | null;
  /** Preselect this person (People-row "Add voice" deep-link, the
   *  post-calibration hook, or a profile row's "Re-record voice" —
   *  re-record passes an ENROLLED id, which stays pickable). */
  presetUserId?: string | null;
  /** saved=true only after the commit landed (the write happened). */
  onClose: (result: { saved: boolean; name?: string }) => void;
}

export function EnrollmentWizard({
  open,
  profiles,
  presetUserId,
  onClose,
}: EnrollmentWizardProps) {
  const { user: currentUser } = useAuth();

  const [step, setStep] = useState<Step>("who");
  const [roster, setRoster] = useState<RosterUser[] | null>(null);
  const [rosterFailed, setRosterFailed] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  // Step 2 — line captures. `captured` mirrors the server's count.
  const [linesTotal, setLinesTotal] = useState<number>(SCRIPTED_LINES.length);
  const [captured, setCaptured] = useState(0);
  const [current, setCurrent] = useState(0);
  const [redoIndex, setRedoIndex] = useState<number | null>(null);
  const [capturePhase, setCapturePhase] = useState<"capturing" | "fail">(
    "capturing",
  );
  const [captureFailMsg, setCaptureFailMsg] = useState("");
  const [captureAttempt, setCaptureAttempt] = useState(0);
  const autoRetriedRef = useRef(false);

  // Step 3 — verify.
  const [verifyPhase, setVerifyPhase] = useState<
    "capturing" | "success" | "mismatch" | "fallback" | "fail"
  >("capturing");
  const [verifyFailMsg, setVerifyFailMsg] = useState("");
  const [confidence, setConfidence] = useState<"high" | "good" | null>(null);
  const [verifyMisses, setVerifyMisses] = useState(0);
  const [verifyAttempt, setVerifyAttempt] = useState(0);

  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [announce, setAnnounce] = useState("");

  const closeRef = useRef<HTMLButtonElement | null>(null);
  const sessionRef = useRef<string | null>(null);
  sessionRef.current = sessionId;

  const enrolledIds = new Set((profiles ?? []).map((p) => p.user_id));

  /* Pickable people: local directory rows, minus already-enrolled —
     except the preset (re-record targets an enrolled person). */
  const pickable = (roster ?? []).filter(
    (u): u is RosterUser & { userId: string } =>
      typeof u.userId === "string" &&
      u.userId.length > 0 &&
      (!enrolledIds.has(u.userId) || u.userId === presetUserId),
  );
  const selected = pickable.find((u) => u.userId === selectedId) ?? null;
  const selectedName = selected ? selected.displayName || selected.id : "";

  /* Fresh slate on every open (§7.4 posture — measurements are cheap). */
  useEffect(() => {
    if (!open) return;
    setStep("who");
    setRoster(null);
    setRosterFailed(false);
    setSelectedId(null);
    setSessionId(null);
    setStartError(null);
    setStarting(false);
    setLinesTotal(SCRIPTED_LINES.length);
    setCaptured(0);
    setCurrent(0);
    setRedoIndex(null);
    setCapturePhase("capturing");
    setCaptureFailMsg("");
    setCaptureAttempt(0);
    autoRetriedRef.current = false;
    setVerifyPhase("capturing");
    setVerifyFailMsg("");
    setConfidence(null);
    setVerifyMisses(0);
    setVerifyAttempt(0);
    setSaving(false);
    setSaveFailed(false);
    setAnnounce("");
  }, [open]);

  /* Load the person picker. */
  const [rosterAttempt, setRosterAttempt] = useState(0);
  useEffect(() => {
    if (!open) return;
    let stale = false;
    setRosterFailed(false);
    fetchUsers()
      .then((r) => {
        if (!stale) setRoster(r.users);
      })
      .catch(() => {
        if (!stale) setRosterFailed(true);
      });
    return () => {
      stale = true;
    };
  }, [open, rosterAttempt]);

  /* Preselect: the deep-linked person, else yourself when you have no
     voiceprint yet (§5 step 1). */
  useEffect(() => {
    if (!open || !roster || selectedId) return;
    const preset = presetUserId
      ? pickable.find((u) => u.userId === presetUserId)
      : undefined;
    const self = pickable.find(
      (u) => currentUser?.id && u.userId === currentUser.id,
    );
    const pick = preset ?? self;
    if (pick) setSelectedId(pick.userId);
    // pickable derives from roster/profiles — keying on roster is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, roster]);

  /* ── Step 1 → 2: open the on-box session ── */
  async function handleContinueFromWho() {
    if (!selected || starting) return;
    setStarting(true);
    setStartError(null);
    try {
      const r = await startVoiceEnrollment(selected.userId);
      setSessionId(r.session_id);
      setStep("lines");
      setAnnounce(`Reading lines as ${selectedName}.`);
    } catch (err) {
      setStartError(
        err instanceof Error && err.message
          ? err.message
          : "Couldn't start voice enrollment.",
      );
    } finally {
      setStarting(false);
    }
  }

  /* ── Step 2: capture the current line ── */
  useEffect(() => {
    if (!open || step !== "lines" || sessionId == null) return;
    if (capturePhase !== "capturing") return;
    let stale = false;
    const index = redoIndex ?? current;
    const isRedo = redoIndex != null;
    captureVoiceEnrollmentLine(sessionId, isRedo ? index : undefined)
      .then((r) => {
        if (stale) return;
        if (r.quality === "good") {
          autoRetriedRef.current = false;
          setCaptureFailMsg("");
          setCaptured(r.captured);
          setRedoIndex(null);
          setAnnounce(`Line ${index + 1} captured.`);
          if (!isRedo) {
            if (r.captured >= linesTotal) {
              setStep("verify");
              setVerifyPhase("capturing");
              setVerifyAttempt((a) => a + 1);
            } else {
              setCurrent(r.captured);
            }
          } else if (captured >= linesTotal) {
            // Redo after everything was already read → back to verify.
            setStep("verify");
            setVerifyPhase("capturing");
            setVerifyAttempt((a) => a + 1);
          }
          return;
        }
        // Capture guard (§5 / §7.5). Too-quiet re-prompts ONCE
        // automatically; crosstalk (and a second quiet take) waits for
        // an explicit retry.
        const msg = r.quality === "crosstalk" ? COPY.crosstalk : COPY.tooQuiet;
        setAnnounce(msg);
        if (r.quality === "too_quiet" && !autoRetriedRef.current) {
          autoRetriedRef.current = true;
          setCaptureFailMsg(msg);
          setCaptureAttempt((a) => a + 1); // re-arm this effect
          return;
        }
        setCaptureFailMsg(msg);
        setCapturePhase("fail");
      })
      .catch(() => {
        if (stale) return;
        setCaptureFailMsg(COPY.captureRequestFail);
        setCapturePhase("fail");
        setAnnounce(COPY.captureRequestFail);
      });
    return () => {
      stale = true;
    };
    // `captured`/`linesTotal` are read for post-capture routing only —
    // re-arming on them would double-capture a line.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, step, sessionId, current, redoIndex, capturePhase, captureAttempt]);

  function retryCapture() {
    autoRetriedRef.current = false;
    setCapturePhase("capturing");
    setCaptureAttempt((a) => a + 1);
  }

  function redoLine(index: number) {
    setRedoIndex(index);
    autoRetriedRef.current = false;
    setCapturePhase("capturing");
    setCaptureAttempt((a) => a + 1);
    setAnnounce(`Redoing line ${index + 1}.`);
  }

  /* ── Step 3: the no-script verify ── */
  useEffect(() => {
    if (!open || step !== "verify" || sessionId == null) return;
    if (verifyPhase !== "capturing") return;
    let stale = false;
    verifyVoiceEnrollment(sessionId)
      .then((r) => {
        if (stale) return;
        if (r.quality !== "good") {
          setVerifyFailMsg(
            r.quality === "crosstalk" ? COPY.crosstalk : COPY.tooQuiet,
          );
          setVerifyPhase("fail");
          return;
        }
        if (r.matched) {
          setConfidence(r.confidence ?? "good");
          setVerifyPhase("success");
          setAnnounce(`Got it — Droplet recognized ${selectedName}.`);
          return;
        }
        const misses = verifyMisses + 1;
        setVerifyMisses(misses);
        if (misses === 1) {
          // §5: append 2 extra capture lines, re-test.
          setLinesTotal(SCRIPTED_LINES.length + SHARPEN_LINES.length);
          setVerifyPhase("mismatch");
          setAnnounce(COPY.mismatchOnce);
        } else {
          // Second failure → honest fallback; saving still allowed
          // (the box flags the profile "Learning").
          setVerifyPhase("fallback");
          setAnnounce(COPY.fallback);
        }
      })
      .catch(() => {
        if (stale) return;
        setVerifyFailMsg(COPY.captureRequestFail);
        setVerifyPhase("fail");
      });
    return () => {
      stale = true;
    };
    // selectedName/verifyMisses only feed the resolution handling —
    // re-arming on them would double-capture the verify utterance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, step, sessionId, verifyPhase, verifyAttempt]);

  function startSharpenLines() {
    setStep("lines");
    setCurrent(captured);
    setCapturePhase("capturing");
    setCaptureAttempt((a) => a + 1);
  }

  /* ── Confirm: the ONE write ── */
  async function handleSave() {
    if (!sessionId || saving) return;
    setSaving(true);
    setSaveFailed(false);
    try {
      await commitVoiceEnrollment(sessionId);
      setSessionId(null); // consumed on the box — nothing to discard
      onClose({ saved: true, name: selectedName });
    } catch {
      setSaveFailed(true);
    } finally {
      setSaving(false);
    }
  }

  function requestClose() {
    if (saving) return; // the write is in flight — never close under it
    const sid = sessionRef.current;
    if (sid) {
      // "Cancel deletes these recordings now." — best-effort; the box's
      // session TTL is the fail-safe if this never lands.
      cancelVoiceEnrollment(sid).catch(() => {});
    }
    onClose({ saved: false });
  }

  const stepIndex = STEP_ORDER.indexOf(step);
  const lineIndex = redoIndex ?? current;

  /* ── Bodies ── */
  function whoBody() {
    return (
      <div>
        <h2 className="instr" id="voice-enroll-title">
          {COPY.whoTitle}
        </h2>
        {rosterFailed ? (
          <FailNote message="Couldn't load the people on this Droplet.">
            <button
              type="button"
              className="dp-btn-secondary type-footnote"
              onClick={() => setRosterAttempt((a) => a + 1)}
            >
              Try again
            </button>
          </FailNote>
        ) : roster == null ? (
          <p className="body">Loading people…</p>
        ) : pickable.length === 0 ? (
          <p className="body">
            Everyone on this Droplet already has a voice profile.
          </p>
        ) : (
          <div
            className="venroll-picker"
            role="radiogroup"
            aria-label="Whose voice is this?"
          >
            {pickable.map((u) => {
              const name = u.displayName || u.id;
              const active = u.userId === selectedId;
              return (
                <button
                  key={u.userId}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  className={"venroll-person" + (active ? " on" : "")}
                  onClick={() => setSelectedId(u.userId)}
                >
                  <span className="pav">
                    <UserRound size={15} aria-hidden="true" />
                  </span>
                  <span className="pname">{name}</span>
                  {enrolledIds.has(u.userId) && (
                    <span className="pmeta">re-record</span>
                  )}
                </button>
              );
            })}
          </div>
        )}
        {startError && <FailNote message={startError} />}
        {/* §5 step 1 — privacy panel, always visible, never collapsible. */}
        <div className="venroll-privacy" role="note">
          <ShieldCheck size={15} aria-hidden="true" />
          <span>{COPY.privacyPanel}</span>
        </div>
      </div>
    );
  }

  function linesBody() {
    return (
      <div>
        <h2 className="instr" id="voice-enroll-title">
          {COPY.linesTitle}
        </h2>
        <div>
          <span className="vspoken">{ALL_LINES[lineIndex]}</span>
        </div>
        {capturePhase !== "fail" ? (
          <div>
            <ListeningRing state="listening" />
            {captureFailMsg && autoRetriedRef.current && (
              <p className="microcap" role="status">
                {captureFailMsg}
              </p>
            )}
          </div>
        ) : (
          <FailNote message={captureFailMsg}>
            <button
              type="button"
              className="dp-btn-secondary type-footnote"
              onClick={retryCapture}
            >
              Try again
            </button>
          </FailNote>
        )}
        {/* §5 — 4 dots that fill (6 after sharpen lines), Redo per
            captured line. */}
        <div className="venroll-dots" aria-label="Lines captured">
          {Array.from({ length: linesTotal }).map((_, i) => {
            const done = i < captured;
            const isCurrent = i === lineIndex;
            return (
              <span
                key={i}
                className={
                  "venroll-dot" + (done ? " done" : "") + (isCurrent ? " on" : "")
                }
              >
                {done ? <CheckState status="ok" /> : i + 1}
                {done && (
                  <button
                    type="button"
                    className="vredo"
                    aria-label={`Redo line ${i + 1}`}
                    // The box records one thing at a time (capture
                    // lock) — a redo can't overlap the live capture.
                    disabled={capturePhase === "capturing"}
                    onClick={() => redoLine(i)}
                  >
                    <RotateCcw size={11} aria-hidden="true" /> Redo
                  </button>
                )}
              </span>
            );
          })}
          <span className="sr-only">{`${captured} of ${linesTotal} lines captured`}</span>
        </div>
      </div>
    );
  }

  function verifyBody() {
    if (verifyPhase === "success") {
      return (
        <div>
          <h2 className="instr" id="voice-enroll-title">
            Got it — Droplet recognized {selectedName}.
          </h2>
          <div>
            <ListeningRing state="ok" />
          </div>
          {/* Plain word only (§5): High / Good — never a percentage. */}
          <p className="body">
            Confidence: {confidence === "high" ? "High" : "Good"}
          </p>
        </div>
      );
    }
    if (verifyPhase === "fallback") {
      return (
        <div>
          <h2 className="instr" id="voice-enroll-title">
            {COPY.verifyTitle}
          </h2>
          <FailNote message={COPY.fallback} />
        </div>
      );
    }
    return (
      <div>
        <h2 className="instr" id="voice-enroll-title">
          {COPY.verifyTitle}
        </h2>
        <p className="body">{COPY.verifyBody}</p>
        {verifyPhase === "capturing" ? (
          <ListeningRing state="listening" />
        ) : verifyPhase === "mismatch" ? (
          <FailNote message={COPY.mismatchOnce}>
            <button
              type="button"
              className="dp-btn-secondary type-footnote"
              onClick={startSharpenLines}
            >
              Read two more lines
            </button>
          </FailNote>
        ) : (
          <FailNote message={verifyFailMsg}>
            <button
              type="button"
              className="dp-btn-secondary type-footnote"
              onClick={() => {
                setVerifyPhase("capturing");
                setVerifyAttempt((a) => a + 1);
              }}
            >
              Try again
            </button>
          </FailNote>
        )}
      </div>
    );
  }

  function confirmBody() {
    return (
      <div>
        <h2 className="instr" id="voice-enroll-title">
          Save {selectedName}&apos;s voice
        </h2>
        <p className="body">{COPY.privacyPanel}</p>
        {verifyMisses >= 2 && (
          <p className="microcap">
            Saved as “Learning” — recognition improves as {selectedName} uses
            it, or re-record anytime from this page.
          </p>
        )}
        {saveFailed && (
          <FailNote message="Couldn't save the voice profile to your Droplet. Nothing changed — try again." />
        )}
      </div>
    );
  }

  /* ── Footer ── */
  function footer() {
    if (step === "who") {
      return (
        <div className="right">
          <button
            type="button"
            className="dp-btn-primary type-subheadline"
            disabled={!selected || starting}
            aria-busy={starting || undefined}
            onClick={() => void handleContinueFromWho()}
          >
            {starting ? "Starting…" : "Continue"}
          </button>
        </div>
      );
    }
    if (step === "verify" && (verifyPhase === "success" || verifyPhase === "fallback")) {
      return (
        <div className="right">
          <button
            type="button"
            className="dp-btn-primary type-subheadline"
            onClick={() => setStep("confirm")}
          >
            Continue
          </button>
        </div>
      );
    }
    if (step === "confirm") {
      return (
        <>
          <div className="left">
            <button
              type="button"
              className="vtext-btn"
              disabled={saving}
              onClick={requestClose}
            >
              Cancel
            </button>
            <span className="vcancel-note">{COPY.cancelNote}</span>
          </div>
          <div className="right">
            <button
              type="button"
              className="dp-btn-primary type-subheadline"
              disabled={saving}
              aria-busy={saving || undefined}
              onClick={() => void handleSave()}
            >
              {saving ? "Saving…" : `Save ${selectedName}'s voice`}
            </button>
          </div>
        </>
      );
    }
    // Lines / verify: capture runs continuously — the only way out is
    // the X/Esc cancel (which discards the recordings immediately).
    return <div className="left" />;
  }

  return (
    <Dialog
      open={open}
      onClose={requestClose}
      labelledBy="voice-enroll-title"
      maxWidth="2xl"
      initialFocusRef={closeRef}
      flush
    >
      <div className="voice-wizard">
        <div className="vwiz-h">
          <div className="ttl">
            <span>Add a voice</span>
            <SafetyChip safety="Write · confirm" />
          </div>
          <div
            className="vdots"
            aria-label={`Step ${stepIndex + 1} of ${STEP_ORDER.length}`}
            role="img"
          >
            {STEP_ORDER.map((s, i) => (
              <span
                key={s}
                className={i === stepIndex ? "on" : i < stepIndex ? "done" : ""}
              />
            ))}
          </div>
          <button
            ref={closeRef}
            type="button"
            className="close"
            aria-label="Close"
            disabled={saving}
            onClick={requestClose}
          >
            ×
          </button>
        </div>
        <div className="vwiz-body">
          <div aria-live="polite" className="sr-only">
            {announce}
          </div>
          {step === "who"
            ? whoBody()
            : step === "lines"
              ? linesBody()
              : step === "verify"
                ? verifyBody()
                : confirmBody()}
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
