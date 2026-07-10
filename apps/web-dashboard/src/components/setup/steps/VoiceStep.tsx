"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, AlertTriangle, Mic, MicOff, Volume2 } from "lucide-react";
import {
  fetchVoiceStatus,
  sayVoiceTest,
  isVoiceUnavailableError,
} from "@/lib/api";
import type { VoiceStatusInfo } from "@/lib/types";
import { StepShell } from "@/components/setup/StepShell";

/** WARP-1036 — status poll cadence while the customer is on this step, so a
 *  "hey droplet" they just said (or a mic they just plugged in) shows up
 *  live. Bounded by React cleanup; never a while-true. */
const VOICE_POLL_INTERVAL_MS = 1_000;

/** The fixed speaker-test phrase. */
const SPEAKER_TEST_TEXT = "Hi — I'm your Droplet";

/**
 * Wizard step — meet the always-on voice assistant (WARP-1036).
 *
 * voice-io ships on every real appliance (`linux` compose profile) and has
 * been listening for "hey droplet" since boot — but nothing in the product
 * ever TOLD the customer, which is the whole reason this step exists. It:
 *
 *  - fetches `/api/voice/status` on enter and keeps polling ~1 s while the
 *    step is mounted (a wake they just triggered flips `last_wake_at`; the
 *    transcript + spoken reply land moments later and render as they do);
 *  - offers a speaker test (`POST /api/voice/say`) so the customer hears
 *    the box talk before they walk away from setup;
 *  - renders a plug-in panel when `state === "no_mic"` — the pipeline's
 *    hot-plug rescan arms voice the moment a mic appears, no restart, so
 *    Continue stays enabled and the poll keeps watching for the flip;
 *  - renders a distinct "mic isn't picking up sound" panel when the
 *    pipeline reports `input_flatlined` (WARP-1050) — a mic is present and
 *    the pipeline is nominally "listening", but no audio is reaching it
 *    (the wedged-DSP signature #818/WARP-1037 detects). Without this the
 *    customer says "hey droplet", nothing happens, and they wrongly
 *    conclude wake-word detection is broken. We name the real fault (the
 *    mic isn't receiving audio) and give the fix (reset / replug it); the
 *    poll keeps watching so a recovery flips straight back to the try-it
 *    hero, no restart;
 *  - auto-skips ONLY on the orchestrator's explicit 503 `voice_unavailable`
 *    (voice-io not deployed — macOS dev), mirroring how storage/cameras
 *    treat genuinely-absent hardware surfaces. Per WARP-933 a generic
 *    error renders with a retry instead — silent skips read as "the page
 *    doesn't work".
 */
