/**
 * WARP-1974 — repairing cameras adopted before the retention fix.
 *
 * The whole difficulty is telling "never configured" from "deliberately
 * zero". Both read as 0 in Frigate's RESOLVED tree; only the AUTHORED yaml
 * records which happened. Switching 24/7 recording back on for someone who
 * turned it off is the same class of mistake WARP-1851 made from the other
 * direction, so these cases carry the ticket.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchRawConfigYaml = vi.hoisted(() => vi.fn());
const saveRawConfig = vi.hoisted(() => vi.fn());
vi.mock("./frigate.client.js", () => ({ fetchRawConfigYaml, saveRawConfig }));

import { parse } from "yaml";
import {
  backfillCameraRetention,
  planRetentionBackfill,
} from "./camera-retention-backfill.service.js";

/**
 * Three cameras, three histories:
 *  - `legacy`   adopted before WARP-1957: `record: {enabled: true}` only.
 *  - `chosen`   an operator explicitly switched 24/7 off.
 *  - `modern`   adopted after the fix, full windows.
 */
const YAML = `
cameras:
  legacy:
    ffmpeg:
      inputs:
        - path: rtsp://x/1
          roles: [detect, record]
    record:
      enabled: true
  chosen:
    ffmpeg:
      inputs:
        - path: rtsp://x/2
          roles: [detect, record]
    record:
      enabled: true
      continuous:
        days: 0
      motion:
        days: 14
  modern:
    ffmpeg:
      inputs:
        - path: rtsp://x/3
          roles: [detect, record]
    record:
      enabled: true
      continuous:
        days: 3
      motion:
        days: 30
`;

function prismaWith(names: string[]) {
  return { camera: { findMany: vi.fn(async () => names.map((name) => ({ name }))) } } as never;
}

const DEFAULTS = {
  continuousDays: 3,
  motionDays: 30,
  alertsRetainDays: 14,
  detectionsRetainDays: 14,
  preCaptureSec: 20,
  postCaptureSec: 20,
  snapshotRetainDays: 14,
};

beforeEach(() => {
  vi.clearAllMocks();
  fetchRawConfigYaml.mockResolvedValue(YAML);
  saveRawConfig.mockResolvedValue({ ok: true, status: 200, text: async () => "" });
});

describe("planning", () => {
  it("targets only the camera that never had retention authored", async () => {
    const plan = await planRetentionBackfill(prismaWith(["legacy", "chosen", "modern"]));
    expect(plan.filter((p) => p.willWrite).map((p) => p.camera)).toEqual(["legacy"]);
  });

  it("leaves a DELIBERATE zero alone", async () => {
    const plan = await planRetentionBackfill(prismaWith(["chosen"]));
    // `continuous: {days: 0}` is an expressed intent. Overwriting it would
    // turn 24/7 recording back on for someone who switched it off.
    expect(plan[0]).toMatchObject({ camera: "chosen", willWrite: false });
    expect(plan[0].reason).toBe("already_authored");
  });

  it("says why for every camera, including ones it will not touch", async () => {
    const plan = await planRetentionBackfill(prismaWith(["legacy", "modern", "ghost"]));
    expect(Object.fromEntries(plan.map((p) => [p.camera, p.reason]))).toEqual({
      legacy: "no_retention_authored",
      modern: "already_authored",
      // In the DB, absent from Frigate's config — reported, not skipped in
      // silence.
      ghost: "not_in_config",
    });
  });

  it("does not write anything while planning", async () => {
    await planRetentionBackfill(prismaWith(["legacy"]));
    expect(saveRawConfig).not.toHaveBeenCalled();
  });
});

describe("applying", () => {
  it("writes the defaults into the legacy camera only", async () => {
    const res = await backfillCameraRetention(prismaWith(["legacy", "chosen", "modern"]), DEFAULTS);
    expect(res.written).toEqual(["legacy"]);

    const saved = parse(saveRawConfig.mock.calls[0][0] as string);
    expect(saved.cameras.legacy.record.continuous.days).toBe(3);
    expect(saved.cameras.legacy.record.motion.days).toBe(30);
    expect(saved.cameras.legacy.record.alerts.pre_capture).toBe(20);
  });

  it("does not disturb the other cameras' blocks", async () => {
    await backfillCameraRetention(prismaWith(["legacy", "chosen", "modern"]), DEFAULTS);
    const saved = parse(saveRawConfig.mock.calls[0][0] as string);

    expect(saved.cameras.chosen.record.continuous.days).toBe(0);
    expect(saved.cameras.chosen.record.motion.days).toBe(14);
    expect(saved.cameras.modern.record.continuous.days).toBe(3);
  });

  it("preserves the rest of each camera's config", async () => {
    await backfillCameraRetention(prismaWith(["legacy"]), DEFAULTS);
    const saved = parse(saveRawConfig.mock.calls[0][0] as string);
    // Editing the authored yaml must not drop the stream it describes.
    expect(saved.cameras.legacy.ffmpeg.inputs[0].path).toBe("rtsp://x/1");
  });

  it("is idempotent — a second run over repaired config writes nothing", async () => {
    const first = await backfillCameraRetention(prismaWith(["legacy"]), DEFAULTS);
    expect(first.noop).toBe(false);

    // Feed back what the first run produced.
    fetchRawConfigYaml.mockResolvedValue(saveRawConfig.mock.calls[0][0] as string);
    saveRawConfig.mockClear();

    const second = await backfillCameraRetention(prismaWith(["legacy"]), DEFAULTS);
    expect(second.noop).toBe(true);
    expect(second.written).toEqual([]);
    expect(saveRawConfig).not.toHaveBeenCalled();
  });

  it("reports nothing-to-do EXPLICITLY rather than as an empty success", async () => {
    const res = await backfillCameraRetention(prismaWith(["modern"]), DEFAULTS);
    // "nothing needed doing" and "it failed quietly" must not look the
    // same — the WARP-1849 anti-pattern.
    expect(res.noop).toBe(true);
    expect(res.planned).toHaveLength(1);
  });

  it("throws loudly when Frigate rejects the write", async () => {
    saveRawConfig.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => "extra fields not permitted",
    });
    // A repair that fails silently leaves the operator believing their
    // cameras are fixed.
    await expect(backfillCameraRetention(prismaWith(["legacy"]), DEFAULTS)).rejects.toThrow(
      /rejected the retention backfill \(400\)/,
    );
  });
});
