/**
 * WARP-3504 (ADR-068) — boot wiring: which mode the sender starts in, what it
 * registers on cron-runtime, and that the three feeds (the pino tap, the update
 * agent's check and status observers) reach the portal.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const cfg = vi.hoisted(() => ({
  DROPLET_TELEMETRY_DISABLED: false,
  DROPLET_TELEMETRY_PORTAL_URL: "https://portal.test/api/v1",
  DROPLET_OTA_UPDATES_DIR: "",
}));
vi.mock("../../config.js", () => ({ config: cfg }));

const hooks = vi.hoisted(() => ({
  onUpdateCheck: vi.fn(() => () => undefined),
  onDeviceUpdateTransition: vi.fn(() => () => undefined),
}));
vi.mock("../update-agent/poller.js", () => ({ onUpdateCheck: hooks.onUpdateCheck }));
vi.mock("../update-agent/transitions.js", () => ({ onDeviceUpdateTransition: hooks.onDeviceUpdateTransition }));
vi.mock("../update-agent/host-exec.js", () => ({ dockerSocketRequest: vi.fn() }));
vi.mock("../activity.singleton.js", () => ({ recordActivity: vi.fn() }));
vi.mock("../../lib/gpu-telemetry.js", () => ({ fetchGpuTelemetry: vi.fn() }));
// No Docker socket on a test machine, whatever the machine is.
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: () => false,
}));

type Index = typeof import("./index.js");

let dir: string;
let mod: Index;
let fetchMock: ReturnType<typeof vi.fn>;
const cron = { scheduleInterval: vi.fn(), scheduleCron: vi.fn() };
const hqTokens = {
  host: "hq.test",
  getToken: vi.fn(async () => ({ token: "TOKEN-SECRET-1", expiresAt: Date.now() + 600_000 })),
};

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  dir = mkdtempSync(path.join(tmpdir(), "box-telemetry-index-"));
  cfg.DROPLET_TELEMETRY_DISABLED = false;
  cfg.DROPLET_TELEMETRY_PORTAL_URL = "https://portal.test/api/v1";
  cfg.DROPLET_OTA_UPDATES_DIR = dir;
  fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  mod = await import("./index.js");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

describe("portalOrigin", () => {
  it.each([
    ["https://analytics.example", "https://analytics.example"],
    ["https://analytics.example/", "https://analytics.example"],
    ["https://analytics.example/api/v1", "https://analytics.example"],
    ["https://analytics.example/api/v1/", "https://analytics.example"],
    ["  https://analytics.example/api/v1  ", "https://analytics.example"],
    ["http://localhost:3000", "http://localhost:3000"],
  ])("%s -> %s", (raw, origin) => {
    expect(mod.portalOrigin(raw)).toBe(origin);
  });
});

describe("startBoxTelemetry", () => {
  it("DROPLET_TELEMETRY_DISABLED (lab/dev): nothing is scheduled or attached, and the state says disabled", async () => {
    cfg.DROPLET_TELEMETRY_DISABLED = true;
    const tel = await mod.startBoxTelemetry({ prisma: {} as never, cron, hqTokens: hqTokens as never });
    expect(tel.snapshot().state).toBe("disabled");
    expect(mod.getBoxTelemetry()).toBe(tel);
    expect(cron.scheduleInterval).not.toHaveBeenCalled();
    expect(cron.scheduleCron).not.toHaveBeenCalled();
    expect(hooks.onUpdateCheck).not.toHaveBeenCalled();
    expect(hooks.onDeviceUpdateTransition).not.toHaveBeenCalled();
  });

  it("no HQ configured (dev, CI): nothing is scheduled, and the state says unconfigured", async () => {
    const tel = await mod.startBoxTelemetry({ prisma: {} as never, cron, hqTokens: null });
    expect(tel.snapshot().state).toBe("unconfigured");
    expect(cron.scheduleInterval).not.toHaveBeenCalled();
    expect(cron.scheduleCron).not.toHaveBeenCalled();
  });

  it("registers a heartbeat every 5 minutes (immediately too), a watch every minute and the daily summary, on cron-runtime", async () => {
    await mod.startBoxTelemetry({ prisma: {} as never, cron, hqTokens: hqTokens as never });
    expect(cron.scheduleInterval).toHaveBeenCalledTimes(2);
    const [heartbeat, watch] = cron.scheduleInterval.mock.calls;
    expect(heartbeat![0]).toBe(300_000);
    expect(heartbeat![2]).toEqual({ immediate: true });
    expect(watch![0]).toBe(60_000);
    expect(watch![2]).toBeUndefined();
    expect(cron.scheduleCron).toHaveBeenCalledTimes(1);
    expect(cron.scheduleCron).toHaveBeenCalledWith("55 23 * * *", expect.any(Function));
    expect(hooks.onUpdateCheck).toHaveBeenCalledTimes(1);
    expect(hooks.onDeviceUpdateTransition).toHaveBeenCalledTimes(1);
  });

  it("feeds the portal from the tap and from both update observers, with the HQ token, on the normalised URL", async () => {
    const tapModule = await import("../../lib/log-tap.js");
    await mod.startBoxTelemetry({ prisma: {} as never, cron, hqTokens: hqTokens as never });

    const onCheck = (hooks.onUpdateCheck.mock.calls as unknown as Array<[(r: unknown) => void]>)[0]![0];
    const onTransition = (hooks.onDeviceUpdateTransition.mock.calls as unknown as Array<[(t: unknown) => void]>)[0]![0];
    onCheck({ outcome: "pending_created", deviceUpdateId: "d1", gitSha: "a".repeat(40), supersededCount: 0 });
    onTransition({ id: "d1", from: "applying", to: "committed", failureReason: null, releaseTag: "ota-stage-12-gabc1234" });
    tapModule.logTapStream.write(
      `${JSON.stringify({ level: 50, time: 1_790_000_000_000, name: "svc", event: "svc.broke", msg: "it broke for jane@acme.example" })}\n`,
    );

    // The 60 s handler is the second registration.
    await cron.scheduleInterval.mock.calls[1]![1]();

    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls.map(([url]) => url)).toEqual([
      "https://portal.test/api/v1/telemetry/events",
      "https://portal.test/api/v1/telemetry/logs",
    ]);
    for (const [, init] of calls) {
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer TOKEN-SECRET-1");
    }
    expect(hqTokens.getToken).toHaveBeenCalledWith(["telemetry:ingest"], undefined);
    const events = JSON.parse(calls[0]![1].body as string).events as Array<{ type: string; code?: string }>;
    expect(events.map((e) => e.type)).toEqual(["boot", "ota.download", "ota.apply"]);
    const logs = JSON.parse(calls[1]![1].body as string).records;
    expect(logs).toEqual([
      expect.objectContaining({ service: "orchestrator", level: "error", code: "svc.broke", msg: "it broke for [email]", count: 1 }),
    ]);
  });
});
