/**
 * WARP-539 — apply + health-gated swap + auto-rollback integration tests.
 *
 * Same techniques as poller.test.ts (WARP-538): a real local HTTP server
 * plays the GitHub Release (configs.tar.gz asset download + sha256 gate),
 * a second real HTTP server plays every appliance service's /health(z)
 * endpoint (probed through the SAME httpHealthProbe production code, with
 * only the base-URL mapping injected), and the DeviceUpdate / SystemFlag /
 * ApplianceSetup store is an in-memory stand-in. The compose-over-socket
 * mechanics are behind the ApplyRunner port — the fake here mimics the
 * scripts/lib/apply-update.sh contract exactly (including the detached
 * self-swap helper's health-wait + auto-rollback behaviour), because the
 * real thing recreates Docker containers on the appliance.
 *
 * AC under test (WARP-539):
 *   - happy path walks pending → verifying → applying → (self-swap +
 *     resume-on-boot) → committed;
 *   - a sabotaged new orchestrator image (fails its healthcheck) reaches
 *     rolled_back with the PRIOR digests running everywhere;
 *   - a schema-downgrade manifest reaches rejected without touching a
 *     single container;
 *   - a sidecar that fails its post-swap health gate triggers the inline
 *     rollback (configs restored, previous digests recreated) →
 *     rolled_back;
 *   - a rollback that ALSO fails its health gate → failed +
 *     failureReason degraded_health;
 *   - apply is deferred while the onboarding wizard is in progress
 *     (ApplianceSetup.state !== "ready");
 *   - a configs.tar.gz whose sha256 doesn't match the VERIFIED manifest
 *     is rejected (configs_mismatch);
 *   - the apply window honors autoApply=false;
 *   - every status transition is committed BEFORE the action it guards
 *     (resumability contract).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import http from "node:http";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import type { PrismaClient } from "@prisma/client";
import type pino from "pino";
import {
  applyPendingUpdate,
  resumeInterruptedApply,
  applyWindowTick,
  httpHealthProbe,
  imageRefMatchesDigest,
  type ApplyRunner,
  type RecreateTarget,
} from "./apply.js";
import type { ReleaseManifest, ReleaseService } from "./manifest.js";
import { UPDATE_AGENT_SETTINGS_KEY } from "./settings.js";

const fx = (name: string): Buffer =>
  readFileSync(path.join(__dirname, "__fixtures__", name));

// ---------------------------------------------------------------------------
// Manifest + digests under test
// ---------------------------------------------------------------------------

const GIT_SHA = "0123456789abcdef0123456789abcdef01234567";
const DIGESTS: Record<string, string> = {
  orchestrator: `sha256:${"1".repeat(64)}`,
  "web-dashboard": `sha256:${"2".repeat(64)}`,
  "device-identity-svc": `sha256:${"3".repeat(64)}`,
};
const PREVIOUS: Record<string, string> = {
  orchestrator: `sha256:${"a".repeat(64)}`,
  "web-dashboard": `sha256:${"b".repeat(64)}`,
  "device-identity-svc": `sha256:${"c".repeat(64)}`,
};

// The packed configs asset — content is opaque to apply.ts (extraction is
// the runner's job); only the sha256 link to the VERIFIED manifest matters.
const CONFIGS_TAR = gzipSync(Buffer.from("docker/README — fake packed configs"));
const CONFIGS_SHA = createHash("sha256").update(CONFIGS_TAR).digest("hex");

function buildManifest(overrides: Partial<ReleaseManifest["release"]> = {}): ReleaseManifest {
  return {
    schemaVersion: 1,
    release: {
      gitSha: GIT_SHA,
      builtAt: "2026-06-30T03:00:00Z",
      channel: "stable",
      minOrchestratorSchema: 1,
      ...overrides,
    },
    services: [
      {
        name: "orchestrator",
        image: `ghcr.io/dropletbywarplab/droplet-orchestrator@${DIGESTS.orchestrator}`,
        digest: DIGESTS.orchestrator!,
        healthcheck: { type: "http", port: 3000, path: "/api/orchestrator/health" },
      },
      {
        name: "web-dashboard",
        image: `ghcr.io/dropletbywarplab/droplet-web-dashboard@${DIGESTS["web-dashboard"]}`,
        digest: DIGESTS["web-dashboard"]!,
        healthcheck: { type: "http", port: 3001, path: "/healthz" },
      },
      {
        name: "device-identity-svc",
        image: `ghcr.io/dropletbywarplab/droplet-device-identity-svc@${DIGESTS["device-identity-svc"]}`,
        digest: DIGESTS["device-identity-svc"]!,
        healthcheck: { type: "none" },
      },
    ],
    configs: { file: "configs.tar.gz", sha256: CONFIGS_SHA },
  };
}

// ---------------------------------------------------------------------------
// Fake GitHub Release server (poller.test.ts technique) — serves the
// configs asset the apply step downloads + sha256-gates.
// ---------------------------------------------------------------------------

let releaseServer: http.Server;
let releaseBaseUrl = "";
let servedTag = "ota-9-gapply";
let servedConfigs: Buffer = CONFIGS_TAR;

// ---------------------------------------------------------------------------
// Fake per-service health endpoints — ONE real HTTP server; the production
// httpHealthProbe is pointed at it via the injectable base-URL mapping.
// Health is keyed by (service, which digest generation is running) so a
// sabotaged image can be modeled as "unhealthy while the release digest
// runs, healthy again on the previous digest".
// ---------------------------------------------------------------------------

let healthServer: http.Server;
let healthBaseUrl = "";
/** service name -> is it healthy right now? (test flips these) */
const healthy: Record<string, boolean> = {};

