/**
 * WARP-538 — update-agent poller integration tests.
 *
 * A real local HTTP server plays GitHub Releases (`latest` endpoint +
 * asset downloads over the golden __fixtures__ bytes), and signature
 * verification execs the REAL cosign binary against the TEST-ONLY
 * fixture key — the full discover→download→verify→persist pipeline runs
 * end to end; only the DeviceUpdate store is an in-memory stand-in
 * (repo convention, mirrors claim-code.service.test.ts).
 *
 * AC under test (WARP-538):
 *   - a served fake "latest release" causes a `pending` row;
 *   - re-polling the same release is a no-op (append-only, one row per
 *     release);
 *   - a second, newer release marks the first `superseded` and creates
 *     a new `pending` row;
 *   - a signature failure produces NO row + an `update.signature_failed`
 *     log event;
 *   - a channel mismatch produces NO row;
 *   - the 03:00 window handler is an honest stub: logs, never advances
 *     status.
 *
 * AC under test (WARP-1670 — two branches, two channels):
 *   - a `stage` box discovers through the releases LIST and takes the
 *     newest `ota-stage-*` entry, not the newest release overall;
 *   - a `stable` box keeps reading `latest`, so a stage prerelease is
 *     invisible to it;
 *   - a stage-TAGGED release whose signed manifest claims another
 *     channel is still refused — the tag is a filter, the manifest is
 *     the trust decision;
 *   - a box that cannot derive a list endpoint reports the
 *     misconfiguration instead of pretending there is no release.
 *
 * AC under test (WARP-2133 — a 404 has two readings):
 *   - a tokenless 404 reports `source_unauthenticated`, never
 *     `no_release`, and writes no row;
 *   - a 404 WITH a token stays the quiet `no_release`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import http from "node:http";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import type pino from "pino";
import { checkForUpdate, deriveReleasesListUrl, runApplyWindow } from "./poller.js";
import { UPDATE_AGENT_SETTINGS_KEY } from "./settings.js";

const fx = (name: string): Buffer =>
  readFileSync(path.join(__dirname, "__fixtures__", name));
const TEST_KEY = path.join(__dirname, "__fixtures__", "TEST-ONLY-signing.pub");

// ---------------------------------------------------------------------------
// Fake GitHub Releases server
// ---------------------------------------------------------------------------

type ServedRelease = {
  tagName: string;
  manifest: Buffer;
  signature: Buffer;
} | null;

let server: http.Server;
let baseUrl = "";
let served: ServedRelease = null;
/**
 * WARP-1670 — the `GET /releases` list a non-stable channel discovers
 * from, newest-first exactly as GitHub returns it. Each entry serves its
 * own manifest under /assets/<i>/…, so a test can prove WHICH entry the
 * poller picked, not merely that it picked something.
 */
let servedList: NonNullable<ServedRelease>[] = [];

