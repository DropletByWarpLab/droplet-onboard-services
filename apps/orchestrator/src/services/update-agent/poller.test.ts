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
 * AC under test (WARP-3430 — anonymous discovery through the signed channel
 * pointer, the GitHub API only as a fallback):
 *   - a stage box and a stable box each follow their own pointer to the
 *     release it names, and ask the API for nothing;
 *   - a pointer with a bad signature, for another channel, or that disagrees
 *     with the manifest it names (sha256 / gitSha / builtAt) writes no row;
 *   - a pointer 404 (no index yet) falls back to the API discovery; any other
 *     pointer failure is `fetch_failed`, never a quiet downgrade to the API;
 *   - a pointer is never accepted as a manifest, nor a manifest as a pointer;
 *   - a verified release not strictly newer than the installed one (the newest
 *     COMMITTED row) is `not_newer` and writes no row.
 * These sign their documents at run time with a throwaway key the test passes
 * as the trust anchor (node's ECDSA P-256/SHA-256, the same base64-DER shape
 * `cosign sign-blob` writes), and verify them with the REAL cosign binary.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import http from "node:http";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import type pino from "pino";
import { CHANNEL_POINTER_KIND } from "./channel-pointer.js";
import { checkForUpdate, deriveReleasesListUrl, onUpdateCheck, runApplyWindow } from "./poller.js";
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
/**
 * WARP-3430 — the anonymous download tree under `/dl` (path → bytes): the
 * signed channel pointers at `/dl/ota-index/…` and each release's files at
 * `/dl/<tag>/…`. Anything not in the map is a 404, i.e. "not published yet".
 */
const downloads = new Map<string, Buffer>();
/** path → status, to make one download fail the way a real mirror might. */
const forcedStatus = new Map<string, number>();
/** Every URL the fake server was asked for, in order. */
let requested: string[] = [];
/** Every Authorization header it was sent — the anonymous path must send none. */
let authorizations: string[] = [];

function assetsFor(prefix: string) {
  return [
    { name: "release.json", url: `${baseUrl}${prefix}/manifest` },
    { name: "release.json.sig", url: `${baseUrl}${prefix}/signature` },
    { name: "configs.tar.gz", url: `${baseUrl}${prefix}/configs` },
  ];
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    requested.push(req.url ?? "");
    if (req.headers.authorization) authorizations.push(req.headers.authorization);
    const forced = forcedStatus.get(req.url ?? "");
    if (forced !== undefined) {
      res.writeHead(forced);
      res.end();
      return;
    }
    const download = downloads.get(req.url ?? "");
    if (download) {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(download);
      return;
    }
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
  /** WARP-3193 PERF-3 — is an apply run holding this row (mirrors schema.prisma)? */
  applyClaim: string;
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
      where: { status?: string; applyClaim?: string };
      data: { status: string };
    }) => {
      let count = 0;
      for (const r of rows) {
        if (args.where.status !== undefined && r.status !== args.where.status) continue;
        if (args.where.applyClaim !== undefined && r.applyClaim !== args.where.applyClaim) continue;
        r.status = args.data.status;
        r.updatedAt = new Date();
        count += 1;
      }
      return { count };
    },
    create: async (args: { data: Omit<Row, "id" | "createdAt" | "updatedAt" | "failureReason" | "applyClaim"> & { failureReason?: string | null; applyClaim?: string } }) => {
      seq += 1;
      const row: Row = {
        id: `du-${seq}`,
        failureReason: null,
        applyClaim: "unclaimed",
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
    // WARP-3430 — nothing is published under /dl unless a test publishes it, so
    // every pre-existing test below runs the pointer's 404 → API fallback.
    downloadBase: `${baseUrl}/dl`,
    logger: logger as never as pino.Logger,
    publicKeyPath: TEST_KEY,
  };
}

