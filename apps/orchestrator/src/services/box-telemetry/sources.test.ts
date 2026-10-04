/**
 * WARP-3504 (ADR-068) — where each heartbeat fact comes from: Docker's view of
 * the compose services, the host's kernel and distro, CPU / memory / disk / net
 * from the OS, the GPU card, the COUNT queries behind the activity numbers and
 * the installed release. Each collector degrades on its own and never turns an
 * unknown into a zero.
 */
import { describe, it, expect, vi } from "vitest";
import type * as FsPromises from "node:fs/promises";
import type { PrismaClient } from "@prisma/client";
import type { DockerRequest } from "../update-agent/host-exec.js";
import type { GpuTelemetry } from "../../lib/gpu-telemetry.js";
import {
  createCollectors,
  createCpuSampler,
  gpuFacts,
  memPct,
  parseNetDev,
  readActivityCounts,
  readContainers,
  readDiskPct,
  readHostOs,
  readRelease,
} from "./sources.js";

const NET_DEV = vi.hoisted(() =>
  [
    "Inter-|   Receive",
    " face |bytes",
    "    lo: 9 1 0 0 0 0 0 0 9 1 0 0 0 0 0 0",
    "  eth0: 5000 50 0 0 0 0 0 0 2000 20 0 0 0 0 0 0",
  ].join("\n"),
);
// /proc/net/dev exists on Linux only; every other file read stays real.
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof FsPromises>();
  return {
    ...real,
    readFile: ((path: string, ...rest: unknown[]) =>
      path === "/proc/net/dev"
        ? Promise.resolve(NET_DEV)
        : (real.readFile as (...a: unknown[]) => Promise<unknown>)(path, ...rest)) as typeof real.readFile,
  };
});

/** A Docker Engine double: path (without query) -> status + JSON body. */
function docker(routes: Record<string, { status?: number; body: unknown }>) {
  const calls: string[] = [];
  const request: DockerRequest = async (_method, apiPath) => {
    calls.push(apiPath);
    const key = apiPath.split("?")[0]!;
    const hit = routes[key];
    if (!hit) return { status: 404, body: Buffer.from("{}") };
    return { status: hit.status ?? 200, body: Buffer.from(JSON.stringify(hit.body)) };
  };
  return { request, calls };
}

const entry = (id: string, service: string, extra: Record<string, string> = {}) => ({
  Id: id,
  State: "running",
  Labels: { "com.docker.compose.service": service, ...extra },
});

describe("readContainers", () => {
  it("lists compose-labelled containers with state, health, restart count and exit code", async () => {
    const d = docker({
      "/containers/json": {
        body: [entry("c1", "orchestrator"), entry("c2", "ai-gateway"), entry("c3", "nextcloud"), entry("c4", "frigate")],
      },
      "/containers/c1/json": { body: { RestartCount: 0, State: { Status: "running", ExitCode: 0, Health: { Status: "healthy" } } } },
      "/containers/c2/json": { body: { RestartCount: 3, State: { Status: "restarting", ExitCode: 137 } } },
      "/containers/c3/json": { body: { RestartCount: 0, State: { Status: "running", Health: { Status: "starting" } } } },
      "/containers/c4/json": { body: { RestartCount: 1, State: { Status: "removing", ExitCode: 0 } } },
    });
    const facts = await readContainers(d.request);
    expect(facts).toEqual([
      { name: "orchestrator", state: "running", health: "healthy", restarts: 0, exitCode: 0 },
      { name: "ai-gateway", state: "restarting", health: "none", restarts: 3, exitCode: 137 },
      { name: "nextcloud", state: "running", health: "starting", restarts: 0, exitCode: null },
      // `removing` has no name in the contract; it is the closest state, exited.
      { name: "frigate", state: "exited", health: "none", restarts: 1, exitCode: 0 },
    ]);
    // Asked Docker for compose-labelled containers only.
    const list = d.calls.find((c) => c.startsWith("/containers/json"))!;
    expect(decodeURIComponent(list)).toContain('"label":["com.docker.compose.service"]');
  });

  it("skips one-off `compose run` containers and names the contract would refuse", async () => {
    const d = docker({
      "/containers/json": {
        body: [
          entry("c1", "orchestrator"),
          entry("c2", "migrate", { "com.docker.compose.oneoff": "True" }),
          entry("c3", "Has Spaces"),
          entry("c4", "10.0.0.5"),
        ],
      },
      "/containers/c1/json": { body: { State: { Status: "running" } } },
    });
    expect((await readContainers(d.request)).map((c) => c.name)).toEqual(["orchestrator"]);
    // Only the one real service was inspected.
    expect(d.calls.filter((c) => /^\/containers\/[^/]+\/json$/.test(c))).toEqual(["/containers/c1/json"]);
  });

  it("skips a container that vanished between the list and the inspect, and a state it has no name for", async () => {
    const d = docker({
      "/containers/json": { body: [entry("gone", "a"), entry("weird", "b"), entry("ok", "c")] },
      "/containers/weird/json": { body: { State: { Status: "teleporting" } } },
      "/containers/ok/json": { body: { State: { Status: "running" } } },
    });
    expect((await readContainers(d.request)).map((c) => c.name)).toEqual(["c"]);
  });

  it("keeps one entry per service name", async () => {
    const d = docker({
      "/containers/json": { body: [entry("x1", "web"), entry("x2", "web")] },
      "/containers/x1/json": { body: { RestartCount: 1, State: { Status: "running" } } },
      "/containers/x2/json": { body: { RestartCount: 9, State: { Status: "exited" } } },
    });
    expect(await readContainers(d.request)).toEqual([
      { name: "web", state: "running", health: "none", restarts: 1, exitCode: null },
    ]);
  });

  it("throws when Docker cannot be read, so the caller can tell it from an empty stack", async () => {
    const d = docker({ "/containers/json": { status: 500, body: {} } });
    await expect(readContainers(d.request)).rejects.toThrow(/answered 500/);
  });
});

