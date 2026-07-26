/**
 * WARP-1055 — Flow A calibration wizard behavior contract.
 *
 * All hardware I/O mocked at the api module boundary. Pins:
 *   1. step 1 measures the noise floor and auto-advances on a quiet room;
 *   2. the loud-room failure branch renders §4.1 copy VERBATIM with
 *      Try again · Continue anyway (flagged);
 *   3. the full happy path ends in ONE write — `applyVoiceCalibration`
 *      with the measured values + client-computed auto-gain — and the
 *      serif "Calibrated" result;
 *   4. cancel-safe: closing mid-flow or "Not now" on step 5 fires NO
 *      write (§4.5/§7.4);
 *   5. skipping the echo check flags the result ("Calibrated, with
 *      notes") and records echo_ok: false.
 *
 * Proven RED first: CalibrationWizard does not exist yet.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/* WARP-1345 UX review — §8 hit targets + dark-mode primary ink. jsdom
   doesn't cascade external stylesheets (the PreviewPane.hit-targets
   precedent asserts the component class and documents the CSS-driven
   size), so the CSS side of both contracts is pinned at the source,
   the darkmode-dropdown.test.ts mechanism. */
const voiceCss = readFileSync(
  resolve(__dirname, "../components/voice/voice.css"),
  "utf8",
);

vi.mock("@/lib/api", () => ({
  measureVoiceLevel: vi.fn(),
  runVoiceEchoCheck: vi.fn(),
  applyVoiceCalibration: vi.fn(),
  // WARP-1059 — the wizard brackets its session in calibration mode.
  enterVoiceCalibrationMode: vi.fn(async () => ({ active: true })),
  exitVoiceCalibrationMode: vi.fn(async () => ({ active: false })),
}));

import { CalibrationWizard } from "@/components/voice/CalibrationWizard";
import {
  measureVoiceLevel,
  runVoiceEchoCheck,
  applyVoiceCalibration,
  enterVoiceCalibrationMode,
  exitVoiceCalibrationMode,
} from "@/lib/api";
import type { VoiceStatusInfo } from "@/lib/types";

const NOW = 1_751_000_000;

function status(overrides: Partial<VoiceStatusInfo> = {}): VoiceStatusInfo {
  return {
    enabled: true,
    state: "listening",
    listening: true,
    wake_loaded: true,
    threshold: 0.7,
    input_rms_dbfs: -52,
    input_flatlined: false,
    last_wake_at: null,
    ...overrides,
  };
}

const measureMock = vi.mocked(measureVoiceLevel);
const echoMock = vi.mocked(runVoiceEchoCheck);
const applyMock = vi.mocked(applyVoiceCalibration);
const enterModeMock = vi.mocked(enterVoiceCalibrationMode);
const exitModeMock = vi.mocked(exitVoiceCalibrationMode);

/** Quiet room + good speech peak defaults. */
function mockHealthyMeasurements() {
  measureMock.mockImplementation(async (kind: string) =>
    kind === "noise_floor"
      ? { rms_dbfs: -55, peak_dbfs: -40, duration_s: 5 }
      : { rms_dbfs: -30, peak_dbfs: -18, duration_s: 6 },
  );
  echoMock.mockResolvedValue({ heard: true, tone_dbfs: -22, floor_dbfs: -57 });
}

function renderWizard(
  props: Partial<React.ComponentProps<typeof CalibrationWizard>> = {},
) {
  const onClose = vi.fn();
  const utils = render(
    <CalibrationWizard
      open
      status={status()}
      nowS={NOW}
      onClose={onClose}
      {...props}
    />,
  );
  return { ...utils, onClose };
}

/** Drive step 3 (wake ×3) by feeding fresh last_wake_at values. */
async function driveWakeHits(
  rerender: (ui: React.ReactElement) => void,
  onClose: ReturnType<typeof vi.fn>,
  hits: number,
) {
  await screen.findByText("Now just the wake word.", undefined, {
    timeout: 3000,
  });
  for (let i = 1; i <= hits; i++) {
    rerender(
      <CalibrationWizard
        open
        status={status({ last_wake_at: NOW + i })}
        nowS={NOW}
        onClose={onClose}
      />,
    );
    // Let the detection effect run between ticks.
    // eslint-disable-next-line no-await-in-loop
    await waitFor(() => {
      expect(screen.getByLabelText("Wake word detections")).toHaveTextContent(
        String(i),
      );
    });
  }
}