beforeEach(() => {
  served = null;
  servedList = [];
  downloads.clear();
  forcedStatus.clear();
  requested = [];
  authorizations = [];
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

  it("treats 404 (no release published) as a quiet no_release", async () => {
    served = null;
    const prisma = createPrismaStub();
    const logger = createLoggerSpy();

    const res = await checkForUpdate(opts(prisma, logger));

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

// ---------------------------------------------------------------------------
// WARP-3430 — anonymous discovery through the signed channel pointer
// ---------------------------------------------------------------------------

const STAGE_TAG = "ota-stage-404-g3c71b82";
const STABLE_TAG = "ota-stable-399-g82be2ca";

let anchorDir = "";
let anchorPath = "";
let signingKey: KeyObject;
let otherKey: KeyObject;

beforeAll(() => {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  signingKey = pair.privateKey;
  otherKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
  anchorDir = mkdtempSync(path.join(tmpdir(), "warp3430-anchor-"));
  anchorPath = path.join(anchorDir, "anchor.pub");
  writeFileSync(anchorPath, pair.publicKey.export({ type: "spki", format: "pem" }));
});
afterAll(() => rmSync(anchorDir, { recursive: true, force: true }));

/** base64 of a DER ECDSA-P256-SHA256 signature — what `cosign sign-blob --key` writes. */
const signWith = (key: KeyObject, bytes: Buffer): Buffer =>
  Buffer.from(sign("sha256", bytes, key).toString("base64"));

interface BuiltRelease {
  bytes: Buffer;
  gitSha: string;
  builtAt: string;
}

/** A release.json built from a golden fixture, with the identity fields overridden. */
function builtRelease(
  fixture: string,
  over: { gitSha?: string; builtAt?: string } = {},
): BuiltRelease {
  const m = JSON.parse(fx(fixture).toString("utf8")) as { release: { gitSha: string; builtAt: string } };
  Object.assign(m.release, over);
  return { bytes: Buffer.from(JSON.stringify(m)), gitSha: m.release.gitSha, builtAt: m.release.builtAt };
}

/**
 * Publish a channel pointer + the release it names under /dl, the way the
 * publish workflow lays them out. Signs with the test anchor's key unless told
 * otherwise; `pointer` overrides fields of the pointer body (how a test crafts
 * a lying one); `channel` is only the FILE the pointer is published as.
 */
function publish(args: {
  channel: string;
  tag: string;
  release: BuiltRelease;
  pointer?: Record<string, unknown>;
  pointerKey?: KeyObject;
  manifestKey?: KeyObject;
}): void {
  const pointerBytes = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      kind: CHANNEL_POINTER_KIND,
      channel: args.channel,
      tag: args.tag,
      gitSha: args.release.gitSha,
      builtAt: args.release.builtAt,
      manifestSha256: createHash("sha256").update(args.release.bytes).digest("hex"),
      publishedAt: "2026-05-28T04:00:00Z",
      ...args.pointer,
    }),
  );
  downloads.set(`/dl/ota-index/channel-${args.channel}.json`, pointerBytes);
  downloads.set(
    `/dl/ota-index/channel-${args.channel}.json.sig`,
    signWith(args.pointerKey ?? signingKey, pointerBytes),
  );
  downloads.set(`/dl/${args.tag}/release.json`, args.release.bytes);
  downloads.set(
    `/dl/${args.tag}/release.json.sig`,
    signWith(args.manifestKey ?? signingKey, args.release.bytes),
  );
}

const pointerUrls = (channel: string): string[] => [
  `/dl/ota-index/channel-${channel}.json`,
  `/dl/ota-index/channel-${channel}.json.sig`,
];
const releaseUrls = (tag: string): string[] => [`/dl/${tag}/release.json`, `/dl/${tag}/release.json.sig`];

/** The golden-fixture trust anchor is replaced by the throwaway one the pointer was signed with. */
function pointerOpts(
  prisma: ReturnType<typeof createPrismaStub>,
  logger: ReturnType<typeof createLoggerSpy>,
) {
  return { ...opts(prisma, logger), publicKeyPath: anchorPath };
}

/** A DeviceUpdate row in an arbitrary lifecycle state, for the not-newer floor. */
async function seedRow(
  prisma: ReturnType<typeof createPrismaStub>,
  row: { status: string; gitSha: string; builtAt: string; applyClaim?: string },
) {
  return prisma.deviceUpdate.create({
    data: {
      status: row.status,
      // Absent, not undefined: the stub's spread must keep its "unclaimed" default.
      ...(row.applyClaim ? { applyClaim: row.applyClaim } : {}),
      channel: "stage",
      releaseTag: `ota-stage-1-g${row.gitSha.slice(0, 7)}`,
      gitSha: row.gitSha,
      builtAt: new Date(row.builtAt),
      manifestSha256: "0".repeat(64),
      manifestJson: {},
    },
  });
}

describe("checkForUpdate — signed channel pointer discovery (WARP-3430)", () => {
  it("a stage box follows its pointer to the release it names, anonymously, and asks the API for nothing", async () => {
    const stage = builtRelease("release.channel-stage.json");
    publish({ channel: "stage", tag: STAGE_TAG, release: stage });
    const prisma = prismaOnChannel("stage");
    const logger = createLoggerSpy();

    const res = await checkForUpdate(pointerOpts(prisma, logger));

    expect(res).toMatchObject({ outcome: "pending_created", gitSha: "c".repeat(40) });
    expect(prisma.deviceUpdate._rows()).toHaveLength(1);
    expect(prisma.deviceUpdate._rows()[0]).toMatchObject({
      status: "pending",
      channel: "stage",
      releaseTag: STAGE_TAG,
      gitSha: "c".repeat(40),
      manifestSha256: createHash("sha256").update(stage.bytes).digest("hex"),
    });
    // Four plain downloads, in order, and no REST API request at all.
    expect(requested).toEqual([...pointerUrls("stage"), ...releaseUrls(STAGE_TAG)]);
    expect(authorizations).toEqual([]);
  });

  it("a stable box follows the stable pointer, ignoring a newer stage one", async () => {
    const stable = builtRelease("release.valid.json");
    publish({ channel: "stable", tag: STABLE_TAG, release: stable });
    publish({
      channel: "stage",
      tag: STAGE_TAG,
      release: builtRelease("release.channel-stage.json", { builtAt: "2026-06-30T03:00:00Z" }),
    });
    const prisma = prismaOnChannel("stable");
    const logger = createLoggerSpy();

    const res = await checkForUpdate(pointerOpts(prisma, logger));

    expect(res).toMatchObject({ outcome: "pending_created", gitSha: "0123456789abcdef0123456789abcdef01234567" });
    expect(prisma.deviceUpdate._rows()[0]).toMatchObject({ channel: "stable", releaseTag: STABLE_TAG });
    expect(requested).toEqual([...pointerUrls("stable"), ...releaseUrls(STABLE_TAG)]);
  });

  it("accepts a pointer whose builtAt is the same instant written differently", async () => {
    publish({
      channel: "stage",
      tag: STAGE_TAG,
      release: builtRelease("release.channel-stage.json"),
      pointer: { builtAt: "2026-05-28T03:00:00.000Z" },
    });

    const res = await checkForUpdate(pointerOpts(prismaOnChannel("stage"), createLoggerSpy()));

    expect(res.outcome).toBe("pending_created");
  });

  it("re-polling the same pointer is a no-op, and a newer release supersedes the pending one", async () => {
    publish({ channel: "stage", tag: STAGE_TAG, release: builtRelease("release.channel-stage.json") });
    const prisma = prismaOnChannel("stage");
    const logger = createLoggerSpy();
    await checkForUpdate(pointerOpts(prisma, logger));

    expect((await checkForUpdate(pointerOpts(prisma, logger))).outcome).toBe("already_known");
    expect(prisma.deviceUpdate._rows()).toHaveLength(1);

    publish({
      channel: "stage",
      tag: "ota-stage-405-gabcdef0",
      release: builtRelease("release.channel-stage.json", {
        gitSha: "d".repeat(40),
        builtAt: "2026-05-29T03:00:00Z",
      }),
    });
    const res = await checkForUpdate(pointerOpts(prisma, logger));

    expect(res).toMatchObject({ outcome: "pending_created", supersededCount: 1 });
    expect(Object.fromEntries(prisma.deviceUpdate._rows().map((r) => [r.releaseTag, r.status]))).toEqual({
      [STAGE_TAG]: "superseded",
      "ota-stage-405-gabcdef0": "pending",
    });
  });

  it("refuses a pointer signed by another key: no row, and the release it names is never fetched", async () => {
    publish({
      channel: "stage",
      tag: STAGE_TAG,
      release: builtRelease("release.channel-stage.json"),
      pointerKey: otherKey,
    });
    const prisma = prismaOnChannel("stage");
    const logger = createLoggerSpy();

    const res = await checkForUpdate(pointerOpts(prisma, logger));

    expect(res).toMatchObject({ outcome: "verify_failed", failureReason: "signature_failed" });
    expect(prisma.deviceUpdate._rows()).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "update.signature_failed", document: "channel_pointer" }),
      expect.any(String),
    );
    expect(requested).toEqual(pointerUrls("stage"));
  });

  it("refuses a pointer edited after it was signed (pointing a box at another tag)", async () => {
    publish({ channel: "stage", tag: STAGE_TAG, release: builtRelease("release.channel-stage.json") });
    const url = "/dl/ota-index/channel-stage.json";
    downloads.set(url, Buffer.from(downloads.get(url)!.toString("utf8").replace(STAGE_TAG, "ota-stage-405-gabcdef0")));
    const prisma = prismaOnChannel("stage");

    const res = await checkForUpdate(pointerOpts(prisma, createLoggerSpy()));

    expect(res).toMatchObject({ outcome: "verify_failed", failureReason: "signature_failed" });
    expect(prisma.deviceUpdate._rows()).toHaveLength(0);
    expect(requested).toEqual(pointerUrls("stage"));
  });

  it("a good pointer does not vouch for a release.json signed by another key", async () => {
    publish({
      channel: "stage",
      tag: STAGE_TAG,
      release: builtRelease("release.channel-stage.json"),
      manifestKey: otherKey,
    });
    const prisma = prismaOnChannel("stage");
    const logger = createLoggerSpy();

    const res = await checkForUpdate(pointerOpts(prisma, logger));

    expect(res).toMatchObject({ outcome: "verify_failed", failureReason: "signature_failed" });
    expect(prisma.deviceUpdate._rows()).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "update.signature_failed",
        document: "release_manifest",
        releaseTag: STAGE_TAG,
      }),
      expect.any(String),
    );
  });

  it("refuses a signed pointer for another channel as channel_mismatch, without fetching its release", async () => {
    // Published as the STABLE pointer file, but it says (and tags) stage.
    publish({
      channel: "stable",
      tag: STAGE_TAG,
      release: builtRelease("release.channel-stage.json"),
      pointer: { channel: "stage" },
    });
    const prisma = prismaOnChannel("stable");
    const logger = createLoggerSpy();

    const res = await checkForUpdate(pointerOpts(prisma, logger));

    expect(res).toEqual({ outcome: "channel_mismatch", releaseChannel: "stage", deviceChannel: "stable" });
    expect(prisma.deviceUpdate._rows()).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "update.channel_mismatch", releaseChannel: "stage" }),
      expect.any(String),
    );
    expect(requested).toEqual(pointerUrls("stable"));
  });

  it("the channel inside the SIGNED manifest still gates, behind a pointer for this channel", async () => {
    publish({ channel: "stage", tag: STAGE_TAG, release: builtRelease("release.channel-beta.json") });
    const prisma = prismaOnChannel("stage");

    const res = await checkForUpdate(pointerOpts(prisma, createLoggerSpy()));

    expect(res).toMatchObject({ outcome: "channel_mismatch", releaseChannel: "beta", deviceChannel: "stage" });
    expect(prisma.deviceUpdate._rows()).toHaveLength(0);
  });

  it.each([
    ["manifestSha256", { manifestSha256: "0".repeat(64) }],
    ["gitSha", { gitSha: "d".repeat(40) }],
    ["builtAt", { builtAt: "2026-05-29T03:00:00Z" }],
  ])("refuses a pointer whose %s disagrees with the signed manifest it names", async (_field, pointer) => {
    publish({ channel: "stage", tag: STAGE_TAG, release: builtRelease("release.channel-stage.json"), pointer });
    const prisma = prismaOnChannel("stage");
    const logger = createLoggerSpy();

    const res = await checkForUpdate(pointerOpts(prisma, logger));

    expect(res).toMatchObject({ outcome: "verify_failed", failureReason: "pointer_mismatch" });
    expect(prisma.deviceUpdate._rows()).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "update.verify_failed", failureReason: "pointer_mismatch" }),
      expect.any(String),
    );
  });

  it("a replayed old release.json under a fresh pointer is refused (sha256 binding)", async () => {
    // The pointer is current, the manifest is a genuine, validly signed OLD one.
    const current = builtRelease("release.channel-stage.json", { builtAt: "2026-06-01T03:00:00Z" });
    const old = builtRelease("release.channel-stage.json");
    publish({ channel: "stage", tag: STAGE_TAG, release: current });
    downloads.set(`/dl/${STAGE_TAG}/release.json`, old.bytes);
    downloads.set(`/dl/${STAGE_TAG}/release.json.sig`, signWith(signingKey, old.bytes));
    const prisma = prismaOnChannel("stage");

    const res = await checkForUpdate(pointerOpts(prisma, createLoggerSpy()));

    expect(res).toMatchObject({ outcome: "verify_failed", failureReason: "pointer_mismatch" });
    expect(prisma.deviceUpdate._rows()).toHaveLength(0);
  });
});

