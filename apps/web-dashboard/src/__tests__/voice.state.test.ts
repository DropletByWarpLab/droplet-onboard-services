/**
 * WARP-1055 — pure state derivation behind the /voice surface.
 *
 * The hero's four §9 headlines map to REAL box state:
 *   calibrated    — stored calibration + healthy pipeline
 *   attention     — drift (wake stale / sustained noise / flagged
 *                   calibration), worst problem wins the single banner
 *   broken        — no_mic | voice_unavailable 503 | input_flatlined
 *   uncalibrated  — no stored calibration
 *
 * Proven RED first: `@/components/voice/state` does not exist yet.
 */
import { describe, it, expect } from "vitest";
import {
  deriveVoiceSurfaceState,
  deriveHealthChecks,
  isVoiceBusyError,
  isVoiceOn,
  meterFractionFromDbfs,
  nextNoiseCount,
  NOISE_SUSTAIN_POLLS,
  WAKE_STALE_AFTER_S,
} from "@/components/voice/state";
import type { VoiceCalibrationInfo, VoiceStatusInfo } from "@/lib/types";

const NOW = 1_800_000_000; // epoch seconds, injectable

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

const base = {
  enabled: true,
  unavailable: false,
  noiseSustained: false,
  nowS: NOW,
};

describe("deriveVoiceSurfaceState (WARP-1055)", () => {
  it("healthy calibrated box → calibrated", () => {
    const s = deriveVoiceSurfaceState({
      ...base,
      status: status(),
      calibration: calibration(),
    });
    expect(s.kind).toBe("calibrated");
    expect(s.banner).toBeUndefined();
  });

  it("no stored calibration → uncalibrated (first run)", () => {
    const s = deriveVoiceSurfaceState({
      ...base,
      status: status(),
      calibration: { calibrated: false },
    });
    expect(s.kind).toBe("uncalibrated");
  });

  it("state no_mic → broken, regardless of stored calibration", () => {
    const s = deriveVoiceSurfaceState({
      ...base,
      status: status({ state: "no_mic", listening: false }),
      calibration: calibration(),
    });
    expect(s.kind).toBe("broken");
    expect(s.brokenCause).toBe("no_mic");
  });

  it("orchestrator 503 voice_unavailable → broken", () => {
    const s = deriveVoiceSurfaceState({
      ...base,
      unavailable: true,
      status: null,
      calibration: null,
    });
    expect(s.kind).toBe("broken");
    expect(s.brokenCause).toBe("unavailable");
  });

  it("input_flatlined (wedged DSP, WARP-1037) → broken", () => {
    const s = deriveVoiceSurfaceState({
      ...base,
      status: status({ input_flatlined: true }),
      calibration: calibration(),
    });
    expect(s.kind).toBe("broken");
    expect(s.brokenCause).toBe("flatlined");
  });

  it("flagged calibration → attention with the flag as the banner", () => {
    const flag =
      "Echo check skipped — Droplet may hear you less well while it's playing audio.";
    const s = deriveVoiceSurfaceState({
      ...base,
      status: status(),
      calibration: calibration({ flags: [flag] }),
    });
    expect(s.kind).toBe("attention");
    expect(s.driftCause).toBe("flags");
    expect(s.banner).toBe(flag);
  });

  it("sustained noise above the calibrated floor → attention/noise", () => {
    const s = deriveVoiceSurfaceState({
      ...base,
      noiseSustained: true,
      status: status(),
      calibration: calibration(),
    });
    expect(s.kind).toBe("attention");
    expect(s.driftCause).toBe("noise");
    expect(s.banner).toMatch(/background noise near the mic has increased/i);
    expect(s.banner).toMatch(/recalibrating takes about two minutes/i);
  });

  it("wake engine not loaded → attention/wake", () => {
    const s = deriveVoiceSurfaceState({
      ...base,
      status: status({ wake_loaded: false }),
      calibration: calibration(),
    });
    expect(s.kind).toBe("attention");
    expect(s.driftCause).toBe("wake");
  });

  it("no wake since a weeks-old calibration → attention/wake (stale)", () => {
    const calibratedAt = NOW - WAKE_STALE_AFTER_S - 3600;
    const s = deriveVoiceSurfaceState({
      ...base,
      status: status({ last_wake_at: null }),
      calibration: calibration({ calibrated_at: calibratedAt }),
    });
    expect(s.kind).toBe("attention");
    expect(s.driftCause).toBe("wake");
  });

  it("a wake AFTER calibration keeps a weeks-old calibration green", () => {
    const calibratedAt = NOW - WAKE_STALE_AFTER_S - 3600;
    const s = deriveVoiceSurfaceState({
      ...base,
      status: status({ last_wake_at: NOW - 60 }),
      calibration: calibration({ calibrated_at: calibratedAt }),
    });
    expect(s.kind).toBe("calibrated");
  });

  it("worst problem wins the single banner: wake beats noise beats flags", () => {
    const s = deriveVoiceSurfaceState({
      ...base,
      noiseSustained: true,
      status: status({ wake_loaded: false }),
      calibration: calibration({ flags: ["Echo check skipped"] }),
    });
    expect(s.driftCause).toBe("wake");
    // Exactly one banner sentence.
    expect(typeof s.banner).toBe("string");
  });
});