describe("readHostOs", () => {
  it("reports Docker's view of the HOST kernel and distro, printable and bounded", async () => {
    const d = docker({ "/info": { body: { KernelVersion: "6.8.0-45-generic", OperatingSystem: "Ubuntu 24.04.1 LTS" } } });
    expect(await readHostOs(d.request)).toEqual({ kernel: "6.8.0-45-generic", distro: "Ubuntu 24.04.1 LTS" });
  });

  it("strips anything unprintable, cuts at 128, and says unknown rather than inventing", async () => {
    const d = docker({ "/info": { body: { KernelVersion: `k\u0000e\nr${"n".repeat(300)}`, OperatingSystem: 5 } } });
    const os = await readHostOs(d.request);
    expect(os.kernel).toHaveLength(128);
    expect(os.kernel.startsWith("kern")).toBe(true);
    expect(os.distro).toBe("unknown");
  });
});

describe("cpu, memory, disk and network", () => {
  const cpus = (idle: number, busy: number) =>
    [{ model: "x", speed: 1, times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } }] as never;

  it("cpu: the first reading is the average since boot, later ones the interval since the last", () => {
    let now = cpus(750, 250);
    const sample = createCpuSampler(() => now);
    expect(sample()).toBeCloseTo(25, 5);
    now = cpus(750 + 50, 250 + 150);
    expect(sample()).toBeCloseTo(75, 5);
  });

  it("memory is used over total", () => {
    expect(memPct(1000, 250)).toBe(75);
    expect(memPct(0, 0)).toBe(0);
  });

  it("disk is df's figure: used over used plus what unprivileged users can still take", async () => {
    // 1000 blocks, 400 free, 300 available: used 600 -> 600 / (600 + 300) = 66.7 %
    const statfs = vi.fn(async () => ({ blocks: 1000, bfree: 400, bavail: 300 })) as never;
    expect(await readDiskPct(["/data/updates"], statfs)).toBeCloseTo(66.667, 2);
  });

  it("disk falls back to the next path, and throws when none answers", async () => {
    const statfs = vi.fn(async (p: string) => {
      if (p === "/data/updates") throw new Error("ENOENT");
      return { blocks: 100, bfree: 50, bavail: 50 };
    }) as never;
    expect(await readDiskPct(["/data/updates", "/"], statfs)).toBe(50);
    const none = vi.fn(async () => {
      throw new Error("ENOENT");
    }) as never;
    await expect(readDiskPct(["/a", "/b"], none)).rejects.toThrow("ENOENT");
  });

  it("network: sums rx and tx over every interface but loopback", () => {
    const text = [
      "Inter-|   Receive                                                |  Transmit",
      " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed",
      "    lo: 1000 10 0 0 0 0 0 0 1000 10 0 0 0 0 0 0",
      "  eth0: 5000 50 0 0 0 0 0 0 2000 20 0 0 0 0 0 0",
      "  eth1: 300 3 0 0 0 0 0 0 100 1 0 0 0 0 0 0",
    ].join("\n");
    expect(parseNetDev(text)).toEqual({ rx: 5300, tx: 2100 });
    expect(parseNetDev("")).toEqual({ rx: 0, tx: 0 });
  });
});