describe("checkForUpdate — pointer 404 falls back, everything else does not (WARP-3430)", () => {
  it("a stable box with no pointer published uses `latest`, exactly as before", async () => {
    served = {
      tagName: "ota-1-gvalid",
      manifest: fx("release.valid.json"),
      signature: fx("release.valid.json.sig"),
    };
    const prisma = createPrismaStub();
    const logger = createLoggerSpy();

    const res = await checkForUpdate(opts(prisma, logger));

    expect(res.outcome).toBe("pending_created");
    expect(prisma.deviceUpdate._rows()[0]).toMatchObject({ channel: "stable", releaseTag: "ota-1-gvalid" });
    // The 404 on the pointer came first; then the legacy API path ran.
    expect(requested[0]).toBe("/dl/ota-index/channel-stable.json");
    expect(requested).toContain("/releases/latest");
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ event: "update.pointer_unavailable", channel: "stable" }),
      expect.any(String),
    );
  });

  it("a stage box with no pointer published uses the releases list, exactly as before", async () => {
    servedList = [
      {
        tagName: "ota-stage-8-gstage",
        manifest: fx("release.channel-stage.json"),
        signature: fx("release.channel-stage.json.sig"),
      },
    ];
    const prisma = prismaOnChannel("stage");

    const res = await checkForUpdate(opts(prisma, createLoggerSpy()));

    expect(res.outcome).toBe("pending_created");
    expect(prisma.deviceUpdate._rows()[0]).toMatchObject({ channel: "stage", releaseTag: "ota-stage-8-gstage" });
    expect(requested[0]).toBe("/dl/ota-index/channel-stage.json");
    expect(requested.some((u) => u.startsWith("/releases?"))).toBe(true);
  });

  it("a 404 on the pointer and on the API is still a quiet no_release", async () => {
    const res = await checkForUpdate(opts(createPrismaStub(), createLoggerSpy()));
    expect(res.outcome).toBe("no_release");
  });

  it.each([
    ["the pointer answers HTTP 500", () => forcedStatus.set("/dl/ota-index/channel-stable.json", 500)],
    [
      "the pointer's signature is missing (a half-published index)",
      () => downloads.delete("/dl/ota-index/channel-stable.json.sig"),
    ],
    ["the release.json it names is missing", () => downloads.delete(`/dl/${STABLE_TAG}/release.json`)],
    ["the release.json.sig it names is missing", () => downloads.delete(`/dl/${STABLE_TAG}/release.json.sig`)],
  ])("is fetch_failed — never a quiet downgrade to the API — when %s", async (_l, breakIt) => {
    publish({ channel: "stable", tag: STABLE_TAG, release: builtRelease("release.valid.json") });
    breakIt();
    // The API would happily answer; reaching for it would hide a broken publish.
    served = {
      tagName: "ota-1-gvalid",
      manifest: fx("release.valid.json"),
      signature: fx("release.valid.json.sig"),
    };
    const prisma = createPrismaStub();
    const logger = createLoggerSpy();

    const res = await checkForUpdate(pointerOpts(prisma, logger));

    expect(res.outcome).toBe("fetch_failed");
    expect(prisma.deviceUpdate._rows()).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "update.check_failed" }),
      expect.any(String),
    );
    expect(requested.some((u) => u.startsWith("/releases"))).toBe(false);
  });

  it("an unreachable download base is fetch_failed too", async () => {
    const prisma = createPrismaStub();
    const logger = createLoggerSpy();

    const res = await checkForUpdate({ ...opts(prisma, logger), downloadBase: "http://127.0.0.1:1/dl" });

    expect(res.outcome).toBe("fetch_failed");
    expect(prisma.deviceUpdate._rows()).toHaveLength(0);
  });
});

