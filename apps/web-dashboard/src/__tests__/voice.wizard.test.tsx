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

vi.mock("@/lib/api", () => ({
  measureVoiceLevel: vi.fn(),
  runVoiceEchoCheck: vi.fn(),
  applyVoiceCalibration: vi.fn(),
}));

import { CalibrationWizard } from "@/components/voice/CalibrationWizard";
import {
  measureVoiceLevel,
  runVoiceEchoCheck,
  applyVoiceCalibration,
} from "@/lib/api";
import type { VoiceStatusInfo } from "@/lib/types";

const NOW = 1_751_000_000;

function status(overrides: Partial<VoiceStatusInfo> = {}): VoiceStatusInfo {
  return {
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
    expect(measureMock).toHaveBeenCalledWith("speech_peak", 6);
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
});