describe("voice kill switch (WARP-1599)", () => {
  it("switched off → off, ahead of the whole health-state mapping", () => {
    const s = deriveVoiceSurfaceState({
      ...base,
      enabled: false,
      status: status({ state: "off", listening: false }),
      calibration: calibration(),
    });
    expect(s.kind).toBe("off");
    expect(s.banner).toBeUndefined();
  });

  it("off outranks a mic fault — the pipeline is absent on purpose", () => {
    const noMic = deriveVoiceSurfaceState({
      ...base,
      enabled: false,
      status: status({ state: "no_mic", listening: false }),
      calibration: calibration(),
    });
    expect(noMic.kind).toBe("off");
    const flatlined = deriveVoiceSurfaceState({
      ...base,
      enabled: false,
      status: status({ input_flatlined: true }),
      calibration: calibration(),
    });
    expect(flatlined.kind).toBe("off");
  });

  it("voice_unavailable still outranks off — an unreachable box knows nothing", () => {
    const s = deriveVoiceSurfaceState({
      ...base,
      enabled: false,
      unavailable: true,
      status: null,
      calibration: null,
    });
    expect(s.kind).toBe("broken");
    expect(s.brokenCause).toBe("unavailable");
  });

  it("drift never reaches the switched-off box", () => {
    const s = deriveVoiceSurfaceState({
      ...base,
      enabled: false,
      noiseSustained: true,
      status: status({ wake_loaded: false }),
      calibration: calibration({ flags: ["Echo check skipped"] }),
    });
    expect(s.kind).toBe("off");
  });

  it("isVoiceOn: `enabled` is authoritative and its absence reads as ON", () => {
    // The switch, not `state`: /voice/status only reports state "off"
    // when the pipeline is absent, so an out-of-band edit of the on-box
    // flag can leave a "listening" state on a switched-off box.
    expect(isVoiceOn(status({ enabled: false, state: "listening" }))).toBe(false);
    expect(isVoiceOn(status({ enabled: true }))).toBe(true);

    // An older box (no field at all) and a loading flash (no payload)
    // must NEVER render as deliberately silenced.
    const older: Partial<VoiceStatusInfo> = { ...status() };
    delete older.enabled;
    expect(isVoiceOn(older as VoiceStatusInfo)).toBe(true);
    expect(isVoiceOn(null)).toBe(true);
  });
});

describe("deriveHealthChecks (WARP-1055)", () => {
  it("collapses when no microphone is detected", () => {
    const checks = deriveHealthChecks({
      surface: { kind: "broken", brokenCause: "no_mic" },
      status: status({ state: "no_mic" }),
      calibration: calibration(),
      nowS: NOW,
    });
    expect(checks).toBe("collapsed");
  });

  it("first run: all four cards show em-dash placeholders", () => {
    const checks = deriveHealthChecks({
      surface: { kind: "uncalibrated" },
      status: status(),
      calibration: { calibrated: false },
      nowS: NOW,
    });
    expect(Array.isArray(checks)).toBe(true);
    if (!Array.isArray(checks)) return;
    expect(checks).toHaveLength(4);
    for (const check of checks) {
      expect(check.status).toBe("dash");
      expect(check.stamp).toBe("—");
    }
  });

  it("healthy calibrated box: four ok cards with mono value + timestamps", () => {
    const checks = deriveHealthChecks({
      surface: { kind: "calibrated" },
      status: status(),
      calibration: calibration(),
      nowS: NOW,
    });
    if (!Array.isArray(checks)) throw new Error("expected cards");
    const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
    expect(byId.level.status).toBe("ok");
    expect(byId.level.result).toBe("Speech lands in the right range.");
    expect(byId.noise.status).toBe("ok");
    expect(byId.noise.value).toBe("-41 dB");
    expect(byId.noise.result).toBe("Quiet enough for reliable listening.");
    expect(byId.wake.status).toBe("ok");
    expect(byId.dsp.status).toBe("ok");
    expect(byId.dsp.result).toBe(
      "Echo cancellation and beamforming active.",
    );
    // No inline action on a passing card.
    for (const c of checks) expect(c.action).toBeUndefined();
  });

  it("noise drift: exactly one inline action on the failing card", () => {
    const checks = deriveHealthChecks({
      surface: { kind: "attention", driftCause: "noise" },
      status: status(),
      calibration: calibration(),
      nowS: NOW,
    });
    if (!Array.isArray(checks)) throw new Error("expected cards");
    const noise = checks.find((c) => c.id === "noise")!;
    expect(noise.status).toBe("warn");
    expect(noise.result).toBe(
      "A constant noise source is competing with speech.",
    );
    expect(noise.actionLabel).toBe("Find the noise");
    const withActions = checks.filter((c) => c.action);
    expect(withActions).toHaveLength(1);
  });

  it("flatlined DSP: processor card red with Restart processor (WARP-1057), others wait", () => {
    const checks = deriveHealthChecks({
      surface: { kind: "broken", brokenCause: "flatlined" },
      status: status({ input_flatlined: true }),
      calibration: calibration(),
      nowS: NOW,
    });
    if (!Array.isArray(checks)) throw new Error("expected cards");
    const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
    expect(byId.dsp.status).toBe("err");
    expect(byId.dsp.action).toBe("restart-dsp");
    expect(byId.dsp.actionLabel).toBe("Restart processor");
    expect(byId.level.status).toBe("dash");
    expect(byId.level.result).toBe("Waiting on the mic processor.");
  });
});

