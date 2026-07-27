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
 *   5. "Add a voice" renders but stays DISABLED until the profiles
 *      wiring says the box can enroll (WARP-1056 §7.2);
 *   6. §7.4 cancel-safety: closing the wizard mid-flow writes nothing
 *      and toasts "Calibration canceled — previous settings kept."
 *   7. WARP-1057 — the wedged-processor card's "Restart processor"
 *      action: confirm dialog (~10 s outage warning) → restart call →
 *      success on flatline clear; two failed restarts escalate to the
 *      §7.3 power-cycle copy + Get help.
 *   8. WARP-1058 — the §3.4 "Recent voice activity" feed: max 5 rows
 *      (time mono · person-or-Guest · what happened), §6.3 self-heal
 *      rows without a person, the kind=voice Activity deep-link, and
 *      the §9 empty state verbatim.
 *   9. WARP-1599 — the admin kill switch: the calm off hero replacing
 *      hero + health strip + calibration entry (profiles and the
 *      activity feed survive), and the toggle in both directions.
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
  restartVoiceProcessor: vi.fn(),
  // WARP-1599 — the admin kill switch.
  setVoiceEnabled: vi.fn(),
  // WARP-1059 — the wizard brackets its session in calibration mode.
  enterVoiceCalibrationMode: vi.fn(async () => ({ active: true })),
  exitVoiceCalibrationMode: vi.fn(async () => ({ active: false })),
  // Flow B mounts for the WARP-1599 "voice went off mid-enrollment"
  // case; step 1 fetches the roster and the close path discards.
  fetchUsers: vi.fn(async () => ({
    users: [
      { id: "sam", username: "sam", displayName: "Sam", userId: "u-sam" },
    ],
  })),
  startVoiceEnrollment: vi.fn(),
  captureVoiceEnrollmentLine: vi.fn(),
  verifyVoiceEnrollment: vi.fn(),
  commitVoiceEnrollment: vi.fn(),
  cancelVoiceEnrollment: vi.fn(async () => {}),
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: { id: "u-nadia", username: "nadia", displayName: "Nadia" },
  }),
}));

// Real <a> for next/link (overrides the setup.ts string-template mock)
// so the WARP-1058 deep-link's href is assertable via getByRole("link").
// Same per-file pattern as projects/page.gating.test.tsx.
vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...props
  }: {
    children: React.ReactNode;
    href: string;
  }) => React.createElement("a", { href, ...props }, children),
}));

import { VoiceSurface } from "@/components/voice/VoiceSurface";
import {
  applyVoiceCalibration,
  measureVoiceLevel,
  restartVoiceProcessor,
  setVoiceEnabled,
} from "@/lib/api";
import { ToastProvider } from "@/components/Toast";
import type {
  VoiceActivityItem,
  VoiceCalibrationInfo,
  VoiceProfileInfo,
  VoiceStatusInfo,
} from "@/lib/types";

const restartMock = vi.mocked(restartVoiceProcessor);
const measureMock = vi.mocked(measureVoiceLevel);
const setEnabledMock = vi.mocked(setVoiceEnabled);

const NOW = 1_751_000_000;

