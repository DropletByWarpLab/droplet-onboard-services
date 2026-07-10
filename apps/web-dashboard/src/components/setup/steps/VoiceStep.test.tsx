/**
 * VoiceStep — WARP-1036: the wizard's "hey droplet" try-it step.
 *
 * Contract under test:
 *  - happy path renders the wake-phrase hero + live try-it (1 s status poll:
 *    a `last_wake_at` change is the wake confirmation, then the transcript
 *    and spoken reply render as they land);
 *  - speaker test button POSTs the fixed test phrase through /api/voice/say;
 *  - `state: "no_mic"` renders the plug-in panel (hot-plug needs no restart)
 *    with Continue always enabled;
 *  - the explicit 503 `voice_unavailable` (voice-io not deployed) auto-skips
 *    the step — but a GENERIC error surfaces with a retry instead of a
 *    silent skip (WARP-933).
 *
 * WARP-1050 — a mic present but DEAF (the wedged-DSP flatline #818/WARP-1037
 * surfaces as `input_flatlined` on /voice/status) must render a distinct
 * "mic isn't receiving audio" state with reset/replug guidance, instead of
 * showing the "say Hey Droplet" hero and letting the customer conclude the
 * wake word is broken.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { VoiceStep } from "./VoiceStep";

const fetchVoiceStatus = vi.fn();
const sayVoiceTest = vi.fn();

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    fetchVoiceStatus: (...a: unknown[]) => fetchVoiceStatus(...a),
    sayVoiceTest: (...a: unknown[]) => sayVoiceTest(...a),
  };
});

function listeningStatus(overrides: Record<string, unknown> = {}) {
  return {
    state: "listening",
    listening: true,
    wake_loaded: true,
    wake_model: "hey_droplet",
    using_wake_fallback: false,
    threshold: 0.7,
    last_wake_at: null,
    last_transcript: null,
    last_transcript_at: null,
    last_response: null,
    last_response_at: null,
    stt_loaded: true,
    tts_loaded: true,
    llm_loaded: true,
    ...overrides,
  };
}

function unavailableError() {
  const e = new Error("voice unavailable") as Error & { code?: string };
  e.code = "voice_unavailable";
  return e;
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchVoiceStatus.mockResolvedValue(listeningStatus());
  sayVoiceTest.mockResolvedValue({ ok: true, duration_s: 1.4 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("VoiceStep — happy path (mic present, listening)", () => {
  it("renders the wake-phrase hero and Continue advances", async () => {
    const onComplete = vi.fn();
    render(
      <VoiceStep onComplete={onComplete} onSkip={vi.fn()} onAutoSkip={vi.fn()} />,
    );
    expect(
      await screen.findByText(/hey droplet/i),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^continue$/i }));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("plays the fixed test phrase through the box speaker", async () => {
    render(
      <VoiceStep onComplete={vi.fn()} onSkip={vi.fn()} onAutoSkip={vi.fn()} />,
    );
    const btn = await screen.findByRole("button", {
      name: /play a test message/i,
    });
    fireEvent.click(btn);
    await waitFor(() =>
      expect(sayVoiceTest).toHaveBeenCalledWith("Hi — I'm your Droplet"),
    );
  });

  it("shows the wake confirmation, then transcript and reply, as the poll sees them land", async () => {
    vi.useFakeTimers();
    fetchVoiceStatus
      // initial load — no wake yet
      .mockResolvedValueOnce(listeningStatus())
      // poll 1 — wake fired
      .mockResolvedValueOnce(listeningStatus({ last_wake_at: 111.1 }))
      // poll 2 — transcript + reply landed
      .mockResolvedValue(
        listeningStatus({
          last_wake_at: 111.1,
          last_transcript: "is the front camera online",
          last_transcript_at: 112.2,
          last_response: "Yes — the front camera is online.",
          last_response_at: 114.4,
        }),
      );

    render(
      <VoiceStep onComplete={vi.fn()} onSkip={vi.fn()} onAutoSkip={vi.fn()} />,
    );
    // Flush the initial fetch.
    await act(async () => {});
    expect(screen.getByText(/hey droplet/i)).toBeInTheDocument();
    expect(screen.queryByText(/heard you/i)).not.toBeInTheDocument();

    // Poll 1 → wake confirmation.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(screen.getByText(/heard you/i)).toBeInTheDocument();

    // Poll 2 → transcript + spoken reply.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(
      screen.getByText(/is the front camera online/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/yes — the front camera is online\./i),
    ).toBeInTheDocument();
  });
});

describe("VoiceStep — no microphone", () => {
  it("renders the plug-in panel with Continue enabled (hot-plug, no restart)", async () => {
    fetchVoiceStatus.mockResolvedValue(
      listeningStatus({ state: "no_mic", listening: false, wake_loaded: false }),
    );
    const onComplete = vi.fn();
    render(
      <VoiceStep onComplete={onComplete} onSkip={vi.fn()} onAutoSkip={vi.fn()} />,
    );
    expect(
      await screen.findByText(/no microphone detected/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/no restart needed/i)).toBeInTheDocument();
    const cont = screen.getByRole("button", { name: /^continue$/i });
    expect(cont).toBeEnabled();
    fireEvent.click(cont);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});

describe("VoiceStep — availability contract (WARP-933)", () => {
  it("auto-skips on the explicit voice_unavailable error", async () => {
    fetchVoiceStatus.mockRejectedValue(unavailableError());
    const onAutoSkip = vi.fn();
    render(
      <VoiceStep onComplete={vi.fn()} onSkip={vi.fn()} onAutoSkip={onAutoSkip} />,
    );
    await waitFor(() => expect(onAutoSkip).toHaveBeenCalledTimes(1));
  });

  it("surfaces a generic error with a retry — never a silent skip", async () => {
    fetchVoiceStatus.mockRejectedValue(new Error("boom"));
    const onAutoSkip = vi.fn();
    render(
      <VoiceStep onComplete={vi.fn()} onSkip={vi.fn()} onAutoSkip={onAutoSkip} />,
    );
    // WARP-1105 — the surfaced check-failure now reads honestly as "the voice
    // assistant isn't responding" (a real fault the user can retry) rather
    // than the vaguer "couldn't check" that read as a transient blip.
    expect(
      await screen.findByText(/isn.t responding/i),
    ).toBeInTheDocument();
    expect(onAutoSkip).not.toHaveBeenCalled();
    // Retry recovers to the happy path.
    fetchVoiceStatus.mockResolvedValue(listeningStatus());
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(await screen.findByText(/hey droplet/i)).toBeInTheDocument();
  });

  it("keeps Skip available while loading", async () => {
    let resolve!: (v: unknown) => void;
    fetchVoiceStatus.mockImplementation(
      () => new Promise((r) => (resolve = r)),
    );
    const onSkip = vi.fn();
    render(
      <VoiceStep onComplete={vi.fn()} onSkip={onSkip} onAutoSkip={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
    expect(onSkip).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolve(listeningStatus());
    });
  });
});

describe("VoiceStep — dead mic / flatline (WARP-1050)", () => {
  it("renders the 'mic isn't receiving audio' state when input_flatlined is true", async () => {
    fetchVoiceStatus.mockResolvedValue(
      listeningStatus({
        input_flatlined: true,
        input_rms_dbfs: -120,
        last_audio_at: null,
      }),
    );
    const onComplete = vi.fn();
    render(
      <VoiceStep onComplete={onComplete} onSkip={vi.fn()} onAutoSkip={vi.fn()} />,
    );
    // Honest headline: the mic isn't picking up sound.
    expect(
      await screen.findByText(/isn.t (picking up|receiving)/i),
    ).toBeInTheDocument();
    // Actionable guidance — reset/replug the mic.
    expect(screen.getByText(/reset|replug|unplug/i)).toBeInTheDocument();
    // It must NOT imply the wake word is broken: no "say hey droplet" hero
    // and no "listening" pulse while the mic is flatlined.
    expect(screen.queryByText(/say .?hey droplet/i)).not.toBeInTheDocument();
    // Continue is always reachable — this never blocks setup.
    const cont = screen.getByRole("button", { name: /^continue$/i });
    expect(cont).toBeEnabled();
    fireEvent.click(cont);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("recovers to the healthy try-it hero when a later poll clears the flatline", async () => {
    vi.useFakeTimers();
    fetchVoiceStatus
      // initial load — flatlined (dead mic)
      .mockResolvedValueOnce(
        listeningStatus({ input_flatlined: true, input_rms_dbfs: -120 }),
      )
      // poll — the DSP recovered, real signal is flowing again
      .mockResolvedValue(
        listeningStatus({ input_flatlined: false, input_rms_dbfs: -42.5 }),
      );

    render(
      <VoiceStep onComplete={vi.fn()} onSkip={vi.fn()} onAutoSkip={vi.fn()} />,
    );
    await act(async () => {});
    expect(screen.getByText(/isn.t (picking up|receiving)/i)).toBeInTheDocument();
    expect(screen.queryByText(/say .?hey droplet/i)).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(screen.getByText(/say .?hey droplet/i)).toBeInTheDocument();
    expect(
      screen.queryByText(/isn.t (picking up|receiving)/i),
    ).not.toBeInTheDocument();
  });
});

describe("VoiceStep — voice service reachable but unhealthy (WARP-1105)", () => {
  it("renders an honest 'not responding' state (not the try-it hero) when the pipeline latched state:'error'", async () => {
    // voice-io answers /voice/status with 200 but a state the wizard can't
    // teach against: the pipeline latched `error` (a boot-race STT/TTS/LLM
    // reachability failure — WARP-1092). It is NOT no_mic and NOT flatlined,
    // so the pre-WARP-1105 code fell through to the "say Hey Droplet" hero and
    // told the customer to talk to an assistant that can't hear them.
    fetchVoiceStatus.mockResolvedValue(
      listeningStatus({
        state: "error",
        listening: false,
        error_message: "stt unreachable",
      }),
    );
    const onComplete = vi.fn();
    render(
      <VoiceStep onComplete={onComplete} onSkip={vi.fn()} onAutoSkip={vi.fn()} />,
    );
    // Honest headline: the voice assistant isn't responding.
    expect(await screen.findByText(/isn.t responding/i)).toBeInTheDocument();
    // It must NOT show the try-it hero (nothing would happen if they spoke).
    expect(screen.queryByText(/say .?hey droplet/i)).not.toBeInTheDocument();
    // A working retry is offered.
    expect(
      screen.getByRole("button", { name: /try again/i }),
    ).toBeInTheDocument();
    // Continue is always reachable — voice never blocks setup.
    const cont = screen.getByRole("button", { name: /^continue$/i });
    expect(cont).toBeEnabled();
    fireEvent.click(cont);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("recovers to the try-it hero when a later poll clears the error", async () => {
    vi.useFakeTimers();
    fetchVoiceStatus
      // initial load — pipeline errored
      .mockResolvedValueOnce(
        listeningStatus({ state: "error", listening: false }),
      )
      // poll — the dependency recovered, pipeline is listening again
      .mockResolvedValue(listeningStatus());

    render(
      <VoiceStep onComplete={vi.fn()} onSkip={vi.fn()} onAutoSkip={vi.fn()} />,
    );
    await act(async () => {});
    expect(screen.getByText(/isn.t responding/i)).toBeInTheDocument();
    expect(screen.queryByText(/say .?hey droplet/i)).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(screen.getByText(/say .?hey droplet/i)).toBeInTheDocument();
    expect(screen.queryByText(/isn.t responding/i)).not.toBeInTheDocument();
  });
});