describe("gpuFacts", () => {
  const gpu = (over: Partial<GpuTelemetry> = {}): GpuTelemetry => ({
    available: true,
    card: "card1",
    name: "A card",
    reason: null,
    busyPercent: 40,
    vramTotalBytes: 16 * 1024 * 1024 * 1024,
    vramUsedBytes: 4 * 1024 * 1024 * 1024,
    vramUsedFraction: 0.25,
    powerWatts: 90,
    tempC: 61,
    processes: [],
    ...over,
  });

  it("reports the card in MB", () => {
    expect(gpuFacts(gpu())).toEqual([{ utilPct: 40, vramUsedMb: 4096, vramTotalMb: 16384, tempC: 61 }]);
  });

  it("reports no card when any of the four counters is unknown: a null is not a zero", () => {
    expect(gpuFacts(null)).toEqual([]);
    expect(gpuFacts(gpu({ available: false }))).toEqual([]);
    for (const field of ["busyPercent", "vramUsedBytes", "vramTotalBytes", "tempC"] as const) {
      expect(gpuFacts(gpu({ [field]: null })), field).toEqual([]);
    }
  });

  it("never carries a process list, a card name or a command line", () => {
    const wire = JSON.stringify(gpuFacts(gpu({ processes: [{ pid: 1, comm: "secret-app", cmdline: "secret-app --file /srv/x", containerId: null }] })));
    expect(wire).not.toMatch(/secret|card1|A card|srv/);
  });
});

describe("readActivityCounts", () => {
  it("asks COUNT queries over the window and counts distinct actors without keeping their ids", async () => {
    const from = new Date("2026-10-03T11:55:00.000Z");
    const prisma = {
      chatMessage: { count: vi.fn(async () => 7) },
      agentRun: { count: vi.fn(async () => 2) },
      activityRow: { findMany: vi.fn(async () => [{ actorId: "u1" }, { actorId: "u2" }, { actorId: "u3" }]) },
      deviceUpdate: {
        count: vi.fn(async ({ where }: { where: { status?: unknown; createdAt?: unknown } }) => {
          if (where.createdAt) return 1;
          if (where.status === "committed") return 2;
          if (where.status === "rolled_back") return 3;
          return 4;
        }),
      },
    };
    const counts = await readActivityCounts(prisma as unknown as PrismaClient, from);
    expect(counts).toEqual({ chatTurns: 7, agentRuns: 2, activeUsers: 3, downloads: 1, applies: 2, rollbacks: 3, failures: 4 });
    expect(prisma.chatMessage.count).toHaveBeenCalledWith({ where: { role: "user", kind: "message", createdAt: { gte: from } } });
    expect(prisma.agentRun.count).toHaveBeenCalledWith({ where: { createdAt: { gte: from } } });
    expect(prisma.activityRow.findMany).toHaveBeenCalledWith({
      where: { at: { gte: from }, actorType: "user", actorId: { not: null } },
      distinct: ["actorId"],
      select: { actorId: true },
    });
    expect(prisma.deviceUpdate.count).toHaveBeenCalledWith({ where: { status: { in: ["failed", "rejected"] }, updatedAt: { gte: from } } });
    expect(JSON.stringify(counts)).not.toMatch(/u1|u2|u3/);
  });
});

