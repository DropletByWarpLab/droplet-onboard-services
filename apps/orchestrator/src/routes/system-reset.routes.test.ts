/**
 * WARP-825 — POST /api/system/reset + GET /api/system/reset (status).
 *
 * SAFETY: the device-bridge fetch is stubbed in every test, so the real
 * scripts/factory-reset.sh is never invoked and no box is wiped.
 *
 * Covers:
 *   - the friction token is verified SERVER-side: a wrong typed value → 400
 *     CONFIRM_MISMATCH and the bridge is never called.
 *   - a correct typed value → 202 + a `dispatched` job; the bridge POST fires
 *     with the X-Droplet-Auth header.
 *   - double-fire: a second confirmed reset while one is in flight → 409.
 *   - GET /api/system/reset exposes the canonical target name (so the UI shows
 *     exactly what to type) + the latest job status.
 *
 * The owner-only RBAC guard itself is asserted declaratively in
 * __tests__/rbac.test.ts (MATRIX). Here every request is an owner session so we
 * exercise the route logic, not the auth gate.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("../config.js", () => ({
  config: { DEVICE_BRIDGE_URL: "http://bridge.test:9090", agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));

import { createSystemResetRouter } from "./system-reset.routes.js";

const ORIGINAL_ENV = { ...process.env };

// WARP-992: the confirm target is the CANONICAL box name (lib/box-identity.ts
// — the same value the Settings → Device information row displays), never
// os.hostname() (the docker container id in production). Pin the owner name
// via env so the tests exercise the exact string the owner would read + type.
const CANONICAL_NAME = "aurora-loft";

function createPrismaMock() {
  const jobs: any[] = [];
  const audits: any[] = [];
  let seq = 0;
  const prisma: any = {
    jobs,
    audits,
    // reset.service wraps the double-fire guard + audit + job create in
    // prisma.$transaction(fn, { isolationLevel: Serializable }) (pr-reviewer
    // #549 finding 1). Run the callback against this same mock; atomicity
    // itself isn't under test at the route level.
    $transaction: vi.fn(async (fn: (tx: any) => Promise<any>) => fn(prisma)),
    resetJob: {
      create: vi.fn(async ({ data }: any) => {
        const job = {
          id: `job-${++seq}`,
          status: data.status ?? "requested",
          requestedBy: data.requestedBy ?? null,
          targetName: data.targetName,
          failureReason: data.failureReason ?? null,
          createdAt: new Date(seq * 1000),
          updatedAt: new Date(seq * 1000),
        };
        jobs.push(job);
        return job;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const job = jobs.find((j) => j.id === where.id);
        Object.assign(job, data, { updatedAt: new Date() });
        return job;
      }),
      findFirst: vi.fn(async ({ where }: any = {}) => {
        let rows = [...jobs];
        if (where?.status?.in) rows = rows.filter((j) => where.status.in.includes(j.status));
        rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return rows[0] ?? null;
      }),
      count: vi.fn(async ({ where }: any = {}) => {
        if (where?.status?.in) return jobs.filter((j) => where.status.in.includes(j.status)).length;
        return jobs.length;
      }),
    },
    commandAuditLog: {
      create: vi.fn(async ({ data }: any) => {
        audits.push(data);
        return { id: `audit-${audits.length}`, ...data };
      }),
    },
  };
  return prisma;
}

function ownerAuth(req: any, _res: any, next: any) {
  req.user = { id: "owner-1", role: "owner" };
  next();
}

function makeApp(prisma: any) {
  const app = express();
  app.use(express.json());
  app.use(ownerAuth);
  app.use("/api", createSystemResetRouter(prisma));
  return app;
}

function bridgeOk() {
  return vi.fn(
    async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
  );
}

beforeEach(() => {
  process.env.BRIDGE_AUTH_TOKEN = "tok-123";
  process.env.DROPLET_BOX_NAME = CANONICAL_NAME;
  delete process.env.SERVICE_TOKEN_DISPLAY;
  vi.restoreAllMocks();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("GET /api/system/reset", () => {
  it("exposes only a MASKED target hint and a null status on a fresh box", async () => {
    const prisma = createPrismaMock();
    const res = await request(makeApp(prisma)).get("/api/system/reset");
    expect(res.status).toBe(200);
    // First + last char + bullets — never the verbatim box name (the modal
    // must not be able to display the exact copy/paste-able confirm value).
    expect(res.body.targetHint).toMatch(/^.•+.$|^••$/);
    expect(res.body.targetHint).not.toBe(CANONICAL_NAME);
    expect(JSON.stringify(res.body)).not.toContain(CANONICAL_NAME);
    expect(res.body.job).toBeNull();
  });

  it("masks the job's targetName in the status poll too", async () => {
    const prisma = createPrismaMock();
    vi.stubGlobal("fetch", bridgeOk());
    const post = await request(makeApp(prisma))
      .post("/api/system/reset")
      .send({ confirm: CANONICAL_NAME });
    expect(post.status).toBe(202);

    const res = await request(makeApp(prisma)).get("/api/system/reset");
    expect(res.status).toBe(200);
    expect(res.body.job).not.toBeNull();
    expect(JSON.stringify(res.body)).not.toContain(CANONICAL_NAME);
  });
});

describe("POST /api/system/reset — server-side friction", () => {
  it("400 CONFIRM_MISMATCH and never calls the bridge when the typed name is wrong", async () => {
    const prisma = createPrismaMock();
    const fetchSpy = bridgeOk();
    vi.stubGlobal("fetch", fetchSpy);

    const res = await request(makeApp(prisma))
      .post("/api/system/reset")
      .send({ confirm: "definitely-not-the-hostname" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("CONFIRM_MISMATCH");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(prisma.jobs).toHaveLength(0);
  });

  it("400 when confirm is missing entirely", async () => {
    const prisma = createPrismaMock();
    vi.stubGlobal("fetch", bridgeOk());
    const res = await request(makeApp(prisma)).post("/api/system/reset").send({});
    expect(res.status).toBe(400);
  });
});

describe("POST /api/system/reset — happy path", () => {
  it("202 + dispatched job when the typed name matches the canonical hostname", async () => {
    const prisma = createPrismaMock();
    const fetchSpy = bridgeOk();
    vi.stubGlobal("fetch", fetchSpy);

    const res = await request(makeApp(prisma))
      .post("/api/system/reset")
      .send({ confirm: CANONICAL_NAME });

    expect(res.status).toBe(202);
    expect(res.body.status).toBe("dispatched");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe("http://bridge.test:9090/system/factory-reset");
    expect((init?.headers as any)["X-Droplet-Auth"]).toBe("tok-123");
    expect(prisma.audits).toHaveLength(1);
  });
});

describe("POST /api/system/reset — double-fire", () => {
  it("409 RESET_ALREADY_IN_PROGRESS on a second confirmed reset", async () => {
    const prisma = createPrismaMock();
    vi.stubGlobal("fetch", bridgeOk());

    const first = await request(makeApp(prisma))
      .post("/api/system/reset")
      .send({ confirm: CANONICAL_NAME });
    expect(first.status).toBe(202);

    const second = await request(makeApp(prisma))
      .post("/api/system/reset")
      .send({ confirm: CANONICAL_NAME });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("RESET_ALREADY_IN_PROGRESS");
  });
});

describe("POST /api/system/reset — bridge token unconfigured", () => {
  it("503 when no device-bridge auth token is set (fail closed)", async () => {
    delete process.env.BRIDGE_AUTH_TOKEN;
    delete process.env.SERVICE_TOKEN_DISPLAY;
    const prisma = createPrismaMock();
    const fetchSpy = bridgeOk();
    vi.stubGlobal("fetch", fetchSpy);

    const res = await request(makeApp(prisma))
      .post("/api/system/reset")
      .send({ confirm: CANONICAL_NAME });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe("BRIDGE_AUTH_UNCONFIGURED");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