describe("nextNoiseCount — raw/pre-gain domain contract (review F1/F9)", () => {
  it("an applied input_gain of 8 does NOT shift the drift compare", () => {
    // The pipeline publishes input_rms_dbfs PRE-gain (same domain as
    // the stored /audio/measure floor), so an unchanged room reads at
    // its calibrated floor regardless of the applied gain — no
    // permanent false "needs attention" loop after a big auto-gain.
    const cal = calibration({ input_gain: 8, noise_floor_dbfs: -50 });
    const s = status({ input_rms_dbfs: -48 });
    expect(nextNoiseCount(0, s, cal)).toBe(0);
    // Even a counter that was mid-climb resets on a quiet tick.
    expect(nextNoiseCount(NOISE_SUSTAIN_POLLS - 1, s, cal)).toBe(0);
  });

  it("a genuinely raised room level still climbs toward the latch", () => {
    const cal = calibration({ input_gain: 8, noise_floor_dbfs: -50 });
    const s = status({ input_rms_dbfs: -30 });
    expect(nextNoiseCount(0, s, cal)).toBe(1);
    expect(nextNoiseCount(NOISE_SUSTAIN_POLLS - 1, s, cal)).toBe(
      NOISE_SUSTAIN_POLLS,
    );
  });

  it("resets without a calibration, on flatline, or without a live rms", () => {
    expect(
      nextNoiseCount(10, status({ input_rms_dbfs: -20 }), {
        calibrated: false,
      }),
    ).toBe(0);
    expect(
      nextNoiseCount(
        10,
        status({ input_rms_dbfs: -20, input_flatlined: true }),
        calibration(),
      ),
    ).toBe(0);
    expect(
      nextNoiseCount(10, status({ input_rms_dbfs: null }), calibration()),
    ).toBe(0);
  });
});

describe("meterFractionFromDbfs", () => {
  it("maps silence to 0 and loud speech to 1, clamped", () => {
    expect(meterFractionFromDbfs(null)).toBe(0);
    expect(meterFractionFromDbfs(-120)).toBe(0);
    expect(meterFractionFromDbfs(-60)).toBe(0);
    expect(meterFractionFromDbfs(-15)).toBe(1);
    expect(meterFractionFromDbfs(0)).toBe(1);
    const mid = meterFractionFromDbfs(-38);
    expect(mid).toBeGreaterThan(0.2);
    expect(mid).toBeLessThan(0.8);
  });
});

describe("isVoiceBusyError (WARP-1520)", () => {
  // The classifier must be EXACTLY status === 409 on an Error. voice-io's
  // operational faults (dead mic, service down) come through
  // `throwVoiceError` stamped `status: 503` — misreading one as "busy —
  // try again in a few seconds" would be the exact inverse of the
  // honest-copy promise. These pins kill the tempting mutants
  // (`status !== undefined`, `status >= 400`, `status >= 409`, dropping
  // the `instanceof Error` guard).
  function statusError(status?: number): Error & { status?: number } {
    const e = new Error("voice fault") as Error & { status?: number };
    if (status !== undefined) e.status = status;
    return e;
  }

  it("409 → busy", () => {
    expect(isVoiceBusyError(statusError(409))).toBe(true);
  });

  it("503 (dead mic / service down) → NOT busy", () => {
    expect(isVoiceBusyError(statusError(503))).toBe(false);
  });

  it("400 → NOT busy", () => {
    expect(isVoiceBusyError(statusError(400))).toBe(false);
  });

  it("a status-less Error (plain network failure) → NOT busy", () => {
    expect(isVoiceBusyError(statusError())).toBe(false);
  });

  it("non-Error rejection values → NOT busy, even carrying status 409", () => {
    expect(isVoiceBusyError({ status: 409 })).toBe(false);
    expect(isVoiceBusyError("boom")).toBe(false);
    expect(isVoiceBusyError(undefined)).toBe(false);
  });
});