export function VoiceStep({
  onComplete,
  onSkip,
  onAutoSkip,
}: {
  onComplete: () => void;
  onSkip: () => void;
  /** voice-io not deployed at all — advance without rendering the step. */
  onAutoSkip: () => void;
}) {
  const [status, setStatus] = useState<VoiceStatusInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [sayState, setSayState] = useState<"idle" | "playing" | "failed">(
    "idle",
  );

  // Async-safety refs: `alive` guards setState after unmount; `skipped`
  // makes the auto-skip fire exactly once; `baseline` pins the pipeline's
  // timestamps as of step-entry so only wake/transcript/reply events that
  // happen DURING the step count as the try-it confirmation.
  const alive = useRef(true);
  const skipped = useRef(false);
  const baseline = useRef<{
    wakeAt: number | null;
    transcriptAt: number | null;
    responseAt: number | null;
  } | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const s = await fetchVoiceStatus();
      if (!alive.current) return;
      if (baseline.current === null) {
        baseline.current = {
          wakeAt: s.last_wake_at ?? null,
          transcriptAt: s.last_transcript_at ?? null,
          responseAt: s.last_response_at ?? null,
        };
      }
      setStatus(s);
      setLoadError(false);
    } catch (err) {
      if (!alive.current) return;
      if (isVoiceUnavailableError(err)) {
        // voice-io isn't deployed here — nothing to show, nothing to teach.
        if (!skipped.current) {
          skipped.current = true;
          onAutoSkip();
        }
        return;
      }
      // WARP-933 — a generic failure surfaces; it never silently skips.
      setLoadError(true);
    } finally {
      if (alive.current) setLoading(false);
    }
    // onAutoSkip comes from the page's identity-stable autoSkip callback.
  }, [onAutoSkip]);

  useEffect(() => {
    void load();
  }, [load]);

  // Live try-it poll — also how a hot-plugged mic flips no_mic → listening.
  // A transient tick failure is ignored; the next tick retries. Stops
  // permanently once the step auto-skipped (unmount clears the interval).
  useEffect(() => {
    const timer = setInterval(() => {
      if (skipped.current) return;
      void fetchVoiceStatus()
        .then((s) => {
          if (!alive.current || skipped.current) return;
          if (baseline.current === null) {
            baseline.current = {
              wakeAt: s.last_wake_at ?? null,
              transcriptAt: s.last_transcript_at ?? null,
              responseAt: s.last_response_at ?? null,
            };
          }
          setStatus(s);
          setLoadError(false);
        })
        .catch(() => {});
    }, VOICE_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  async function handleSpeakerTest() {
    setSayState("playing");
    try {
      await sayVoiceTest(SPEAKER_TEST_TEXT);
      if (alive.current) setSayState("idle");
    } catch {
      if (alive.current) setSayState("failed");
    }
  }

  // Try-it progress relative to the step-entry baseline.
  const base = baseline.current;
  const wakeHeard =
    status?.last_wake_at != null && status.last_wake_at !== base?.wakeAt;
  const freshTranscript =
    wakeHeard &&
    status?.last_transcript != null &&
    status.last_transcript_at !== base?.transcriptAt
      ? status.last_transcript
      : null;
  const freshResponse =
    wakeHeard &&
    status?.last_response != null &&
    status.last_response_at !== base?.responseAt
      ? status.last_response
      : null;

  // WARP-1050 — a mic is present (not `no_mic`) but the pipeline sees no
  // audio: `input_flatlined` is voice-io's wedged-DSP / dead-mic signature
  // (#818). The pipeline still reports "listening", so left alone the
  // customer would say "hey droplet", get nothing, and blame the wake word.
  // We render the honest fault + fix instead of the try-it hero.
  const micFlatlined = status?.input_flatlined === true;

  const shellProps = {
    current: "voice" as const,
    title: "Talk to your Droplet",
    subtitle:
      "It listens for a wake phrase and answers out loud — everything stays on the box.",
    skip: { label: "Skip for now", onClick: onSkip },
  };

  // WARP-1105 — one honest "voice assistant isn't responding" panel, shared by
  // the two reachable-but-unhealthy shapes below so they read the same and
  // both offer a real retry:
  //   (a) the check itself failed — a relayed upstream fault / non-2xx (voice-io
  //       reachable but the pipeline faulted; a genuinely-unreachable container
  //       is the DISTINCT 503 voice_unavailable that auto-skips above, not this);
  //   (b) /voice/status answered 200 with a latched `state: "error"` — the
  //       boot-race STT/TTS/LLM reachability failure (WARP-1092), which used to
  //       fall through to the "say Hey Droplet" hero and tell the customer to
  //       talk to an assistant that can't hear them.
  // Continue stays reachable (voice never blocks setup); the 1 s poll flips
  // straight back to the try-it hero the moment voice-io recovers, no restart.
  // This replaces the vaguer "couldn't check" copy, which read as a transient
  // blip rather than a service that's actually down.
  const retryVoiceCheck = () => {
    setLoading(true);
    setLoadError(false);
    void load();
  };
  const renderNotResponding = () => (
    <StepShell
      {...shellProps}
      primary={{ label: "Continue", onClick: onComplete, showArrow: true }}
    >
      <div className="dp-card !py-6 flex flex-col items-center gap-2 text-center">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-system-orange/10">
          <AlertTriangle size={20} className="text-system-orange" />
        </div>
        <p className="type-subheadline text-label-primary">
          The voice assistant isn&rsquo;t responding right now
        </p>
        <p className="type-caption-1 text-label-tertiary max-w-xs">
          Your Droplet keeps trying on its own — this page updates the moment
          it&rsquo;s working again. You can also continue and finish setting it
          up later in Settings.
        </p>
        <button
          type="button"
          onClick={retryVoiceCheck}
          className="dp-btn-secondary type-footnote mt-1"
        >
          Try again
        </button>
      </div>
    </StepShell>
  );

  // Initial probe still in flight — calm skeleton, Skip always reachable.
  if (loading && status === null && !loadError) {
    return (
      <StepShell {...shellProps}>
        <div className="dp-card !py-6 flex items-center gap-3 opacity-30">
          <div className="w-10 h-10 rounded-full bg-surface-secondary animate-pulse motion-reduce:animate-none" />
          <div className="flex-1 space-y-1.5">
            <div className="h-3 w-40 bg-surface-secondary rounded animate-pulse motion-reduce:animate-none" />
            <div className="h-2.5 w-24 bg-surface-secondary rounded animate-pulse motion-reduce:animate-none" />
          </div>
        </div>
      </StepShell>
    );
  }

  // Generic check failure (voice-io deployed but the check errored — a relayed
  // non-2xx or a transport failure short of the voice_unavailable auto-skip).
  // Surface it honestly with a real retry; never a silent skip (WARP-933).
  if (loadError && status === null) {
    return renderNotResponding();
  }

  // No microphone — voice is ready to arm the moment one appears.
  if (status?.state === "no_mic") {
    return (
      <StepShell
        {...shellProps}
        primary={{ label: "Continue", onClick: onComplete, showArrow: true }}
      >
        <div className="dp-card !py-6 flex flex-col items-center gap-2 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-accent/10">
            <MicOff size={20} className="text-accent" />
          </div>
          <p className="type-subheadline text-label-primary">
            No microphone detected
          </p>
          <p className="type-caption-1 text-label-tertiary max-w-xs">
            Plug in a USB microphone and it goes live right away — no restart
            needed. This page will notice as soon as it&rsquo;s connected.
          </p>
        </div>
      </StepShell>
    );
  }

  // Mic present but deaf (WARP-1050) — voice-io is "listening" yet no audio
  // is reaching the pipeline (`input_flatlined`). Name the real fault and
  // the fix; DON'T show the "say hey droplet" hero, which would read as
  // "wake-word detection is broken". The poll keeps running, so the moment
  // audio flows again this flips back to the try-it hero with no restart.
  if (micFlatlined) {
    return (
      <StepShell
        {...shellProps}
        primary={{ label: "Continue", onClick: onComplete, showArrow: true }}
      >
        <div className="dp-card !py-6 flex flex-col items-center gap-2 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-system-orange/10">
            <AlertTriangle size={20} className="text-system-orange" />
          </div>
          <p className="type-subheadline text-label-primary">
            The microphone isn&rsquo;t picking up sound
          </p>
          <p className="type-caption-1 text-label-tertiary max-w-xs">
            Your Droplet is listening, but the microphone isn&rsquo;t sending
            any audio — so it can&rsquo;t hear &ldquo;Hey Droplet&rdquo; yet.
            Try unplugging the microphone and plugging it back in. It goes live
            again on its own — no restart needed, and this page will notice as
            soon as it&rsquo;s working.
          </p>
        </div>
      </StepShell>
    );
  }

  // WARP-1105 — reachable but unhealthy: /voice/status answered 200 with the
  // pipeline latched in `error` (a boot-race STT/TTS/LLM reachability failure —
  // WARP-1092). It's not no_mic and not flatlined, so before this branch it
  // fell through to the try-it hero below and told the customer to say "Hey
  // Droplet" to an assistant that can't hear them ("still not working"). Render
  // the honest not-responding panel instead; the poll flips back to the hero
  // the moment the pipeline leaves `error`.
  if (status?.state === "error") {
    return renderNotResponding();
  }

  // Happy path — mic present, pipeline armed (or mid-utterance).
  return (
    <StepShell
      {...shellProps}
      primary={{ label: "Continue", onClick: onComplete, showArrow: true }}
    >
      <div className="space-y-3">
        <div className="dp-card !py-8 flex flex-col items-center gap-3 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-accent/10">
            <Mic size={22} className="text-accent" />
          </div>
          <p className="type-title-2 text-label-primary">
            Say &ldquo;Hey Droplet&rdquo;
          </p>
          <p className="type-caption-1 text-label-tertiary max-w-xs">
            Then ask it something — try &ldquo;what time is it?&rdquo;
          </p>
          {status?.state === "listening" && !wakeHeard && (
            <p className="flex items-center gap-2 type-caption-1 text-label-secondary">
              <span
                aria-hidden="true"
                className="h-2 w-2 rounded-full bg-system-green animate-pulse motion-reduce:animate-none"
              />
              Listening
            </p>
          )}
          {status?.using_wake_fallback && status.requested_wake_word && (
            <p className="type-caption-1 text-label-tertiary">
              Configured phrase: {status.requested_wake_word} — currently
              answering to {status.wake_model}
            </p>
          )}
        </div>

        {/* Live try-it feedback (poll-driven). aria-live so the confirmation
            is announced without moving focus. */}
        <div role="status" aria-live="polite" className="space-y-2">
          {wakeHeard && (
            <div className="dp-card !py-3 flex items-center gap-3">
              <span
                aria-hidden="true"
                className="h-2 w-2 rounded-full bg-system-green flex-shrink-0"
              />
              <p className="type-subheadline text-label-primary">
                Heard you — it&rsquo;s listening for your question
              </p>
            </div>
          )}
          {freshTranscript && (
            <div className="dp-card !py-3">
              <p className="type-caption-1 text-label-tertiary">You said</p>
              <p className="type-subheadline text-label-primary">
                {freshTranscript}
              </p>
            </div>
          )}
          {freshResponse && (
            <div className="dp-card !py-3">
              <p className="type-caption-1 text-label-tertiary">It replied</p>
              <p className="type-subheadline text-label-primary">
                {freshResponse}
              </p>
            </div>
          )}
        </div>

        <div className="dp-card !py-3 flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent/10 flex-shrink-0">
            <Volume2 size={18} className="text-accent" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="type-subheadline text-label-primary">
              Check the speaker
            </p>
            <p className="type-caption-1 text-label-tertiary">
              The box will say a short hello out loud.
            </p>
          </div>
          <button
            type="button"
            onClick={handleSpeakerTest}
            disabled={sayState === "playing"}
            className="dp-btn-secondary type-footnote !px-3 flex-shrink-0"
          >
            {sayState === "playing" ? "Playing…" : "Play a test message"}
          </button>
        </div>
        {sayState === "failed" && (
          <div className="flex items-start gap-2 type-footnote text-system-red bg-system-red/10 rounded-sm px-3 py-2">
            <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
            <span>
              Couldn&rsquo;t play the test message. Check the speaker and try
              again.
            </span>
          </div>
        )}

        <p className="type-caption-1 text-label-tertiary">
          Wake word, speech to text, and replies are all processed on this
          Droplet — your voice never leaves the box.
        </p>
      </div>
    </StepShell>
  );
}