describe("a pointer is never a manifest, and a manifest is never a pointer (WARP-3430)", () => {
  it("a signed release.json served AS the pointer is refused as pointer_invalid", async () => {
    // Same key, same raw-bytes signature scheme: only the document's shape can refuse it.
    const stage = builtRelease("release.channel-stage.json");
    downloads.set("/dl/ota-index/channel-stage.json", stage.bytes);
    downloads.set("/dl/ota-index/channel-stage.json.sig", signWith(signingKey, stage.bytes));
    const prisma = prismaOnChannel("stage");
    const logger = createLoggerSpy();

    const res = await checkForUpdate(pointerOpts(prisma, logger));

    expect(res).toMatchObject({ outcome: "verify_failed", failureReason: "pointer_invalid" });
    expect(prisma.deviceUpdate._rows()).toHaveLength(0);
    expect(requested).toEqual(pointerUrls("stage"));
  });

  it("a signed pointer served AS release.json is refused as a manifest", async () => {
    const stage = builtRelease("release.channel-stage.json");
    // A second valid pointer document stands in for the manifest the first one
    // names; the pointer's sha256/gitSha/builtAt binding is made to agree with
    // it, so only the manifest schema is left to refuse it.
    const decoy = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        kind: CHANNEL_POINTER_KIND,
        channel: "stage",
        tag: "ota-stage-403-gabcdef0",
        gitSha: stage.gitSha,
        builtAt: stage.builtAt,
        manifestSha256: "e".repeat(64),
        publishedAt: "2026-05-28T04:00:00Z",
      }),
    );
    publish({
      channel: "stage",
      tag: STAGE_TAG,
      release: { bytes: decoy, gitSha: stage.gitSha, builtAt: stage.builtAt },
    });
    const prisma = prismaOnChannel("stage");

    const res = await checkForUpdate(pointerOpts(prisma, createLoggerSpy()));

    expect(res).toMatchObject({ outcome: "verify_failed", failureReason: "schema_invalid" });
    expect((res as { detail: string }).detail).toContain("is not a release");
    expect(prisma.deviceUpdate._rows()).toHaveLength(0);
  });
});