function status(overrides: Partial<VoiceStatusInfo> = {}): VoiceStatusInfo {
  return {
    enabled: true,
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

function profile(overrides: Partial<VoiceProfileInfo> = {}): VoiceProfileInfo {
  return {
    user_id: "u-nadia",
    display_name: "Nadia",
    enrolled_at: NOW - 30 * 24 * 3600,
    updated_at: NOW - 30 * 24 * 3600,
    last_recognized_at: NOW - 60,
    learning: false,
    confused_with: null,
    confused_with_name: null,
    lines: 4,
    voice_model: "campplus-voxceleb-en",
    ...overrides,
  };
}

function surfaceTree(
  props: Partial<React.ComponentProps<typeof VoiceSurface>> = {},
) {
  const defaults: React.ComponentProps<typeof VoiceSurface> = {
    status: status(),
    calibration: calibration(),
    unavailable: false,
    loading: false,
    noiseSustained: false,
    activity: [],
    nowS: NOW,
    onRefresh: vi.fn(),
    onCalibrationApplied: vi.fn(),
  };
  return (
    <ToastProvider>
      <VoiceSurface {...defaults} {...props} />
    </ToastProvider>
  );
}

function renderSurface(
  props: Partial<React.ComponentProps<typeof VoiceSurface>> = {},
) {
  return render(surfaceTree(props));
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

  it("wedged DSP (input_flatlined): red hero + processor card with Restart processor", () => {
    renderSurface({ status: status({ input_flatlined: true }) });
    expect(screen.getByText("Microphone not working")).toBeInTheDocument();
    expect(
      screen.getByText("The mic processor is not responding."),
    ).toBeInTheDocument();
    const dspCard = screen.getByText("Mic processor").closest(".vcheck");
    expect(dspCard).not.toBeNull();
    expect(within(dspCard as HTMLElement).getByText("Not responding.")).toBeInTheDocument();
    // WARP-1057 — the inline action is the DSP restart.
    expect(
      within(dspCard as HTMLElement).getByRole("button", {
        name: "Restart processor",
      }),
    ).toBeInTheDocument();
  });

  it("loading (§7.8): flat meter with the connecting caption", () => {
    renderSurface({ status: null, calibration: null, loading: true });
    expect(
      screen.getByText("Connecting to the microphone…"),
    ).toBeInTheDocument();
  });
});

describe("VoiceSurface sections (WARP-1055)", () => {
  it("profiles: header, guest line + privacy caption verbatim; Add a voice gated", () => {
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
    // WARP-1056 wired Flow B — but without the profiles wiring
    // (speakerModelAvailable defaults false) the entry point stays
    // DISABLED: §7.2, never launch a wizard that cannot succeed.
    expect(screen.getByRole("button", { name: "Add a voice" })).toBeDisabled();
  });

  it("recent activity (WARP-1058): §3.4 rows — mono time · person-or-Guest · what", () => {
    const rows: VoiceActivityItem[] = [
      { id: "12", atS: NOW - 60, what: "Answered", severity: "info", person: "Guest" },
      { id: "11", atS: NOW - 300, what: "Missed wake word", severity: "warn", person: "Guest" },
      // §6.3 self-heal transparency: no person on system rows.
      { id: "10", atS: NOW - 900, what: "Voice processor restarted", severity: "info", person: null },
    ];
    const { container } = renderSurface({ activity: rows });
    expect(screen.getByText("Recent voice activity")).toBeInTheDocument();

    // eslint-disable-next-line testing-library/no-node-access
    const items = container.querySelectorAll(".vact li");
    expect(items).toHaveLength(3);
    // Row 1: time (mono class) · Guest · Answered.
    expect(within(items[0] as HTMLElement).getByText("Answered")).toBeInTheDocument();
    expect(within(items[0] as HTMLElement).getByText("Guest")).toBeInTheDocument();
    // eslint-disable-next-line testing-library/no-node-access
    expect((items[0] as HTMLElement).querySelector(".t")).not.toBeNull();
    // §3.4 outcome vocabulary rendered verbatim.
    expect(screen.getByText("Missed wake word")).toBeInTheDocument();
    // §6.3 self-heal row: muted em-dash instead of a person.
    expect(
      within(items[2] as HTMLElement).getByText("Voice processor restarted"),
    ).toBeInTheDocument();
    expect(within(items[2] as HTMLElement).getByText("—")).toBeInTheDocument();
    // eslint-disable-next-line testing-library/no-node-access
    expect((items[2] as HTMLElement).querySelector(".who.sys")).not.toBeNull();
  });

  it("recent activity: caps at 5 rows and deep-links to kind=voice", () => {
    const rows: VoiceActivityItem[] = Array.from({ length: 6 }, (_, i) => ({
      id: String(20 - i),
      atS: NOW - i * 60,
      what: "Answered",
      severity: "info" as const,
      person: "Guest",
    }));
    const { container } = renderSurface({ activity: rows });
    // eslint-disable-next-line testing-library/no-node-access
    expect(container.querySelectorAll(".vact li")).toHaveLength(5);
    const link = screen.getByRole("link", { name: /See all in Activity/ });
    expect(link).toHaveAttribute("href", "/admin/audit?kind=voice");
  });

  it("recent activity: §9 empty state verbatim when there are no rows", () => {
    renderSurface({ activity: [] });
    expect(
      screen.getByText("No voice activity yet. Say 'Hey Droplet' to try it."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/See all in Activity/)).toBeNull();

    // null (feed unavailable / still loading) renders the same way —
    // the feed is supporting context, never an error card.
    renderSurface({ activity: null });
    expect(
      screen.getAllByText("No voice activity yet. Say 'Hey Droplet' to try it.")
        .length,
    ).toBeGreaterThan(0);
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

describe("VoiceSurface processor restart (WARP-1057, §7.3)", () => {
  function clickCardRestart() {
    const dspCard = screen.getByText("Mic processor").closest(".vcheck");
    fireEvent.click(
      within(dspCard as HTMLElement).getByRole("button", {
        name: "Restart processor",
      }),
    );
  }

  it("confirm dialog warns about the ~10 s outage; Cancel issues nothing", async () => {
    renderSurface({ status: status({ input_flatlined: true }) });
    clickCardRestart();
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("Restart the mic processor?"),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        "Droplet's hearing will pause for about 10 seconds while the processor restarts. It comes back on its own — nothing else is interrupted.",
      ),
    ).toBeInTheDocument();
    // Write-tier chip on the confirm (§10 safety framing).
    expect(
      within(dialog).getByText("Write · confirm to apply"),
    ).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(restartMock).not.toHaveBeenCalled();
  });

  it("confirming issues the restart, toasts the outage, and re-polls", async () => {
    restartMock.mockResolvedValue({
      ok: true,
      method: "xvf_host",
      restarted_at: NOW,
    });
    const onRefresh = vi.fn();
    const { rerender } = renderSurface({
      status: status({ input_flatlined: true }),
      onRefresh,
    });
    clickCardRestart();
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Restart processor" }),
    );
    await waitFor(() => expect(restartMock).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByText(
        "Restarting the mic processor — listening pauses for about 10 seconds.",
      ),
    ).toBeInTheDocument();
    expect(onRefresh).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // The live poll shows audio flowing again → success toast.
    rerender(
      <ToastProvider>
        <VoiceSurface
          status={status({ input_flatlined: false })}
          calibration={calibration()}
          unavailable={false}
          loading={false}
          noiseSustained={false}
          activity={[]}
          nowS={NOW}
          onRefresh={onRefresh}
          onCalibrationApplied={vi.fn()}
        />
      </ToastProvider>,
    );
    expect(
      await screen.findByText("Mic processor is back — audio is flowing again."),
    ).toBeInTheDocument();
  });

  it("two failed restarts escalate to the power-cycle copy + Get help", async () => {
    restartMock.mockRejectedValue(new Error("Processor restart failed: 503"));
    renderSurface({ status: status({ input_flatlined: true }) });

    for (let attempt = 1; attempt <= 2; attempt++) {
      clickCardRestart();
      // eslint-disable-next-line no-await-in-loop
      const dialog = await screen.findByRole("dialog");
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Restart processor" }),
      );
      // eslint-disable-next-line no-await-in-loop
      await waitFor(() => expect(restartMock).toHaveBeenCalledTimes(attempt));
      // eslint-disable-next-line no-await-in-loop
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    }

    // §7.3 escalation: power-cycle copy + Get help, no inline restart.
    expect(
      await screen.findByText(
        "The processor didn't come back. A power cycle of the Droplet usually clears this.",
      ),
    ).toBeInTheDocument();
    const dspCard = screen.getByText("Mic processor").closest(".vcheck");
    expect(
      within(dspCard as HTMLElement).getByText(/Get help/),
    ).toBeInTheDocument();
    expect(
      within(dspCard as HTMLElement).queryByRole("button", {
        name: "Restart processor",
      }),
    ).toBeNull();
  });
});

describe("VoiceSurface health-card captures on a busy mic (WARP-1520)", () => {
  // voice-io's capture lock answers 409 to an overlapping capture — that's
  // "busy, wait a beat", never the dead-mic "didn't respond" toast.
  const BUSY_TOAST =
    "The microphone is busy with another check — try again in a few seconds.";

  /** The 409 voice-io answers when its capture lock is held. */
  function busyError(): Error & { status?: number } {
    const e = new Error(
      "Another microphone measurement is already running — try again in a few seconds.",
    ) as Error & { status?: number };
    e.status = 409;
    return e;
  }

  it('"Find the noise" on a 409 toasts the busy copy, not the dead-mic lie', async () => {
    measureMock.mockRejectedValueOnce(busyError());
    // High calibrated floor → the noise card fails → "Find the noise".
    renderSurface({ calibration: calibration({ noise_floor_dbfs: -30 }) });

    fireEvent.click(screen.getByRole("button", { name: "Find the noise" }));

    expect(await screen.findByText(BUSY_TOAST)).toBeInTheDocument();
    expect(
      screen.queryByText("Couldn't measure — the microphone didn't respond."),
    ).toBeNull();
  });

  it('"Test again" (input level) on a 409 toasts the busy copy too', async () => {
    measureMock.mockRejectedValueOnce(busyError());
    // Faint calibrated speech peak → the input-level card fails →
    // "Test again" (the level card is the only failing card here, so the
    // one-inline-action rule gives it the action).
    renderSurface({ calibration: calibration({ speech_peak_dbfs: -40 }) });

    fireEvent.click(screen.getByRole("button", { name: "Test again" }));

    expect(await screen.findByText(BUSY_TOAST)).toBeInTheDocument();
    expect(
      screen.queryByText("Couldn't measure — the microphone didn't respond."),
    ).toBeNull();
  });

  it("a plain rejection keeps the didn't-respond toast", async () => {
    measureMock.mockRejectedValueOnce(new Error("network down"));
    renderSurface({ calibration: calibration({ noise_floor_dbfs: -30 }) });

    fireEvent.click(screen.getByRole("button", { name: "Find the noise" }));

    expect(
      await screen.findByText(
        "Couldn't measure — the microphone didn't respond.",
      ),
    ).toBeInTheDocument();
  });
});

describe("VoiceSurface buttons use the indigo shell idiom (WARP-1345)", () => {
  // The /voice surface renders inside ShellPage's `.droplet-shell` scope, so
  // its buttons must use the shell `btn` classes — never the legacy
  // `dp-btn-*` + `type-*` utilities (the shell class supplies sizing).

  it("calibrated hero: Recalibrate is a quiet shell secondary", () => {
    const { container } = renderSurface();
    const recal = screen.getByRole("button", { name: "Recalibrate" });
    expect(recal).toHaveClass("btn", "ghost");
    expect(recal).not.toHaveClass("sm");
    expect(recal.className).not.toMatch(/dp-btn|type-/);
    expect(container.innerHTML).not.toContain("dp-btn");
  });

  it("first-run hero: Set up microphone is a shell primary", () => {
    renderSurface({
      calibration: { calibrated: false },
      status: status({ last_wake_at: null, last_response_at: null }),
    });
    const cta = screen.getByRole("button", { name: "Set up microphone" });
    expect(cta).toHaveClass("btn", "primary");
    expect(cta).not.toHaveClass("sm");
    expect(cta.className).not.toMatch(/dp-btn|type-/);
  });

  it("drift hero: Fix it is a shell primary; the banner action is compact", () => {
    renderSurface({ noiseSustained: true });
    const fixIt = screen.getByRole("button", { name: "Fix it" });
    expect(fixIt).toHaveClass("btn", "primary");
    expect(fixIt).not.toHaveClass("sm");
    // The inline banner CTA stays a step below the hero CTA — `sm` variant,
    // no hand-rolled `!min-h`/`!py` overrides.
    const bannerRecal = screen.getByRole("button", { name: "Recalibrate" });
    expect(bannerRecal).toHaveClass("btn", "primary", "sm");
    expect(bannerRecal.className).not.toMatch(/dp-btn|type-|min-h|py-/);
  });

  it("no-mic hero: Check again is a shell primary", () => {
    renderSurface({
      status: status({ state: "no_mic", listening: false, last_wake_at: null }),
    });
    const check = screen.getByRole("button", { name: "Check again" });
    expect(check).toHaveClass("btn", "primary");
    expect(check.className).not.toMatch(/dp-btn|type-/);
  });
});

describe("VoiceSurface kill switch (WARP-1599)", () => {
  const OFF_HEADLINE = "Voice is off — Droplet isn't listening.";
  const OFF_SUB =
    "The wake word does nothing and no audio is captured. Voiceprints and calibration stay on this box.";
  const ON_TOAST = "Voice is back on — listening for the wake word.";
  const OFF_ENROLL_TITLE = "Voice is off — turn it back on to record a voice.";

  it("off: ONE calm hero replaces hero + health strip + calibration entry", () => {
    const { container } = renderSurface({
      enabled: false,
      status: status({ state: "off", listening: false }),
      activity: [
        {
          id: "31",
          atS: NOW - 30,
          what: "Voice turned off",
          severity: "info",
          person: null,
        },
      ],
    });

    expect(screen.getByText(OFF_HEADLINE)).toBeInTheDocument();
    expect(screen.getByText(OFF_SUB)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Turn voice on" }),
    ).toBeInTheDocument();

    // Deliberate, not broken: the neutral ring, never the red mic-fault
    // one, and none of the §7.2 failure copy.
    // eslint-disable-next-line testing-library/no-node-access
    expect(container.querySelector('.vring[data-status="neutral"]')).not.toBeNull();
    // eslint-disable-next-line testing-library/no-node-access
    expect(container.querySelector('.vring[data-status="err"]')).toBeNull();
    expect(screen.queryByText("Microphone not working")).toBeNull();

    // Health strip gone — every card would be reporting on a pipeline
    // that isn't running.
    expect(screen.queryByText("Input level")).toBeNull();
    expect(screen.queryByText("Mic processor")).toBeNull();
    expect(screen.queryByText(/Health checks are paused/)).toBeNull();
    // Calibration entry gone: its capture endpoints still open the mic
    // directly, which would contradict the hero's own promise.
    expect(screen.queryByRole("button", { name: "Recalibrate" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Set up microphone" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Fix it" })).toBeNull();
    // …and no live meter: "no audio is captured" cannot sit beside one.
    expect(screen.queryByRole("meter")).toBeNull();

    // Profiles + activity stay — the off event itself lands in the feed.
    expect(screen.getByText("Who Droplet recognizes")).toBeInTheDocument();
    expect(screen.getByText("Recent voice activity")).toBeInTheDocument();
    expect(screen.getByText("Voice turned off")).toBeInTheDocument();
  });

  it("a silenced status renders the off hero without the enabled prop", () => {
    // `enabled` defaults to true and `status.enabled` is REQUIRED on the
    // payload beside it, so a caller that passes one without the other
    // must not get a hero saying Droplet is listening — the exact
    // failure this feature exists to prevent.
    renderSurface({
      status: status({ enabled: false, state: "off", listening: false }),
    });
    expect(screen.getByText(OFF_HEADLINE)).toBeInTheDocument();
    expect(screen.queryByText("Microphone calibrated")).toBeNull();
  });

  it('"Turn off voice" is the quiet ghost action while voice is on', () => {
    renderSurface();
    const off = screen.getByRole("button", { name: "Turn off voice" });
    expect(off).toHaveClass("btn", "ghost", "sm");
    expect(off.className).not.toMatch(/dp-btn|type-/);
  });

  it('"Turn off voice" rides the hero actions, never the Read-chip corner', () => {
    // The corner is the SafetyChip's, and the chip says "Read · stays on
    // LAN". The most consequential write on the page cannot sit inside a
    // label calling the card read-only.
    const { container } = renderSurface();
    // eslint-disable-next-line testing-library/no-node-access
    const corner = container.querySelector(".vhero-corner") as HTMLElement;
    expect(within(corner).getByText("Read · stays on LAN")).toBeInTheDocument();
    expect(
      within(corner).queryByRole("button", { name: "Turn off voice" }),
    ).toBeNull();
    // eslint-disable-next-line testing-library/no-node-access
    const cta = container.querySelector(".vhero-cta") as HTMLElement;
    expect(
      within(cta).getByRole("button", { name: "Turn off voice" }),
    ).toBeInTheDocument();
  });

  it('"Turn off voice" is absent while voice is already off', () => {
    renderSurface({ enabled: false });
    expect(screen.queryByRole("button", { name: "Turn off voice" })).toBeNull();
  });

  it("turning voice off calls the API, re-polls, and toasts the off state", async () => {
    setEnabledMock.mockResolvedValue({ enabled: false });
    const onRefresh = vi.fn();
    renderSurface({ onRefresh });

    fireEvent.click(screen.getByRole("button", { name: "Turn off voice" }));

    await waitFor(() => expect(setEnabledMock).toHaveBeenCalledWith(false));
    // While voice is on, this sentence can only be the toast.
    expect(await screen.findByText(OFF_HEADLINE)).toBeInTheDocument();
    expect(onRefresh).toHaveBeenCalled();
  });

  it("turning voice back on calls the API, re-polls, and toasts", async () => {
    setEnabledMock.mockResolvedValue({ enabled: true });
    const onRefresh = vi.fn();
    renderSurface({ enabled: false, onRefresh });

    fireEvent.click(screen.getByRole("button", { name: "Turn voice on" }));

    await waitFor(() => expect(setEnabledMock).toHaveBeenCalledWith(true));
    expect(await screen.findByText(ON_TOAST)).toBeInTheDocument();
    expect(onRefresh).toHaveBeenCalled();
  });

  it("announces the value the box APPLIED, not the one requested", async () => {
    // The response is the only honest answer — an admin must never be
    // told the box did something it didn't.
    setEnabledMock.mockResolvedValue({ enabled: true });
    renderSurface();

    fireEvent.click(screen.getByRole("button", { name: "Turn off voice" }));

    await waitFor(() => expect(setEnabledMock).toHaveBeenCalledWith(false));
    expect(await screen.findByText(ON_TOAST)).toBeInTheDocument();
  });

  it("a 503 toasts the human copy, never the machine string", async () => {
    // `throwVoiceError` puts the orchestrator's `voice_unavailable` in
    // the Error MESSAGE, so toasting err.message verbatim showed a
    // household admin the words "voice_unavailable" — and the copy
    // written for exactly this case could never fire.
    const down = new Error("voice_unavailable") as Error & {
      status?: number;
      code?: string;
    };
    down.status = 503;
    down.code = "voice_unavailable";
    setEnabledMock.mockRejectedValue(down);
    renderSurface();

    fireEvent.click(screen.getByRole("button", { name: "Turn off voice" }));

    expect(
      await screen.findByText(
        "Couldn't switch voice — the voice service didn't respond.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("voice_unavailable")).toBeNull();
  });

  it("a rejected toggle surfaces the error and never claims success", async () => {
    // The orchestrator relays voice-io's 409 when a toggle is already
    // in flight; `throwVoiceError` carries its detail on the Error.
    const busy = new Error(
      "Another voice toggle is already in progress — try again in a moment.",
    ) as Error & { status?: number };
    busy.status = 409;
    setEnabledMock.mockRejectedValue(busy);
    const onRefresh = vi.fn();
    renderSurface({ onRefresh });

    fireEvent.click(screen.getByRole("button", { name: "Turn off voice" }));

    expect(
      await screen.findByText(
        "Another voice toggle is already in progress — try again in a moment.",
      ),
    ).toBeInTheDocument();
    // No success toast, and the surface still says voice is on.
    expect(screen.queryByText(OFF_HEADLINE)).toBeNull();
    expect(screen.getByText("Microphone calibrated")).toBeInTheDocument();
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("the toggle disables itself in flight — one click, one POST", async () => {
    setEnabledMock.mockReturnValue(new Promise(() => {}));
    renderSurface();
    const off = screen.getByRole("button", { name: "Turn off voice" });

    fireEvent.click(off);

    await waitFor(() => expect(off).toBeDisabled());
    fireEvent.click(off);
    expect(setEnabledMock).toHaveBeenCalledTimes(1);
  });

  it("off: enrollment entry points are disabled and say why; Remove stays live", () => {
    renderSurface({
      enabled: false,
      status: status({ state: "off", listening: false }),
      profiles: [profile()],
      speakerModelAvailable: true,
    });

    // Flow B's captures ride the same always-open mic path as the
    // calibration endpoints, so recording a voice while off would make
    // the hero's "no audio is captured" a lie.
    const add = screen.getByRole("button", { name: "Add a voice" });
    expect(add).toBeDisabled();
    expect(add).toHaveAttribute("title", OFF_ENROLL_TITLE);

    fireEvent.click(
      screen.getByRole("button", { name: "Voice options for Nadia" }),
    );
    const reRecord = screen.getByRole("menuitem", { name: /Re-record voice/ });
    expect(reRecord).toBeDisabled();
    expect(reRecord).toHaveAttribute("title", OFF_ENROLL_TITLE);
    // Remove captures nothing, and someone switching voice off may well
    // want to purge the voiceprints next.
    expect(screen.getByRole("menuitem", { name: /Remove voice/ })).toBeEnabled();
  });

  it("an OPEN enrollment wizard closes when voice goes off mid-flow", async () => {
    // The entry points were gated, the mounted wizard wasn't: admin A
    // opens "Add a voice", admin B (second session or second tab)
    // switches voice off, and A's next capture recorded audio while B
    // read a hero promising none was. Nothing is lost by dropping the
    // session — it lives in RAM behind speaker_id.py's 15-minute TTL,
    // whose docstring names "browser tab closed mid-flow" as this case.
    const base = { profiles: [profile()], speakerModelAvailable: true };
    const { rerender } = render(surfaceTree(base));

    fireEvent.click(screen.getByRole("button", { name: "Add a voice" }));
    expect(await screen.findByText("Whose voice is this?")).toBeInTheDocument();

    rerender(
      surfaceTree({
        ...base,
        enabled: false,
        status: status({ enabled: false, state: "off", listening: false }),
      }),
    );

    await waitFor(() =>
      expect(screen.queryByText("Whose voice is this?")).toBeNull(),
    );
    expect(screen.getByText(OFF_HEADLINE)).toBeInTheDocument();
    expect(
      await screen.findByText("Voice enrollment canceled — nothing was saved."),
    ).toBeInTheDocument();
  });

  it("on: the same enrollment entry points are live again", () => {
    renderSurface({ profiles: [profile()], speakerModelAvailable: true });

    expect(screen.getByRole("button", { name: "Add a voice" })).toBeEnabled();
    fireEvent.click(
      screen.getByRole("button", { name: "Voice options for Nadia" }),
    );
    expect(
      screen.getByRole("menuitem", { name: /Re-record voice/ }),
    ).toBeEnabled();
    expect(screen.getByRole("menuitem", { name: /Remove voice/ })).toBeEnabled();
  });

  it("no toggle while voice-io is unreachable — the POST could only 503", () => {
    renderSurface({ status: null, calibration: null, unavailable: true });
    expect(screen.queryByRole("button", { name: "Turn off voice" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Turn voice on" })).toBeNull();
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