/** WARP-1520 — the 409 voice-io answers when its capture lock is held. */
function busyError(): Error & { status?: number } {
  const e = new Error(
    "Another microphone measurement is already running — try again in a few seconds.",
  ) as Error & { status?: number };
  e.status = 409;
  return e;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("CalibrationWizard (WARP-1055)", () => {
  it("step 1 measures the noise floor and auto-advances on a quiet room", async () => {
    mockHealthyMeasurements();
    renderWizard();
    expect(
      screen.getByText("First, let's listen to the room."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Stay quiet for a few seconds. Droplet measures the background noise so it knows what to listen over.",
      ),
    ).toBeInTheDocument();
    expect(measureMock).toHaveBeenCalledWith("noise_floor", 5);

    // Auto-advance to the talk test after the pass flash.
    expect(
      await screen.findByText(
        "Say this from where you'd normally talk to Droplet.",
        undefined,
        { timeout: 3000 },
      ),
    ).toBeInTheDocument();
    // The §4.2 spoken line, serif capsule, verbatim.
    expect(
      screen.getByText("“Hey Droplet, what's the weather like tomorrow?”"),
    ).toBeInTheDocument();
    // The step-2 talk-test measurement fires from a post-commit effect, so it
    // can land a tick after the heading renders. Poll for it rather than
    // asserting synchronously the instant `findByText` resolves — a bare
    // expect here races React's passive-effect flush and flakes (WARP-1162).
    await waitFor(() =>
      expect(measureMock).toHaveBeenCalledWith("speech_peak", 6),
    );
  });

  it("loud room: §4.1 failure copy verbatim; Continue anyway flags and advances", async () => {
    measureMock.mockResolvedValue({
      rms_dbfs: -20,
      peak_dbfs: -10,
      duration_s: 5,
    });
    renderWizard();
    expect(
      await screen.findByText(
        "There's steady noise near the mic — a fan, appliance, or music. Move it or turn it down, then try again.",
        undefined,
        { timeout: 3000 },
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Continue anyway" }));
    expect(
      await screen.findByText(
        "Say this from where you'd normally talk to Droplet.",
      ),
    ).toBeInTheDocument();
  });

  /* WARP-1520 — voice-io's capture lock answers 409 to an overlapping
     capture. That's "busy", never "the microphone didn't respond" —
     the old catch-all copy read as a dead mic on a healthy one. */
  it("a 409 busy rejection renders the honest busy copy, and Try again re-measures (WARP-1520)", async () => {
    mockHealthyMeasurements();
    measureMock.mockRejectedValueOnce(busyError());
    renderWizard();

    expect(
      await screen.findByText(
        "Droplet's microphone is busy finishing another listening check. Give it a few seconds, then try again.",
        undefined,
        { timeout: 3000 },
      ),
    ).toBeInTheDocument();
    // The dead-mic lie must be gone…
    expect(
      screen.queryByText(
        "Couldn't measure the room — the microphone didn't respond. Try again in a moment.",
      ),
    ).toBeNull();
    // …and busy is not a threshold fail: no "Continue anyway" escape hatch.
    expect(
      screen.queryByRole("button", { name: "Continue anyway" }),
    ).toBeNull();

    // Try again re-invokes the measure; with the capture gate it now
    // waits its turn and (here, mocked healthy) passes to step 2.
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByText(
        "Say this from where you'd normally talk to Droplet.",
        undefined,
        { timeout: 3000 },
      ),
    ).toBeInTheDocument();
    expect(
      measureMock.mock.calls.filter((c) => c[0] === "noise_floor"),
    ).toHaveLength(2);
  });

  it("a plain network rejection still shows the didn't-respond copy (WARP-1520)", async () => {
    measureMock.mockRejectedValueOnce(new Error("network down"));
    renderWizard();

    expect(
      await screen.findByText(
        "Couldn't measure the room — the microphone didn't respond. Try again in a moment.",
        undefined,
        { timeout: 3000 },
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/microphone is busy finishing another listening check/),
    ).toBeNull();
  });

  it("a 503 rejection (dead mic / service down) is never classified busy (WARP-1520)", async () => {
    // voice-io's operational faults come through throwVoiceError stamped
    // status: 503 — they must keep the didn't-respond copy; "busy — try
    // again in a few seconds" on a dead mic would be the inverse lie.
    const dead = new Error(
      "The microphone didn't respond (device busy or disconnected). Check the mic and try again.",
    ) as Error & { status?: number };
    dead.status = 503;
    measureMock.mockRejectedValueOnce(dead);
    renderWizard();

    expect(
      await screen.findByText(
        "Couldn't measure the room — the microphone didn't respond. Try again in a moment.",
        undefined,
        { timeout: 3000 },
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/microphone is busy finishing another listening check/),
    ).toBeNull();
  });

  it("step 2: a 409 busy rejection on the talk test renders the busy copy (WARP-1520)", async () => {
    // Step 1 (noise floor) passes; the step-2 speech capture hits the
    // held capture lock.
    measureMock.mockImplementation(async (kind: string) => {
      if (kind === "noise_floor") {
        return { rms_dbfs: -55, peak_dbfs: -40, duration_s: 5 };
      }
      throw busyError();
    });
    renderWizard();

    await screen.findByText(
      "Say this from where you'd normally talk to Droplet.",
      undefined,
      { timeout: 3000 },
    );
    expect(
      await screen.findByText(
        "Droplet's microphone is busy finishing another listening check. Give it a few seconds, then try again.",
        undefined,
        { timeout: 3000 },
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(
        "Couldn't measure your speech — the microphone didn't respond. Try again in a moment.",
      ),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Try again" }),
    ).toBeInTheDocument();
  });

  it("step 4: a 409 echo-check rejection renders the busy speaker copy (WARP-1520)", async () => {
    mockHealthyMeasurements();
    echoMock.mockRejectedValueOnce(busyError());
    const { rerender, onClose } = renderWizard();
    await driveWakeHits(rerender, onClose, 3);

    // The check STOPPED (it needs Try again, nothing auto-resumes), and
    // the contended resource is the mic — the copy says both.
    expect(
      await screen.findByText(
        "Droplet's speaker check couldn't start — the microphone is busy with another listening check. Give it a few seconds, then try again.",
        undefined,
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(
        "Droplet couldn't run the speaker check — the audio device didn't respond. Try again in a moment.",
      ),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Try again" }),
    ).toBeInTheDocument();
  });

  it("full pass: one write with measured values + auto-gain, serif result", async () => {
    mockHealthyMeasurements();
    applyMock.mockResolvedValue({ calibrated: true });
    const { rerender, onClose } = renderWizard();

    await driveWakeHits(rerender, onClose, 3);

    // Echo check runs automatically, then the confirm step.
    await screen.findByText("Confirm and apply", undefined, { timeout: 5000 });
    expect(echoMock).toHaveBeenCalledTimes(1);
    // Summary carries mono measured values.
    expect(screen.getByText("-55 dB")).toBeInTheDocument();
    expect(screen.getByText("3/3")).toBeInTheDocument();

    // Nothing has been written yet.
    expect(applyMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Apply calibration" }));
    // §9 apply sub-caption, verbatim.
    expect(
      screen.getByText(
        "Saves these settings to your Droplet. You can recalibrate anytime.",
      ),
    ).toBeInTheDocument();

    await screen.findByText("Calibrated", undefined, { timeout: 3000 });
    expect(applyMock).toHaveBeenCalledTimes(1);
    const payload = applyMock.mock.calls[0][0];
    expect(payload.noise_floor_dbfs).toBe(-55);
    expect(payload.speech_peak_dbfs).toBe(-18);
    expect(payload.wake_detections).toBe(3);
    expect(payload.echo_ok).toBe(true);
    expect(payload.flags).toEqual([]);
    // Auto-gain: target -12 dBFS over a -18 dBFS peak ≈ ×2.
    expect(payload.input_gain).toBeCloseTo(2, 1);

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalledWith({ applied: true });
  });

  it("closing mid-flow writes nothing", async () => {
    mockHealthyMeasurements();
    const { onClose } = renderWizard();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledWith({ applied: false });
    expect(applyMock).not.toHaveBeenCalled();
  });

  it('"Not now" on the confirm step writes nothing', async () => {
    mockHealthyMeasurements();
    const { rerender, onClose } = renderWizard();
    await driveWakeHits(rerender, onClose, 3);
    await screen.findByText("Confirm and apply", undefined, { timeout: 5000 });

    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(onClose).toHaveBeenCalledWith({ applied: false });
    expect(applyMock).not.toHaveBeenCalled();
  });

  it("skipping the echo check flags the result and records echo_ok: false", async () => {
    mockHealthyMeasurements();
    echoMock.mockResolvedValue({
      heard: false,
      tone_dbfs: -80,
      floor_dbfs: -60,
    });
    applyMock.mockResolvedValue({ calibrated: true });
    const { rerender, onClose } = renderWizard();
    await driveWakeHits(rerender, onClose, 3);

    // §4.4 failure copy, verbatim.
    await screen.findByText(
      "Droplet couldn't hear its own speaker. Check that the speaker isn't muted or disconnected.",
      undefined,
      { timeout: 5000 },
    );
    fireEvent.click(screen.getByRole("button", { name: "Skip this check" }));

    await screen.findByText("Confirm and apply");
    fireEvent.click(screen.getByRole("button", { name: "Apply calibration" }));
    await screen.findByText("Calibrated, with notes", undefined, {
      timeout: 3000,
    });
    const payload = applyMock.mock.calls[0][0];
    expect(payload.echo_ok).toBe(false);
    expect(payload.flags).toEqual([
      "Echo check skipped — Droplet may hear you less well while it's playing audio.",
    ]);
  });

  it("a step that fails, is skipped, then PASSES applies a flagless record (review F2)", async () => {
    mockHealthyMeasurements();
    // First echo run fails (→ Skip flags it); the re-run after Back passes.
    echoMock
      .mockResolvedValueOnce({ heard: false, tone_dbfs: -80, floor_dbfs: -60 })
      .mockResolvedValue({ heard: true, tone_dbfs: -22, floor_dbfs: -57 });
    applyMock.mockResolvedValue({ calibrated: true });
    const { rerender, onClose } = renderWizard();
    await driveWakeHits(rerender, onClose, 3);

    await screen.findByText(
      "Droplet couldn't hear its own speaker. Check that the speaker isn't muted or disconnected.",
      undefined,
      { timeout: 5000 },
    );
    fireEvent.click(screen.getByRole("button", { name: "Skip this check" }));
    await screen.findByText("Confirm and apply");
    expect(screen.getByText("skipped")).toBeInTheDocument();

    // Back to the echo step — this time it passes, which must clear
    // the sticky skip flag AND flip echo_ok.
    fireEvent.click(screen.getByRole("button", { name: /Back/ }));
    await screen.findByText("Confirm and apply", undefined, { timeout: 5000 });
    await waitFor(() => expect(screen.getByText("tuned")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Apply calibration" }));
    await screen.findByText("Calibrated", undefined, { timeout: 3000 });
    const payload = applyMock.mock.calls[0][0];
    expect(payload.echo_ok).toBe(true);
    expect(payload.flags).toEqual([]);
  });

  it("brackets the session in calibration mode: enter on open, exit on close (WARP-1059)", async () => {
    mockHealthyMeasurements();
    const { onClose, unmount } = renderWizard();
    // Entered as soon as the wizard opens — before any measurement can
    // trip a wake — with the renewable TTL.
    expect(enterModeMock).toHaveBeenCalledWith(90);
    expect(exitModeMock).not.toHaveBeenCalled();

    // ANY close path exits the mode (the effect cleanup owns it) —
    // here the X mid-flow…
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledWith({ applied: false });
    unmount();
    expect(exitModeMock).toHaveBeenCalledTimes(1);
  });

  it("renews calibration mode on the interval while open (WARP-1059)", async () => {
    vi.useFakeTimers();
    try {
      // Keep step 1 pending forever so only the renew interval ticks.
      measureMock.mockImplementation(() => new Promise(() => {}) as never);
      render(
        <CalibrationWizard open status={status()} nowS={NOW} onClose={vi.fn()} />,
      );
      expect(enterModeMock).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(30_000);
      expect(enterModeMock).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(30_000);
      expect(enterModeMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a box that can't enter calibration mode doesn't block the wizard (WARP-1059)", async () => {
    // Best-effort contract: enter/exit failures are swallowed — the
    // measurement flow still runs (the TTL fail-safe covers the box side).
    enterModeMock.mockRejectedValue(new Error("voice_unavailable"));
    exitModeMock.mockRejectedValue(new Error("voice_unavailable"));
    mockHealthyMeasurements();
    renderWizard();
    expect(
      await screen.findByText(
        "Say this from where you'd normally talk to Droplet.",
        undefined,
        { timeout: 3000 },
      ),
    ).toBeInTheDocument();
  });

  it("buttons use the indigo shell idiom — no legacy dp-btn tokens (WARP-1345)", async () => {
    // The wizard's Dialog portals to document.body but carries the
    // `droplet-shell` scope on its backdrop, so the shell `btn` classes
    // resolve. Fail-state retries are quiet; the confirm/result actions
    // are primary-weight. Legacy `dp-btn-*` / `type-*` must be gone.
    measureMock.mockResolvedValue({
      rms_dbfs: -20,
      peak_dbfs: -10,
      duration_s: 5,
    });
    renderWizard();
    const tryAgain = await screen.findByRole(
      "button",
      { name: "Try again" },
      { timeout: 3000 },
    );
    expect(tryAgain).toHaveClass("btn", "ghost");
    // §8 — wizard actions are never the shell's 30px `sm` variant.
    expect(tryAgain).not.toHaveClass("sm");
    expect(tryAgain.className).not.toMatch(/dp-btn|type-/);
    expect(document.body.innerHTML).not.toContain("dp-btn");
  });

  it("wizard actions clear the §8 ≥44px hit-target floor (WARP-1345)", async () => {
    // Component side: the fail-state retry is a shell `btn` (never `sm`),
    // so the scoped voice.css rule below attaches to it — the same
    // class-presence mechanism as PreviewPane.hit-targets.test.tsx.
    measureMock.mockResolvedValue({
      rms_dbfs: -20,
      peak_dbfs: -10,
      duration_s: 5,
    });
    renderWizard();
    const tryAgain = await screen.findByRole(
      "button",
      { name: "Try again" },
      { timeout: 3000 },
    );
    expect(tryAgain).toHaveClass("btn");
    expect(tryAgain).not.toHaveClass("sm");

    // CSS side: the shell's `.btn` is 36px tall (droplet-shell.css); the
    // voice canon (DESIGN-BRIEF §8) hard-specs ≥44px for all wizard
    // actions, matching `.vtext-btn`'s documented floor. One scoped rule
    // — no per-callsite overrides (banned by voice.css's own comment).
    const rule = voiceCss.match(/\.voice-wizard \.btn\s*\{([^}]*)\}/);
    expect(rule, "voice.css must scope `.voice-wizard .btn`").not.toBeNull();
    expect(rule![1]).toMatch(/min-height:\s*44px/);
  });

  it("dark-mode primary ink is overridden for /voice only (WARP-1345, interim until WARP-1358)", () => {
    // droplet-shell.css hardcodes `color:#fff` on `.btn.primary`, but the
    // dark `--brand` is the light indigo #818cf8 → 2.98:1 (WCAG 1.4.3
    // fail). Interim, scoped fix: dark ink (#1d1d1f via --color-on-accent,
    // ≈5.6:1 on #818cf8) under the two voice containers. The
    // exact-selector match doubles as the no-leak guard — every selector
    // in the rule is `.dark .voice-*`-scoped, so nothing outside the
    // voice surface / wizard can pick it up. Root fix (shell-wide
    // --on-brand token) is WARP-1358; this pin dies with it.
    const rule = voiceCss.match(
      /\.dark \.voice-surface \.btn\.primary,\s*\.dark \.voice-wizard \.btn\.primary\s*\{([^}]*)\}/,
    );
    expect(
      rule,
      "voice.css must dark-scope the voice primary ink under .voice-surface/.voice-wizard",
    ).not.toBeNull();
    expect(rule![1]).toMatch(/color:\s*var\(--color-on-accent\)/);
  });

  it("confirm + result primaries are shell primary buttons (WARP-1345)", async () => {
    mockHealthyMeasurements();
    applyMock.mockResolvedValue({ calibrated: true });
    const { rerender, onClose } = renderWizard();
    await driveWakeHits(rerender, onClose, 3);
    await screen.findByText("Confirm and apply", undefined, { timeout: 5000 });

    const apply = screen.getByRole("button", { name: "Apply calibration" });
    expect(apply).toHaveClass("btn", "primary");
    expect(apply.className).not.toMatch(/dp-btn|type-/);

    fireEvent.click(apply);
    await screen.findByText("Calibrated", undefined, { timeout: 3000 });
    const done = screen.getByRole("button", { name: "Done" });
    expect(done).toHaveClass("btn", "primary");
    expect(done.className).not.toMatch(/dp-btn|type-/);
    expect(document.body.innerHTML).not.toContain("dp-btn");
  });

  it("closing while the apply is in flight is ignored — the write lands (review F3)", async () => {
    mockHealthyMeasurements();
    let resolveApply: (v: unknown) => void = () => {};
    applyMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveApply = resolve;
        }) as never,
    );
    const { rerender, onClose } = renderWizard();
    await driveWakeHits(rerender, onClose, 3);
    await screen.findByText("Confirm and apply", undefined, { timeout: 5000 });

    fireEvent.click(screen.getByRole("button", { name: "Apply calibration" }));
    expect(applyMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Applying…" })).toBeDisabled();

    // Mid-POST: the X is disabled, Esc is a no-op — no cancel path may
    // fire while voice-io is persisting + applying the record.
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();

    // The write lands → result screen → Done reports applied: true.
    resolveApply({ calibrated: true });
    await screen.findByText("Calibrated", undefined, { timeout: 3000 });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith({ applied: true });
  });
});