describe("readRelease", () => {
  const prismaWith = (row: unknown, settings: unknown = null) =>
    ({
      deviceUpdate: { findFirst: vi.fn(async () => row) },
      systemFlag: { findUnique: vi.fn(async () => (settings ? { valueJson: settings } : null)) },
    }) as unknown as PrismaClient;

  it("is the newest committed release's tag, sha and channel", async () => {
    const r = await readRelease(prismaWith({ releaseTag: "ota-stage-12-gabc1234", gitSha: "a".repeat(40), channel: "stage" }));
    expect(r).toEqual({ tag: "ota-stage-12-gabc1234", gitSha: "a".repeat(40), channel: "stage" });
  });

  it("labels a committed row with no tag the way the health page does", async () => {
    const r = await readRelease(prismaWith({ releaseTag: null, gitSha: "0123456789abcdef".repeat(2).slice(0, 40), channel: "stable" }));
    expect(r.tag).toBe("git-0123456789");
  });

  it("a box with no committed release reports nothing for tag and sha, on the update agent's channel", async () => {
    const r = await readRelease(prismaWith(null, { channel: "stage", applyWindowCron: "0 3 * * *", autoApply: true }));
    expect(r).toEqual({ tag: null, gitSha: null, channel: "stage" });
  });

  it("falls back to stable when neither names a known channel", async () => {
    const r = await readRelease(prismaWith({ releaseTag: "t", gitSha: "a".repeat(40), channel: "beta" }));
    expect(r.channel).toBe("stable");
  });
});

describe("createCollectors", () => {
  const prisma = {
    chatMessage: { count: vi.fn(async () => 4) },
    agentRun: { count: vi.fn(async () => 1) },
    activityRow: { findMany: vi.fn(async () => [{ actorId: "u1" }]) },
    deviceUpdate: { count: vi.fn(async () => 0), findFirst: vi.fn(async () => null) },
    systemFlag: { findUnique: vi.fn(async () => null) },
  } as unknown as PrismaClient;
  const window = { now: new Date("2026-10-03T12:00:00.000Z"), windowSec: 300, otaChecks: 2, otaVerifyFailures: 1 };

  it("without Docker: no services and no container data, never an invented empty health", async () => {
    const c = createCollectors({ prisma, docker: null, fetchGpu: async () => null, diskPaths: ["/"] });
    expect(await c.containers()).toBeNull();
    const facts = await c.heartbeat(window);
    expect(facts.services).toEqual([]);
    expect(facts.os.distro).toBe("unknown");
    expect(facts.release).toEqual({ tag: null, gitSha: null, channel: "stable" });
    expect(facts.usage.gpus).toEqual([]);
    expect(facts.activity).toMatchObject({
      windowSec: 300,
      chatTurns: 4,
      agentRuns: 1,
      activeUsers: 1,
      ota: { checks: 2, downloads: 0, applies: 0, rollbacks: 0, failures: 1 },
      errorsByClass: {},
    });
    expect(facts.usage).toMatchObject({ netRxBytes: 5000, netTxBytes: 2000 });
    expect(facts.usage.diskPct).toBeGreaterThanOrEqual(0);
    expect(facts.usage.diskPct).toBeLessThanOrEqual(100);
  });

  it("with Docker: the host's OS and the compose services", async () => {
    const d = docker({
      "/info": { body: { KernelVersion: "6.8.0-45-generic", OperatingSystem: "Ubuntu 24.04.1 LTS" } },
      "/containers/json": { body: [entry("c1", "orchestrator")] },
      "/containers/c1/json": { body: { RestartCount: 0, State: { Status: "running", Health: { Status: "healthy" } } } },
    });
    const c = createCollectors({ prisma, docker: d.request, fetchGpu: async () => null, diskPaths: ["/"] });
    const facts = await c.heartbeat(window);
    expect(facts.os).toEqual({ kernel: "6.8.0-45-generic", distro: "Ubuntu 24.04.1 LTS" });
    expect(facts.services).toEqual([{ name: "orchestrator", state: "running", health: "healthy", restarts: 0 }]);
    expect(await c.containers()).toEqual([{ name: "orchestrator", state: "running", health: "healthy", restarts: 0, exitCode: null }]);
  });

  it("a Docker that errors gives no container data, not a crash", async () => {
    const failing: DockerRequest = async () => {
      throw new Error("ENOENT docker.sock");
    };
    const c = createCollectors({ prisma, docker: failing, fetchGpu: async () => null, diskPaths: ["/"] });
    expect(await c.containers()).toBeNull();
    expect((await c.heartbeat(window)).services).toEqual([]);
  });
});