beforeAll(async () => {
  releaseServer = http.createServer((req, res) => {
    if (req.url === "/releases/latest") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          tag_name: servedTag,
          assets: [
            { name: "release.json", url: `${releaseBaseUrl}/assets/manifest` },
            { name: "release.json.sig", url: `${releaseBaseUrl}/assets/signature` },
            { name: "configs.tar.gz", url: `${releaseBaseUrl}/assets/configs` },
          ],
        }),
      );
      return;
    }
    if (req.url === "/assets/configs") {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(servedConfigs);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => releaseServer.listen(0, "127.0.0.1", resolve));
  const rAddr = releaseServer.address();
  if (rAddr === null || typeof rAddr === "string") throw new Error("no address");
  releaseBaseUrl = `http://127.0.0.1:${rAddr.port}`;

  healthServer = http.createServer((req, res) => {
    // Path shape: /svc/<name>/<original healthcheck path...>
    const m = /^\/svc\/([a-z0-9-]+)\//.exec(req.url ?? "");
    const name = m?.[1] ?? "";
    if (healthy[name]) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    } else {
      res.writeHead(503);
      res.end();
    }
  });
  await new Promise<void>((resolve) => healthServer.listen(0, "127.0.0.1", resolve));
  const hAddr = healthServer.address();
  if (hAddr === null || typeof hAddr === "string") throw new Error("no address");
  healthBaseUrl = `http://127.0.0.1:${hAddr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    releaseServer.close((err) => (err ? reject(err) : resolve())),
  );
  await new Promise<void>((resolve, reject) =>
    healthServer.close((err) => (err ? reject(err) : resolve())),
  );
});

// ---------------------------------------------------------------------------
// In-memory Prisma stand-in (poller.test.ts convention) + ApplianceSetup
// ---------------------------------------------------------------------------

interface Row {
  id: string;
  status: string;
  channel: string;
  releaseTag: string | null;
  gitSha: string;
  builtAt: Date;
  manifestSha256: string;
  manifestJson: unknown;
  failureReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function createPrismaStub(opts: {
  applianceState?: string;
  flags?: Record<string, unknown>;
} = {}) {
  const rows: Row[] = [];
  /** Every status write, in order — proves transitions commit BEFORE actions. */
  const statusWrites: Array<{ id: string; status: string; failureReason?: string | null }> = [];
  const flags: Record<string, unknown> = { ...(opts.flags ?? {}) };
  let seq = 0;

  const deviceUpdate = {
    _rows: () => rows,
    _statusWrites: () => statusWrites,
    findFirst: async (args: {
      where?: { status?: string | { in: string[] }; gitSha?: string };
      orderBy?: unknown;
    }) => {
      const statusMatch = (r: Row) => {
        const s = args.where?.status;
        if (s === undefined) return true;
        if (typeof s === "string") return r.status === s;
        return s.in.includes(r.status);
      };
      const matches = rows.filter(
        (r) =>
          statusMatch(r) &&
          (args.where?.gitSha === undefined || r.gitSha === args.where.gitSha),
      );
      matches.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return matches[0] ? { ...matches[0] } : null;
    },
    update: async (args: {
      where: { id: string };
      data: { status?: string; failureReason?: string | null };
    }) => {
      const row = rows.find((r) => r.id === args.where.id);
      if (!row) throw new Error(`no DeviceUpdate row ${args.where.id}`);
      if (args.data.status !== undefined) row.status = args.data.status;
      if ("failureReason" in args.data) row.failureReason = args.data.failureReason ?? null;
      row.updatedAt = new Date();
      statusWrites.push({
        id: row.id,
        status: row.status,
        failureReason: row.failureReason,
      });
      return { ...row };
    },
    create: async (args: { data: Omit<Row, "id" | "createdAt" | "updatedAt" | "failureReason"> & { failureReason?: string | null } }) => {
      seq += 1;
      const row: Row = {
        id: `du-${seq}`,
        failureReason: null,
        ...args.data,
        createdAt: new Date(Date.now() + seq),
        updatedAt: new Date(),
      };
      rows.push(row);
      return { ...row };
    },
  };

  const systemFlag = {
    findUnique: async (args: { where: { key: string } }) =>
      args.where.key in flags
        ? { key: args.where.key, valueJson: flags[args.where.key], createdAt: new Date() }
        : null,
    upsert: async (args: {
      where: { key: string };
      create: { key: string; valueJson: unknown };
      update: { valueJson: unknown };
    }) => {
      flags[args.where.key] = args.create.valueJson;
      return { key: args.where.key, valueJson: flags[args.where.key], createdAt: new Date() };
    },
  };

  const applianceSetup = {
    findUnique: async () => ({
      id: "singleton",
      state: opts.applianceState ?? "ready",
      setupStep: "done",
      userTourCompleted: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
  };

  return { deviceUpdate, systemFlag, applianceSetup };
}

type PrismaStub = ReturnType<typeof createPrismaStub>;

async function seedPendingRow(prisma: PrismaStub, manifest: unknown, tag = servedTag) {
  const m = manifest as ReleaseManifest;
  return prisma.deviceUpdate.create({
    data: {
      status: "pending",
      channel: "stable",
      releaseTag: tag,
      gitSha: (m.release?.gitSha as string) ?? GIT_SHA,
      builtAt: new Date("2026-06-30T03:00:00Z"),
      manifestSha256: createHash("sha256")
        .update(JSON.stringify(manifest))
        .digest("hex"),
      manifestJson: manifest,
    },
  });
}

function createLoggerSpy() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

// ---------------------------------------------------------------------------
// Fake ApplyRunner — mimics the scripts/lib/apply-update.sh contract,
// including the detached self-swap helper's health-wait + auto-rollback.
// ---------------------------------------------------------------------------

class FakeRunner implements ApplyRunner {
  calls: string[] = [];
  /** service name -> image ref currently "running" */
  running: Record<string, string | null> = { ...PREVIOUS };
  /** does the new orchestrator image come up healthy? (sabotage knob) */
  selfSwapHealthy = true;
  /** hook fired whenever a recreate lands, so tests can flip health state */
  onRecreate: (services: string[], target: RecreateTarget) => void = () => {};

  async currentImageRefs(services: string[]): Promise<Record<string, string | null>> {
    this.calls.push(`currentImageRefs(${services.join(",")})`);
    return Object.fromEntries(services.map((s) => [s, this.running[s] ?? null]));
  }

  async snapshot(opts: { updateId: string; previousRefs: Record<string, string | null> }) {
    this.calls.push(`snapshot(${opts.updateId})`);
  }

  async pullImages(services: ReleaseService[]) {
    this.calls.push(`pullImages(${services.map((s) => s.name).join(",")})`);
  }

  async stageConfigs(opts: { updateId: string; configsTar: Buffer }) {
    this.calls.push(`stageConfigs(${opts.updateId},${opts.configsTar.length}b)`);
  }

  async migrateDeploy() {
    this.calls.push("migrateDeploy()");
  }

  async recreateServices(opts: {
    updateId: string;
    services: string[];
    target: RecreateTarget;
  }) {
    this.calls.push(`recreateServices(${opts.services.join(",")},${opts.target})`);
    for (const s of opts.services) {
      this.running[s] = opts.target === "release" ? DIGESTS[s]! : PREVIOUS[s]!;
    }
    this.onRecreate(opts.services, opts.target);
  }

  async restoreConfigs(opts: { updateId: string }) {
    this.calls.push(`restoreConfigs(${opts.updateId})`);
  }

  async recreateSelfDetached(opts: { updateId: string; target: RecreateTarget }) {
    this.calls.push(`recreateSelfDetached(${opts.updateId},${opts.target})`);
    // Model the DETACHED helper (apply-update.sh self-swap): recreate the
    // orchestrator, wait on its container healthcheck, and on failure roll
    // EVERYTHING back to the previous refs — all outside the orchestrator
    // process. The DB verdict is written later by whichever orchestrator
    // boots (resumeInterruptedApply).
    if (opts.target === "release") {
      if (this.selfSwapHealthy) {
        this.running.orchestrator = DIGESTS.orchestrator!;
      } else {
        for (const s of Object.keys(this.running)) this.running[s] = PREVIOUS[s]!;
      }
    } else {
      for (const s of Object.keys(this.running)) this.running[s] = PREVIOUS[s]!;
    }
  }
}

// ---------------------------------------------------------------------------

function baseOpts(prisma: PrismaStub, runner: FakeRunner, logger = createLoggerSpy()) {
  return {
    prisma: prisma as never as PrismaClient,
    runner,
    releasesLatestUrl: `${releaseBaseUrl}/releases/latest`,
    logger: logger as never as pino.Logger,
    probe: httpHealthProbe({
      baseUrlFor: (svc: ReleaseService) => `${healthBaseUrl}/svc/${svc.name}`,
    }),
    healthGate: { attempts: 2, intervalMs: 10 },
  };
}

beforeEach(() => {
  servedTag = "ota-9-gapply";
  servedConfigs = CONFIGS_TAR;
  healthy.orchestrator = true;
  healthy["web-dashboard"] = true;
  healthy["device-identity-svc"] = true; // type "none" — never actually probed
});

// ---------------------------------------------------------------------------

describe("applyPendingUpdate (WARP-539)", () => {
  it("happy path: pending → verifying → applying → self-swap → resume → committed", async () => {
    const prisma = createPrismaStub();
    const runner = new FakeRunner();
    const logger = createLoggerSpy();
    await seedPendingRow(prisma, buildManifest());

    const res = await applyPendingUpdate(baseOpts(prisma, runner, logger));

    expect(res.outcome).toBe("self_swap_started");
    // Steps 1-5 ran in the design order, orchestrator excluded from the
    // sidecar recreate and swapped LAST via the detached helper.
    expect(runner.calls).toEqual([
      "currentImageRefs(orchestrator,web-dashboard,device-identity-svc)",
      "snapshot(du-1)",
      "pullImages(orchestrator,web-dashboard,device-identity-svc)",
      `stageConfigs(du-1,${CONFIGS_TAR.length}b)`,
      "migrateDeploy()",
      "recreateServices(web-dashboard,device-identity-svc,release)",
      "recreateSelfDetached(du-1,release)",
    ]);
    // Resumability contract: verifying and applying were COMMITTED before
    // the actions they guard, and the row is still `applying` while the
    // detached self-swap is in flight.
    expect(prisma.deviceUpdate._statusWrites().map((w) => w.status)).toEqual([
      "verifying",
      "applying",
    ]);
    expect(prisma.deviceUpdate._rows()[0]!.status).toBe("applying");

    // ── the new orchestrator boots and resumes ──
    const resume = await resumeInterruptedApply(baseOpts(prisma, runner, logger));
    expect(resume.outcome).toBe("committed");
    expect(prisma.deviceUpdate._rows()[0]).toMatchObject({
      status: "committed",
      failureReason: null,
    });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "update.committed", deviceUpdateId: "du-1" }),
      expect.any(String),
    );
    // Everything runs the release digests.
    expect(runner.running).toEqual(DIGESTS);
  });

  it("sabotaged orchestrator image reaches rolled_back with the PRIOR digests running", async () => {
    const prisma = createPrismaStub();
    const runner = new FakeRunner();
    runner.selfSwapHealthy = false; // the new orchestrator image never goes healthy
    const logger = createLoggerSpy();
    await seedPendingRow(prisma, buildManifest());

    const res = await applyPendingUpdate(baseOpts(prisma, runner, logger));
    expect(res.outcome).toBe("self_swap_started");
    // The detached helper timed out on the new orchestrator's healthcheck
    // and rolled everything back — now the OLD orchestrator boots again.
    const resume = await resumeInterruptedApply(baseOpts(prisma, runner, logger));

    expect(resume.outcome).toBe("rolled_back");
    expect(prisma.deviceUpdate._rows()[0]).toMatchObject({
      status: "rolled_back",
      failureReason: "health_gate_failed",
    });
    // AC: the box is RUNNING the prior digests.
    expect(runner.running).toEqual(PREVIOUS);
  });

  it("schema-downgrade manifest reaches rejected without touching containers", async () => {
    const prisma = createPrismaStub();
    const runner = new FakeRunner();
    const logger = createLoggerSpy();
    // The golden WARP-537 fixture — schemaVersion 0 (downgrade).
    await seedPendingRow(prisma, JSON.parse(fx("release.schema-downgrade.json").toString("utf8")));

    const res = await applyPendingUpdate(baseOpts(prisma, runner, logger));

    expect(res).toMatchObject({ outcome: "rejected", failureReason: "schema_downgrade" });
    expect(prisma.deviceUpdate._rows()[0]).toMatchObject({
      status: "rejected",
      failureReason: "schema_downgrade",
    });
    // The refusal happened before ANY runner step.
    expect(runner.calls).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "update.rejected" }),
      expect.any(String),
    );
  });

  it("rejects with image_signature_failed when the pull step refuses a signature", async () => {
    const prisma = createPrismaStub();
    const runner = new FakeRunner();
    const logger = createLoggerSpy();
    // WARP-244: apply-update.sh dies with the canonical "image-verify:"
    // stderr prefix when cosign refuses an image at pull time.
    runner.pullImages = async () => {
      const err = new Error("OTA host helper (apply-update.sh) failed") as Error & {
        stderr?: string;
      };
      err.stderr =
        "[apply-update] ERROR: image-verify: cosign rejected ghcr.io/dropletbywarplab/droplet-orchestrator@sha256:" +
        "a".repeat(64) +
        " — only images signed by the publish-release workflow may be pulled (WARP-244, docs/SECURITY.md)";
      throw err;
    };
    await seedPendingRow(prisma, buildManifest());

    const res = await applyPendingUpdate(baseOpts(prisma, runner, logger));

    expect(res.outcome).toBe("rejected");
    if (res.outcome === "rejected") {
      expect(res.failureReason).toBe("image_signature_failed");
      expect(res.detail).toContain("image-verify:");
    }
    expect(prisma.deviceUpdate._rows()[0]).toMatchObject({
      status: "rejected",
      failureReason: "image_signature_failed",
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "update.rejected",
        failureReason: "image_signature_failed",
      }),
      expect.any(String),
    );
  });

  it("keeps a plain network pull failure on the retry path (throws, row stays verifying)", async () => {
    const prisma = createPrismaStub();
    const runner = new FakeRunner();
    const logger = createLoggerSpy();
    runner.pullImages = async () => {
      throw new Error('Get "https://ghcr.io/v2/": dial tcp: i/o timeout');
    };
    await seedPendingRow(prisma, buildManifest());

    await expect(applyPendingUpdate(baseOpts(prisma, runner, logger))).rejects.toThrow(
      "i/o timeout",
    );
    // A transient error is NOT a signature rejection: the row must remain
    // `verifying` so the next apply window retries.
    expect(prisma.deviceUpdate._rows()[0]!.status).toBe("verifying");
  });

  it("sidecar failing its health gate triggers the inline rollback → rolled_back", async () => {
    const prisma = createPrismaStub();
    const runner = new FakeRunner();
    const logger = createLoggerSpy();
    // web-dashboard is unhealthy exactly while the release digest runs.
    runner.onRecreate = (services, target) => {
      if (services.includes("web-dashboard")) {
        healthy["web-dashboard"] = target === "previous";
      }
    };
    await seedPendingRow(prisma, buildManifest());

    const res = await applyPendingUpdate(baseOpts(prisma, runner, logger));

    expect(res.outcome).toBe("rolled_back");
    expect(prisma.deviceUpdate._rows()[0]).toMatchObject({
      status: "rolled_back",
      failureReason: "health_gate_failed",
    });
    // Rollback restored configs and recreated the sidecars on the previous
    // refs; the orchestrator itself was NEVER swapped.
    expect(runner.calls).toContain("restoreConfigs(du-1)");
    expect(runner.calls).toContain("recreateServices(web-dashboard,device-identity-svc,previous)");
    expect(runner.calls.some((c) => c.startsWith("recreateSelfDetached"))).toBe(false);
    expect(runner.running).toEqual(PREVIOUS);
  });

  it("rollback that ALSO fails health-gates → failed + degraded_health", async () => {
    const prisma = createPrismaStub();
    const runner = new FakeRunner();
    const logger = createLoggerSpy();
    await seedPendingRow(prisma, buildManifest());
    // web-dashboard never comes back, on either digest generation.
    runner.onRecreate = (services) => {
      if (services.includes("web-dashboard")) healthy["web-dashboard"] = false;
    };

    const res = await applyPendingUpdate(baseOpts(prisma, runner, logger));

    expect(res.outcome).toBe("failed");
    expect(prisma.deviceUpdate._rows()[0]).toMatchObject({
      status: "failed",
      failureReason: "degraded_health",
    });
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: "update.failed", failureReason: "degraded_health" }),
      expect.any(String),
    );
  });

  it("defers (row untouched) while the onboarding wizard is in progress", async () => {
    const prisma = createPrismaStub({ applianceState: "unclaimed" });
    const runner = new FakeRunner();
    const logger = createLoggerSpy();
    await seedPendingRow(prisma, buildManifest());

    const res = await applyPendingUpdate(baseOpts(prisma, runner, logger));

    expect(res.outcome).toBe("deferred_setup_in_progress");
    expect(prisma.deviceUpdate._rows()[0]!.status).toBe("pending");
    expect(runner.calls).toEqual([]);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "update.apply_deferred" }),
      expect.any(String),
    );
  });

  it("rejects a configs.tar.gz whose sha256 doesn't match the verified manifest", async () => {
    const prisma = createPrismaStub();
    const runner = new FakeRunner();
    const logger = createLoggerSpy();
    servedConfigs = gzipSync(Buffer.from("tampered configs"));
    await seedPendingRow(prisma, buildManifest());

    const res = await applyPendingUpdate(baseOpts(prisma, runner, logger));

    expect(res).toMatchObject({ outcome: "rejected", failureReason: "configs_mismatch" });
    expect(prisma.deviceUpdate._rows()[0]).toMatchObject({
      status: "rejected",
      failureReason: "configs_mismatch",
    });
    // Refusal happens before any container/config mutation.
    expect(runner.calls.filter((c) => !c.startsWith("currentImageRefs"))).toEqual([]);
  });

  it("leaves the row verifying (retry_later) on a transient release fetch failure", async () => {
    const prisma = createPrismaStub();
    const runner = new FakeRunner();
    const logger = createLoggerSpy();
    await seedPendingRow(prisma, buildManifest());

    const res = await applyPendingUpdate({
      ...baseOpts(prisma, runner, logger),
      // unreachable port — connection refused
      releasesLatestUrl: "http://127.0.0.1:1/releases/latest",
    });

    expect(res.outcome).toBe("retry_later");
    // Advance-only: the row stays parked at verifying; the next window
    // tick (or boot resume) re-runs the apply from the top.
    expect(prisma.deviceUpdate._rows()[0]!.status).toBe("verifying");
  });

  it("returns nothing_pending when the table has no applicable row", async () => {
    const prisma = createPrismaStub();
    const runner = new FakeRunner();
    const res = await applyPendingUpdate(baseOpts(prisma, runner));
    expect(res.outcome).toBe("nothing_pending");
    expect(runner.calls).toEqual([]);
  });
});

describe("resumeInterruptedApply (WARP-539 onStart hook)", () => {
  it("re-runs the apply for a row interrupted at verifying", async () => {
    const prisma = createPrismaStub();
    const runner = new FakeRunner();
    const logger = createLoggerSpy();
    const row = await seedPendingRow(prisma, buildManifest());
    // Simulate a crash right after the verifying transition committed.
    await prisma.deviceUpdate.update({ where: { id: row.id }, data: { status: "verifying" } });

    const resume = await resumeInterruptedApply(baseOpts(prisma, runner, logger));

    expect(resume.outcome).toBe("resumed_apply");
    // The re-run walked the full pipeline again and reached the self-swap.
    expect(prisma.deviceUpdate._rows()[0]!.status).toBe("applying");
    expect(runner.calls.some((c) => c.startsWith("recreateSelfDetached"))).toBe(true);
  });

  it("is a no-op when nothing was interrupted", async () => {
    const prisma = createPrismaStub();
    const runner = new FakeRunner();
    const resume = await resumeInterruptedApply(baseOpts(prisma, runner));
    expect(resume.outcome).toBe("nothing_to_resume");
    expect(runner.calls).toEqual([]);
  });

  it("post-swap degraded sidecar: new orchestrator starts the detached FULL rollback", async () => {
    const prisma = createPrismaStub();
    const runner = new FakeRunner();
    const logger = createLoggerSpy();
    await seedPendingRow(prisma, buildManifest());
    await applyPendingUpdate(baseOpts(prisma, runner, logger));
    // We are now the NEW orchestrator — but a sidecar died between the
    // pre-swap gate and now.
    healthy["web-dashboard"] = false;

    const resume = await resumeInterruptedApply(baseOpts(prisma, runner, logger));

    expect(resume.outcome).toBe("self_rollback_started");
    // Row still applying — the OLD orchestrator's resume writes the verdict.
    expect(prisma.deviceUpdate._rows()[0]!.status).toBe("applying");
    expect(runner.calls).toContain("recreateSelfDetached(du-1,previous)");
    // The helper's rollback put the previous refs back; when the old
    // orchestrator boots, ITS resume writes rolled_back.
    healthy["web-dashboard"] = true;
    const verdict = await resumeInterruptedApply(baseOpts(prisma, runner, logger));
    expect(verdict.outcome).toBe("rolled_back");
    expect(prisma.deviceUpdate._rows()[0]).toMatchObject({
      status: "rolled_back",
      failureReason: "health_gate_failed",
    });
  });
});

describe("applyWindowTick (WARP-539 window dispatch)", () => {
  it("applies the pending update when autoApply is on (default)", async () => {
    const prisma = createPrismaStub();
    const runner = new FakeRunner();
    const logger = createLoggerSpy();
    await seedPendingRow(prisma, buildManifest());

    const res = await applyWindowTick(baseOpts(prisma, runner, logger));

    expect(res.outcome).toBe("self_swap_started");
    expect(prisma.deviceUpdate._rows()[0]!.status).toBe("applying");
  });

  it("waits (no action) when autoApply is off", async () => {
    const prisma = createPrismaStub({
      flags: { [UPDATE_AGENT_SETTINGS_KEY]: { autoApply: false } },
    });
    const runner = new FakeRunner();
    const logger = createLoggerSpy();
    await seedPendingRow(prisma, buildManifest());

    const res = await applyWindowTick(baseOpts(prisma, runner, logger));

    expect(res.outcome).toBe("deferred_auto_apply_off");
    expect(prisma.deviceUpdate._rows()[0]!.status).toBe("pending");
    expect(runner.calls).toEqual([]);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "update.apply_window_waiting" }),
      expect.any(String),
    );
  });

  it("is silent when nothing is pending", async () => {
    const prisma = createPrismaStub();
    const runner = new FakeRunner();
    const res = await applyWindowTick(baseOpts(prisma, runner));
    expect(res.outcome).toBe("nothing_pending");
  });
});

describe("imageRefMatchesDigest", () => {
  it("matches repo digests, bare digests, and pinned image refs", () => {
    const d = DIGESTS.orchestrator!;
    expect(imageRefMatchesDigest(d, d)).toBe(true);
    expect(imageRefMatchesDigest(`ghcr.io/x/y@${d}`, d)).toBe(true);
    expect(imageRefMatchesDigest(PREVIOUS.orchestrator!, d)).toBe(false);
    expect(imageRefMatchesDigest(null, d)).toBe(false);
  });
});