function assetsFor(prefix: string) {
  return [
    { name: "release.json", url: `${baseUrl}${prefix}/manifest` },
    { name: "release.json.sig", url: `${baseUrl}${prefix}/signature` },
    { name: "configs.tar.gz", url: `${baseUrl}${prefix}/configs` },
  ];
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/releases/latest") {
      if (!served) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: "Not Found" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          tag_name: served.tagName,
          assets: assetsFor("/assets"),
        }),
      );
      return;
    }
    if (req.url?.startsWith("/releases?")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          servedList.map((r, i) => ({
            tag_name: r.tagName,
            assets: assetsFor(`/assets/${i}`),
          })),
        ),
      );
      return;
    }
    const listed = /^\/assets\/(\d+)\/(manifest|signature)$/.exec(req.url ?? "");
    if (listed) {
      const entry = servedList[Number(listed[1])];
      if (entry) {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(listed[2] === "manifest" ? entry.manifest : entry.signature);
        return;
      }
    }
    if (req.url === "/assets/manifest" && served) {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(served.manifest);
      return;
    }
    if (req.url === "/assets/signature" && served) {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(served.signature);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no server address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

// ---------------------------------------------------------------------------
// In-memory DeviceUpdate / SystemFlag stand-in (claim-code.test convention)
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

function createPrismaStub(flags: Record<string, unknown> = {}) {
  const rows: Row[] = [];
  let seq = 0;

  const deviceUpdate = {
    _rows: () => rows,
    findFirst: async (args: {
      where?: { gitSha?: string; status?: string };
      orderBy?: unknown;
      select?: unknown;
    }) => {
      const matches = rows.filter(
        (r) =>
          (args.where?.gitSha === undefined || r.gitSha === args.where.gitSha) &&
          (args.where?.status === undefined || r.status === args.where.status),
      );
      // orderBy createdAt desc is the only ordering the poller uses.
      matches.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return matches[0] ? { ...matches[0] } : null;
    },
    updateMany: async (args: {
      where: { status?: string };
      data: { status: string };
    }) => {
      let count = 0;
      for (const r of rows) {
        if (args.where.status !== undefined && r.status !== args.where.status) continue;
        r.status = args.data.status;
        r.updatedAt = new Date();
        count += 1;
      }
      return { count };
    },
    create: async (args: { data: Omit<Row, "id" | "createdAt" | "updatedAt" | "failureReason"> & { failureReason?: string | null } }) => {
      seq += 1;
      const row: Row = {
        id: `du-${seq}`,
        failureReason: null,
        ...args.data,
        createdAt: new Date(Date.now() + seq), // strictly increasing
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

  return {
    deviceUpdate,
    systemFlag,
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
      fn({ deviceUpdate, systemFlag }),
  };
}

function createLoggerSpy() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function opts(
  prisma: ReturnType<typeof createPrismaStub>,
  logger: ReturnType<typeof createLoggerSpy>,
) {
  return {
    prisma: prisma as never as PrismaClient,
    releasesLatestUrl: `${baseUrl}/releases/latest`,
    logger: logger as never as pino.Logger,
    publicKeyPath: TEST_KEY,
  };
}

beforeEach(() => {
  served = null;
  servedList = [];
});

/** Prisma stub pre-seeded with a persisted channel setting. */
function prismaOnChannel(channel: string) {
  return createPrismaStub({
    [UPDATE_AGENT_SETTINGS_KEY]: { channel, applyWindowCron: "0 3 * * *", autoApply: true },
  });
}

// ---------------------------------------------------------------------------

describe("checkForUpdate (WARP-538)", () => {
  it("writes a pending DeviceUpdate for a served, signature-valid release", async () => {
    served = {
      tagName: "ota-1-gvalid",
      manifest: fx("release.valid.json"),
      signature: fx("release.valid.json.sig"),
    };
    const prisma = createPrismaStub();
    const logger = createLoggerSpy();

    const res = await checkForUpdate(opts(prisma, logger));

    expect(res.outcome).toBe("pending_created");
    const rows = prisma.deviceUpdate._rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "pending",
      channel: "stable",
      releaseTag: "ota-1-gvalid",
      gitSha: "0123456789abcdef0123456789abcdef01234567",
      manifestSha256: createHash("sha256").update(fx("release.valid.json")).digest("hex"),
      failureReason: null,
    });
    // The verified manifest is snapshotted for the WARP-539 apply step.
    expect((rows[0]!.manifestJson as { schemaVersion: number }).schemaVersion).toBe(1);
    // WARP-541 — the check tick and the trust-chain pass are traceable
    // (debug level: they fire on every poll, not just on new releases).
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ event: "update.check_started" }),
      expect.any(String),
    );
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "update.manifest_verified",
        gitSha: "0123456789abcdef0123456789abcdef01234567",
        channel: "stable",
      }),
      expect.any(String),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "update.pending_created" }),
      expect.any(String),
    );
  });

  it("is a no-op when the served release is already tracked (append-only)", async () => {
    served = {
      tagName: "ota-1-gvalid",
      manifest: fx("release.valid.json"),
      signature: fx("release.valid.json.sig"),
    };
    const prisma = createPrismaStub();
    const logger = createLoggerSpy();

    await checkForUpdate(opts(prisma, logger));
    const res = await checkForUpdate(opts(prisma, logger));

    expect(res.outcome).toBe("already_known");
    expect(prisma.deviceUpdate._rows()).toHaveLength(1);
    expect(prisma.deviceUpdate._rows()[0]!.status).toBe("pending");
  });

  it("supersedes the prior pending row when a newer release appears", async () => {
    served = {
      tagName: "ota-1-gvalid",
      manifest: fx("release.valid.json"),
      signature: fx("release.valid.json.sig"),
    };
    const prisma = createPrismaStub();
    const logger = createLoggerSpy();
    await checkForUpdate(opts(prisma, logger));

    served = {
      tagName: "ota-2-gnewer",
      manifest: fx("release.valid-v2.json"),
      signature: fx("release.valid-v2.json.sig"),
    };
    const res = await checkForUpdate(opts(prisma, logger));

    expect(res).toMatchObject({ outcome: "pending_created", supersededCount: 1 });
    const rows = prisma.deviceUpdate._rows();
    expect(rows).toHaveLength(2);
    const byTag = Object.fromEntries(rows.map((r) => [r.releaseTag, r.status]));
    expect(byTag).toEqual({
      "ota-1-gvalid": "superseded",
      "ota-2-gnewer": "pending",
    });
  });

  it("writes NO row on signature failure and logs update.signature_failed", async () => {
    served = {
      tagName: "ota-3-gevil",
      manifest: fx("release.tampered.json"),
      signature: fx("release.tampered.json.sig"),
    };
    const prisma = createPrismaStub();
    const logger = createLoggerSpy();

    const res = await checkForUpdate(opts(prisma, logger));

    expect(res).toMatchObject({
      outcome: "verify_failed",
      failureReason: "signature_failed",
    });
    expect(prisma.deviceUpdate._rows()).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "update.signature_failed" }),
      expect.any(String),
    );
  });

  it("writes NO row for a verified release on a different channel", async () => {
    served = {
      tagName: "ota-4-gbeta",
      manifest: fx("release.channel-beta.json"),
      signature: fx("release.channel-beta.json.sig"),
    };
    const prisma = createPrismaStub();
    const logger = createLoggerSpy();

    const res = await checkForUpdate(opts(prisma, logger));

    expect(res).toMatchObject({
      outcome: "channel_mismatch",
      releaseChannel: "beta",
      deviceChannel: "stable",
    });
    expect(prisma.deviceUpdate._rows()).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "update.channel_mismatch" }),
      expect.any(String),
    );
  });

  it("reports a tokenless 404 as source_unauthenticated, not no_release", async () => {
    // WARP-2133 — the releases repo is private, so unauthenticated a 404 is
    // indistinguishable from "nothing published". Reporting no_release here
    // is what told operators an unprovisioned box was up to date forever.
    served = null;
    const prisma = createPrismaStub();
    const logger = createLoggerSpy();

    const res = await checkForUpdate(opts(prisma, logger));

    expect(res.outcome).toBe("source_unauthenticated");
    expect(prisma.deviceUpdate._rows()).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "update.source_unauthenticated" }),
      expect.any(String),
    );
  });

  it("treats a 404 WITH a token as a quiet no_release", async () => {
    // The fake server ignores credentials, so the token only selects the
    // branch: authenticated, a 404 really is an observation.
    served = null;
    const prisma = createPrismaStub();
    const logger = createLoggerSpy();

    const res = await checkForUpdate({
      ...opts(prisma, logger),
      githubToken: "ghp-TEST-ONLY",
    });

    expect(res.outcome).toBe("no_release");
    expect(prisma.deviceUpdate._rows()).toHaveLength(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("reports a release missing its manifest assets as fetch_failed", async () => {
    served = {
      tagName: "ota-5-gbare",
      manifest: fx("release.valid.json"),
      signature: fx("release.valid.json.sig"),
    };
    // Point at a latest endpoint whose asset list we can't control —
    // simplest: a second stub response without assets via a one-off server
    // route is overkill; instead serve a latest with no matching names by
    // renaming through a tiny local server override.
    const prisma = createPrismaStub();
    const logger = createLoggerSpy();
    const bare = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ tag_name: "ota-5-gbare", assets: [] }));
    });
    await new Promise<void>((resolve) => bare.listen(0, "127.0.0.1", resolve));
    const addr = bare.address();
    if (addr === null || typeof addr === "string") throw new Error("no address");
    try {
      const res = await checkForUpdate({
        ...opts(prisma, logger),
        releasesLatestUrl: `http://127.0.0.1:${addr.port}/`,
      });
      expect(res.outcome).toBe("fetch_failed");
      expect(prisma.deviceUpdate._rows()).toHaveLength(0);
    } finally {
      await new Promise<void>((resolve, reject) =>
        bare.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// WARP-1670 — two branches, two channels
// ---------------------------------------------------------------------------

describe("deriveReleasesListUrl (WARP-1670)", () => {
  it("turns a latest endpoint into a bounded list endpoint", () => {
    expect(
      deriveReleasesListUrl(
        "https://api.github.com/repos/DropletByWarpLab/droplet-onboard-services/releases/latest",
      ),
    ).toBe(
      "https://api.github.com/repos/DropletByWarpLab/droplet-onboard-services/releases?per_page=30",
    );
  });

  it("returns null for a URL that is not a latest endpoint", () => {
    // The caller must report this as a configuration failure — reporting
    // "no release" would park a stage box on nothing, silently, forever.
    expect(deriveReleasesListUrl("http://127.0.0.1:9/fake-release.json")).toBeNull();
    expect(deriveReleasesListUrl("not a url")).toBeNull();
  });
});

describe("checkForUpdate — channel-aware discovery (WARP-1670)", () => {
  it("a stage box installs the newest ota-stage release and ignores stable", async () => {
    // Newest-first, as GitHub returns it: the stable release is FIRST, so
    // a box that just took `latest` (or the head of the list) would get the
    // wrong build.
    servedList = [
      {
        tagName: "ota-stable-9-gstable",
        manifest: fx("release.valid.json"),
        signature: fx("release.valid.json.sig"),
      },
      {
        tagName: "ota-stage-8-gstage",
        manifest: fx("release.channel-stage.json"),
        signature: fx("release.channel-stage.json.sig"),
      },
    ];
    const prisma = prismaOnChannel("stage");
    const logger = createLoggerSpy();

    const res = await checkForUpdate(opts(prisma, logger));

    expect(res).toMatchObject({ outcome: "pending_created", gitSha: "c".repeat(40) });
    const rows = prisma.deviceUpdate._rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "pending",
      channel: "stage",
      releaseTag: "ota-stage-8-gstage",
    });
  });

  it("a stable box still reads `latest` and never sees the stage prerelease", async () => {
    served = {
      tagName: "ota-stable-9-gstable",
      manifest: fx("release.valid.json"),
      signature: fx("release.valid.json.sig"),
    };
    // A stage release exists and is newer — it must be invisible here.
    servedList = [
      {
        tagName: "ota-stage-8-gstage",
        manifest: fx("release.channel-stage.json"),
        signature: fx("release.channel-stage.json.sig"),
      },
    ];
    const prisma = prismaOnChannel("stable");
    const logger = createLoggerSpy();

    const res = await checkForUpdate(opts(prisma, logger));

    expect(res.outcome).toBe("pending_created");
    expect(prisma.deviceUpdate._rows()[0]).toMatchObject({
      channel: "stable",
      releaseTag: "ota-stable-9-gstable",
    });
  });

  it("refuses a stage-TAGGED release whose SIGNED manifest says another channel", async () => {
    // The tag is unsigned repo metadata; anyone with write access can set
    // it. Discovery may be fooled by it — the trust decision may not.
    servedList = [
      {
        tagName: "ota-stage-7-gliar",
        manifest: fx("release.channel-beta.json"),
        signature: fx("release.channel-beta.json.sig"),
      },
    ];
    const prisma = prismaOnChannel("stage");
    const logger = createLoggerSpy();

    const res = await checkForUpdate(opts(prisma, logger));

    expect(res).toMatchObject({
      outcome: "channel_mismatch",
      releaseChannel: "beta",
      deviceChannel: "stage",
    });
    expect(prisma.deviceUpdate._rows()).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "update.channel_mismatch" }),
      expect.any(String),
    );
  });

  it("is a quiet no_release when the list holds nothing for this channel", async () => {
    servedList = [
      {
        tagName: "ota-stable-9-gstable",
        manifest: fx("release.valid.json"),
        signature: fx("release.valid.json.sig"),
      },
    ];
    const prisma = prismaOnChannel("stage");
    const logger = createLoggerSpy();

    const res = await checkForUpdate(opts(prisma, logger));

    expect(res.outcome).toBe("no_release");
    expect(prisma.deviceUpdate._rows()).toHaveLength(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("reports fetch_failed — not no_release — when no list endpoint can be derived", async () => {
    const prisma = prismaOnChannel("stage");
    const logger = createLoggerSpy();

    const res = await checkForUpdate({
      ...opts(prisma, logger),
      releasesLatestUrl: "http://127.0.0.1:9/fake-release.json",
    });

    expect(res.outcome).toBe("fetch_failed");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "update.check_failed" }),
      expect.any(String),
    );
  });
});

describe("runApplyWindow (WARP-539 stub)", () => {
  it("logs the pending update + autoApply and advances NOTHING", async () => {
    served = {
      tagName: "ota-1-gvalid",
      manifest: fx("release.valid.json"),
      signature: fx("release.valid.json.sig"),
    };
    const prisma = createPrismaStub({
      [UPDATE_AGENT_SETTINGS_KEY]: { autoApply: false },
    });
    const logger = createLoggerSpy();
    await checkForUpdate(opts(prisma, logger));

    await runApplyWindow(prisma as never as PrismaClient, logger as never as pino.Logger);

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "update.apply_window", autoApply: false }),
      expect.any(String),
    );
    expect(prisma.deviceUpdate._rows()[0]!.status).toBe("pending");
  });

  it("is silent when nothing is pending", async () => {
    const prisma = createPrismaStub();
    const logger = createLoggerSpy();

    await runApplyWindow(prisma as never as PrismaClient, logger as never as pino.Logger);

    expect(logger.info).not.toHaveBeenCalled();
  });
});