describe("checkForUpdate — never go backwards (WARP-3430)", () => {
  const CANDIDATE = "2026-05-28T03:00:00Z"; // release.channel-stage.json's builtAt
  const INSTALLED_SHA = "b".repeat(40);

  async function pollStage(
    committed: { status: string; gitSha?: string; builtAt: string } | null,
    logger = createLoggerSpy(),
  ) {
    publish({ channel: "stage", tag: STAGE_TAG, release: builtRelease("release.channel-stage.json") });
    const prisma = prismaOnChannel("stage");
    if (committed) await seedRow(prisma, { gitSha: INSTALLED_SHA, ...committed });
    return { res: await checkForUpdate(pointerOpts(prisma, logger)), prisma, logger };
  }

  it("refuses a release built before the installed one, and writes no row", async () => {
    const { res, prisma, logger } = await pollStage({ status: "committed", builtAt: "2026-05-29T03:00:00Z" });

    expect(res).toEqual({
      outcome: "not_newer",
      gitSha: "c".repeat(40),
      builtAt: "2026-05-28T03:00:00.000Z",
      installedBuiltAt: "2026-05-29T03:00:00.000Z",
    });
    expect(prisma.deviceUpdate._rows().map((r) => r.status)).toEqual(["committed"]);
    // Debug, not warn: in steady state it repeats on every poll tick.
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "update.not_newer",
        gitSha: "c".repeat(40),
        installedGitSha: INSTALLED_SHA,
        releaseTag: STAGE_TAG,
      }),
      expect.any(String),
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("refuses a different commit built at the very same instant (equal is not newer)", async () => {
    const { res, prisma } = await pollStage({ status: "committed", builtAt: CANDIDATE });

    expect(res.outcome).toBe("not_newer");
    expect(prisma.deviceUpdate._rows()).toHaveLength(1);
  });

  it("accepts a release strictly newer than the installed one", async () => {
    const { res, prisma } = await pollStage({ status: "committed", builtAt: "2026-05-27T03:00:00Z" });

    expect(res.outcome).toBe("pending_created");
    expect(prisma.deviceUpdate._rows().map((r) => r.status)).toEqual(["committed", "pending"]);
  });

  it("a box with no committed row (a locally built one) has no floor", async () => {
    const { res } = await pollStage(null);
    expect(res.outcome).toBe("pending_created");
  });

  it.each(["rolled_back", "failed", "rejected", "superseded", "pending", "verifying", "applying"])(
    "only a COMMITTED row sets the floor — a newer %s row does not",
    async (status) => {
      const { res } = await pollStage({ status, builtAt: "2026-06-30T03:00:00Z" });
      expect(res.outcome).toBe("pending_created");
    },
  );

  it("the release that IS installed stays already_known, not not_newer", async () => {
    const { res } = await pollStage({ status: "committed", gitSha: "c".repeat(40), builtAt: CANDIDATE });
    expect(res).toEqual({ outcome: "already_known", gitSha: "c".repeat(40) });
  });

  it("applies on the GitHub API fallback path too", async () => {
    served = {
      tagName: "ota-1-gvalid",
      manifest: fx("release.valid.json"), // built 2026-05-28
      signature: fx("release.valid.json.sig"),
    };
    const prisma = createPrismaStub();
    await seedRow(prisma, { status: "committed", gitSha: INSTALLED_SHA, builtAt: "2026-06-01T03:00:00Z" });

    const res = await checkForUpdate(opts(prisma, createLoggerSpy()));

    expect(res).toMatchObject({ outcome: "not_newer", installedBuiltAt: "2026-06-01T03:00:00.000Z" });
    expect(prisma.deviceUpdate._rows()).toHaveLength(1);
  });
});

