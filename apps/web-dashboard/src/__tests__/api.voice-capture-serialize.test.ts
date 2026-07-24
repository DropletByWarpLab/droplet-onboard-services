/**
 * WARP-1520 — client-side serialization of the mic-capture family.
 *
 * The box's mic capture is EXCLUSIVE hardware: voice-io guards every
 * capture window (/audio/measure, /audio/echo-check, /speaker/enroll/
 * capture + verify) with one non-blocking lock and answers an instant
 * 409 to any overlap. The dashboard used to fire captures with no
 * client-side ordering, so a discarded-but-still-recording window
 * (Back / Try again / reopen mid-measure) made every follow-up capture
 * collide → 409 in ~4 ms → rendered as "the microphone didn't respond"
 * on a healthy mic. Pins:
 *   1. two measures issued back-to-back: the second's HTTP request does
 *      NOT start until the first settles;
 *   2. a rejected capture still releases the gate (the chain survives
 *      rejection, and the rejection reaches ITS caller with `status`);
 *   3. echo-check serializes against measure (one shared gate);
 *   4. the enrollment captures (capture line + verify) ride the same
 *      gate — they land on voice-io's `_capture_speaker_pcm`, which
 *      takes the same `_capture_lock`.
 *
 * Proven RED first: on current main both requests fire immediately.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// auth.tsx is a module cycle with api.ts; stub authFetch so api.ts's import
// resolves without pulling the whole auth provider tree.
const authFetchMock = vi.fn();
vi.mock("@/lib/auth", () => ({
  authFetch: (...a: unknown[]) => authFetchMock(...a),
}));

import {
  captureVoiceEnrollmentLine,
  measureVoiceLevel,
  runVoiceEchoCheck,
  verifyVoiceEnrollment,
} from "@/lib/api";

function okJson(body: unknown) {
  return { ok: true, json: async () => body } as Response;
}
function errJson(status: number, body: unknown) {
  return { ok: false, status, json: async () => body } as unknown as Response;
}

/** A promise whose settlement the test controls. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Drain the microtask queue (lets the gate's `await prev` chains run). */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

const MEASURE_OK = {
  rms_dbfs: -55,
  peak_dbfs: -40,
  duration_s: 5,
  kind: "noise_floor",
};
const ECHO_OK = { heard: true, tone_dbfs: -22, floor_dbfs: -57 };

beforeEach(() => {
  authFetchMock.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("exclusive-capture gate (WARP-1520)", () => {
  it("a second measure does not start its request until the first settles", async () => {
    const first = deferred<Response>();
    authFetchMock
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(okJson(MEASURE_OK));

    const p1 = measureVoiceLevel("noise_floor", 5);
    const p2 = measureVoiceLevel("speech_peak", 6);
    await flush();

    // The first capture window is still open server-side — the second
    // request must be queued, not fired into a guaranteed 409.
    expect(authFetchMock).toHaveBeenCalledTimes(1);
    expect(String(authFetchMock.mock.calls[0]![0])).toContain(
      "/api/voice/measure",
    );

    first.resolve(okJson(MEASURE_OK));
    await expect(p1).resolves.toMatchObject({ rms_dbfs: -55 });
    await flush();

    expect(authFetchMock).toHaveBeenCalledTimes(2);
    await expect(p2).resolves.toMatchObject({ rms_dbfs: -55 });
  });

  it("a rejected capture releases the gate for the next one", async () => {
    authFetchMock
      .mockResolvedValueOnce(
        errJson(409, {
          detail:
            "Another microphone measurement is already running — try again in a few seconds.",
        }),
      )
      .mockResolvedValueOnce(okJson(MEASURE_OK));

    // The rejection reaches ITS caller, carrying the status the wizard
    // classifies on — and must not poison the chain for the next call.
    await expect(measureVoiceLevel("noise_floor", 5)).rejects.toMatchObject({
      status: 409,
    });
    await expect(
      measureVoiceLevel("speech_peak", 6),
    ).resolves.toMatchObject({ rms_dbfs: -55 });
    expect(authFetchMock).toHaveBeenCalledTimes(2);
  });

  it("echo-check and measure serialize against each other (shared gate)", async () => {
    const measure = deferred<Response>();
    authFetchMock
      .mockReturnValueOnce(measure.promise)
      .mockResolvedValueOnce(okJson(ECHO_OK));

    const p1 = measureVoiceLevel("noise_floor", 5);
    const p2 = runVoiceEchoCheck();
    await flush();

    expect(authFetchMock).toHaveBeenCalledTimes(1);

    measure.resolve(okJson(MEASURE_OK));
    await p1;
    await flush();

    expect(authFetchMock).toHaveBeenCalledTimes(2);
    expect(String(authFetchMock.mock.calls[1]![0])).toContain(
      "/api/voice/echo-check",
    );
    await expect(p2).resolves.toMatchObject({ heard: true });
  });

  it("enrollment capture + verify ride the same gate", async () => {
    const capture = deferred<Response>();
    authFetchMock
      .mockReturnValueOnce(capture.promise)
      .mockResolvedValueOnce(okJson({ captured: 1, total: 3 }));

    const p1 = captureVoiceEnrollmentLine("sess-1");
    const p2 = verifyVoiceEnrollment("sess-1");
    await flush();

    expect(authFetchMock).toHaveBeenCalledTimes(1);
    expect(String(authFetchMock.mock.calls[0]![0])).toContain(
      "/api/voice/enroll/capture",
    );

    capture.resolve(okJson({ captured: 1, total: 3 }));
    await p1;
    await flush();

    expect(authFetchMock).toHaveBeenCalledTimes(2);
    expect(String(authFetchMock.mock.calls[1]![0])).toContain(
      "/api/voice/enroll/verify",
    );
    await p2;
  });
});
