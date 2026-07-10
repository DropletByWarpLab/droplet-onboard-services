/**
 * WARP-1055 — /voice surface rendering contract.
 *
 * Presentational `VoiceSurface` under test (SWR wiring lives in the
 * page wrapper — same split as HealthStatusView). Pins:
 *   1. all four §9 hero headlines mapped to real state, plus the
 *      no-mic (§7.2) and voice_unavailable branches;
 *   2. §9 copy VERBATIM (meter caption, first-run sub, profiles empty
 *      state, privacy caption, guest line, activity empty state);
 *   3. drift banner: max one, with the Recalibrate action;
 *   4. health strip: failing card exposes exactly one inline action;
 *      collapses to one explanatory card when no mic;
 *   5. no dead-end affordances: no "Add a voice" (WARP-1056), no
 *      "See all in Activity" (WARP-1058), no Restart button (WARP-1057);
 *   6. §7.4 cancel-safety: closing the wizard mid-flow writes nothing
 *      and toasts "Calibration canceled — previous settings kept."
 *
 * Proven RED first: VoiceSurface does not exist yet.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  within,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import React from "react";

vi.mock("@/lib/api", () => ({
  measureVoiceLevel: vi.fn(() => new Promise(() => {})),
  runVoiceEchoCheck: vi.fn(() => new Promise(() => {})),
  applyVoiceCalibration: vi.fn(),
  fetchVoiceCalibration: vi.fn(),
  fetchVoiceStatus: vi.fn(),
  // WARP-1059 — the wizard brackets its session in calibration mode.
  enterVoiceCalibrationMode: vi.fn(async () => ({ active: true })),
  exitVoiceCalibrationMode: vi.fn(async () => ({ active: false })),
}));

import { VoiceSurface } from "@/components/voice/VoiceSurface";
import { applyVoiceCalibration } from "@/lib/api";
import { ToastProvider } from "@/components/Toast";
import type { VoiceCalibrationInfo, VoiceStatusInfo } from "@/lib/types";

const NOW = 1_751_000_000;

function status(overrides: Partial<VoiceStatusInfo> = {}): VoiceStatusInfo {
  return {
    state: "listening",
    listening: true,
    wake_loaded: true,
    threshold: 0.7,
    input_rms_dbfs: -52,
    last_audio_at: NOW - 5,
    input_flatlined: false,
    last_wake_at: NOW - 3600,
    last_response_at: NOW - 3595,
    ...overrides,
  };
}

function calibration(
  overrides: Partial<VoiceCalibrationInfo> = {},
): VoiceCalibrationInfo {
  return {
    calibrated: true,
    calibrated_at: NOW - 3 * 24 * 3600,
    input_gain: 2,
    noise_floor_dbfs: -41,
    speech_peak_dbfs: -18,
    wake_detections: 3,
    echo_ok: true,
    flags: [],
    ...overrides,
  };
}

function renderSurface(
  props: Partial<React.ComponentProps<typeof VoiceSurface>> = {},
) {
  const defaults: React.ComponentProps<typeof VoiceSurface> = {
    status: status(),
    calibration: calibration(),
    unavailable: false,
    loading: false,
    noiseSustained: false,
    nowS: NOW,
    onRefresh: vi.fn(),
    onCalibrationApplied: vi.fn(),
  };
  return render(
    <ToastProvider>
      <VoiceSurface {...defaults} {...props} />
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("VoiceSurface hero states (WARP-1055)", () => {
  it("calibrated: green hero with Recalibrate, meter caption + Read chip", () => {
    const { container } = renderSurface();
    expect(screen.getByText("Microphone calibrated")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Recalibrate" }),
    ).toBeInTheDocument();
    // §9 verbatim meter caption + live meter semantics.
    expect(
      screen.getByText("Live input · processed on this box"),
    ).toBeInTheDocument();
    expect(screen.getByRole("meter")).toBeInTheDocument();
    // Safety chip: the hero only reads.
    expect(screen.getByText("Read · stays on LAN")).toBeInTheDocument();
    // Status is color+icon+word — the ring carries a token-driven state,
    // never a raw hex in markup.
    // eslint-disable-next-line testing-library/no-node-access
    expect(container.querySelector('.vring[data-status="ok"]')).not.toBeNull();
    expect(container.innerHTML).not.toMatch(/#(34c759|ff9500|ff3b30)/i);
  });

  it("first run: neutral hero, §7.1 copy verbatim, em-dash health cards", () => {
    renderSurface({
      calibration: { calibrated: false },
      status: status({ last_wake_at: null, last_response_at: null }),
    });
    expect(screen.getByText("Not calibrated yet")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Two minutes of guided setup and Droplet will hear you reliably from across the room.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Set up microphone" }),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText("Runs after the first calibration.").length,
    ).toBe(4);
    // Profiles + activity empty states, §9 verbatim.
    expect(
      screen.getByText(
        "No voices enrolled. Droplet answers everyone as a guest until it knows who's who.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("No voice activity yet. Say 'Hey Droplet' to try it."),
    ).toBeInTheDocument();
  });

  it("drift: orange hero, Fix it CTA, exactly ONE banner with Recalibrate", () => {
    const { container } = renderSurface({ noiseSustained: true });
    expect(
      screen.getByText("Microphone needs attention"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Fix it" })).toBeInTheDocument();
    // eslint-disable-next-line testing-library/no-node-access
    expect(container.querySelectorAll(".vbanner")).toHaveLength(1);
    const banner = screen.getByText(
      /Background noise near the mic has increased/,
    );
    expect(banner).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Recalibrate" }),
    ).toBeInTheDocument();
  });

  it("no mic (§7.2): red hero, Check again, collapsed strip, wizard disabled", () => {
    renderSurface({
      status: status({ state: "no_mic", listening: false, last_wake_at: null }),
    });
    expect(screen.getByText("Microphone not working")).toBeInTheDocument();
    expect(
      screen.getByText("No microphone is detected on this Droplet."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Check again" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Get help/)).toBeInTheDocument();
    // Wizard entry points disabled — no launcher CTA at all.
    expect(screen.queryByRole("button", { name: "Set up microphone" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Fix it" })).toBeNull();
    // Health strip collapses to one explanatory card.
    expect(
      screen.getByText(/Health checks are paused/),
    ).toBeInTheDocument();
    expect(screen.queryByText("Input level")).toBeNull();
  });

  it("voice service unreachable (503 voice_unavailable): red hero", () => {
    renderSurface({ status: null, calibration: null, unavailable: true });
    expect(screen.getByText("Microphone not working")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Check again" }),
    ).toBeInTheDocument();
  });

  it("wedged DSP (input_flatlined): red hero + processor card with Test again", () => {
    renderSurface({ status: status({ input_flatlined: true }) });
    expect(screen.getByText("Microphone not working")).toBeInTheDocument();
    expect(
      screen.getByText("The mic processor is not responding."),
    ).toBeInTheDocument();
    const dspCard = screen.getByText("Mic processor").closest(".vcheck");
    expect(dspCard).not.toBeNull();
    expect(within(dspCard as HTMLElement).getByText("Not responding.")).toBeInTheDocument();
    expect(
      within(dspCard as HTMLElement).getByRole("button", { name: "Test again" }),
    ).toBeInTheDocument();
    // WARP-1057 is NOT this PR — no dead Restart button anywhere.
    expect(screen.queryByText(/Restart processor/)).toBeNull();
  });

  it("loading (§7.8): flat meter with the connecting caption", () => {
    renderSurface({ status: null, calibration: null, loading: true });
    expect(
      screen.getByText("Connecting to the microphone…"),
    ).toBeInTheDocument();
  });
});

describe("VoiceSurface sections (WARP-1055)", () => {
  it("profiles: header, guest line + privacy caption verbatim, NO Add a voice", () => {
    renderSurface();
    expect(screen.getByText("Who Droplet recognizes")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Unrecognized voices are treated as guests — read-only answers, no personal data.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Voiceprints are stored and matched on this box. They never leave your network and are deleted instantly when removed.",
      ),
    ).toBeInTheDocument();
    // Flow B is WARP-1056 — no dead-end affordance.
    expect(screen.queryByText("Add a voice")).toBeNull();
  });

  it("recent activity: renders the live last-wake row, no Activity deep link", () => {
    renderSurface();
    expect(screen.getByText("Recent voice activity")).toBeInTheDocument();
    expect(screen.getByText("Guest")).toBeInTheDocument();
    expect(screen.getByText("Answered")).toBeInTheDocument();
    // WARP-1058 is NOT this PR.
    expect(screen.queryByText(/See all in Activity/)).toBeNull();
  });

  it("health cards carry mono value + timestamp on the noise card", () => {
    renderSurface();
    const noiseCard = screen.getByText("Background noise").closest(".vcheck");
    expect(noiseCard).not.toBeNull();
    expect(
      within(noiseCard as HTMLElement).getByText("-41 dB"),
    ).toBeInTheDocument();
    expect(
      within(noiseCard as HTMLElement).getByText(/Checked 3 days ago/),
    ).toBeInTheDocument();
  });
});

describe("VoiceSurface wizard entry + cancel safety (§7.4)", () => {
  it("Recalibrate opens Flow A; Escape closes it, writes nothing, toasts", async () => {
    renderSurface();
    fireEvent.click(screen.getByRole("button", { name: "Recalibrate" }));
    expect(
      await screen.findByText("First, let's listen to the room."),
    ).toBeInTheDocument();
    // Write-tier chip in the wizard header.
    expect(screen.getByText("Write · confirm to apply")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(
      await screen.findByText("Calibration canceled — previous settings kept."),
    ).toBeInTheDocument();
    expect(applyVoiceCalibration).not.toHaveBeenCalled();
    // The dialog may still be mid-exit-animation — wait for removal.
    await waitFor(() =>
      expect(screen.queryByText("First, let's listen to the room.")).toBeNull(),
    );
  });
});