// A `verifying` row is one an apply started and parked on a transient failure
// (a registry that refused auth makes that routine). Every apply path picks the
// newest pending|verifying row, so a parked row left older than a newer release
// would be applied AFTER it: a downgrade. Creating the newer row retires them.
describe("a newer release retires parked rows (WARP-3430)", () => {
  async function pollOver(
    rows: Array<{ status: string; gitSha: string; builtAt: string; applyClaim?: string }>,
  ) {
    publish({ channel: "stage", tag: STAGE_TAG, release: builtRelease("release.channel-stage.json") });
    const prisma = prismaOnChannel("stage");
    for (const row of rows) await seedRow(prisma, row);
    const res = await checkForUpdate(pointerOpts(prisma, createLoggerSpy()));
    /** status by the first letter of each row's gitSha (a/b/d/e seeded; c is the new row) */
    const byRow = Object.fromEntries(prisma.deviceUpdate._rows().map((r) => [r.gitSha[0], r.status]));
    return { res, byRow };
  }

  it("supersedes an unclaimed verifying row older than the new release, like a pending one", async () => {
    const { res, byRow } = await pollOver([
      { status: "verifying", gitSha: "a".repeat(40), builtAt: "2026-05-20T03:00:00Z" },
      { status: "pending", gitSha: "b".repeat(40), builtAt: "2026-05-21T03:00:00Z" },
    ]);

    expect(res).toMatchObject({ outcome: "pending_created", supersededCount: 2 });
    expect(byRow).toEqual({ a: "superseded", b: "superseded", c: "pending" });
  });

  it("leaves a CLAIMED verifying row (mid-apply), an applying row and a committed row alone", async () => {
    const { res, byRow } = await pollOver([
      { status: "verifying", gitSha: "a".repeat(40), builtAt: "2026-05-20T03:00:00Z", applyClaim: "claimed" },
      { status: "applying", gitSha: "b".repeat(40), builtAt: "2026-05-21T03:00:00Z" },
      { status: "committed", gitSha: "d".repeat(40), builtAt: "2026-05-10T03:00:00Z" },
      { status: "rolled_back", gitSha: "e".repeat(40), builtAt: "2026-05-11T03:00:00Z" },
    ]);

    expect(res).toMatchObject({ outcome: "pending_created", supersededCount: 0 });
    expect(byRow).toEqual({
      a: "verifying",
      b: "applying",
      d: "committed",
      e: "rolled_back",
      c: "pending",
    });
  });

  it("retires nothing when the poll refuses the release (not_newer writes no row, changes no row)", async () => {
    const { res, byRow } = await pollOver([
      { status: "committed", gitSha: "d".repeat(40), builtAt: "2026-06-01T03:00:00Z" },
      { status: "verifying", gitSha: "a".repeat(40), builtAt: "2026-05-20T03:00:00Z" },
    ]);

    expect(res.outcome).toBe("not_newer");
    expect(byRow).toEqual({ d: "committed", a: "verifying" });
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

describe("onUpdateCheck (WARP-3504)", () => {
  it("reports every check outcome, the 15-minute poll and check-now alike", async () => {
    const seen: string[] = [];
    const off = onUpdateCheck((r) => seen.push(r.outcome));

    served = null;
    await checkForUpdate(opts(createPrismaStub(), createLoggerSpy()));
    served = {
      tagName: "ota-1-gvalid",
      manifest: fx("release.valid.json"),
      signature: fx("release.valid.json.sig"),
    };
    await checkForUpdate(opts(createPrismaStub(), createLoggerSpy()));
    off();
    await checkForUpdate(opts(createPrismaStub(), createLoggerSpy()));

    expect(seen).toEqual(["no_release", "pending_created"]);
  });

  it("an observer that throws cannot change the outcome", async () => {
    served = null;
    const off = onUpdateCheck(() => {
      throw new Error("consumer bug");
    });
    const res = await checkForUpdate(opts(createPrismaStub(), createLoggerSpy()));
    off();
    expect(res.outcome).toBe("no_release");
  });
});
