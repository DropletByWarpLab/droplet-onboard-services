/**
 * WARP-457 — /api/settings HTTP surface.
 *
 * Drives the router built by createSettingsRouter() through supertest,
 * with a synthetic auth middleware that stuffs req.user directly. Same
 * pattern as people.routes.test.ts (WARP-455).
 *
 * Covered here:
 *   - GET    /api/settings                  — owner+admin+family read.
 *                                              Returns the tree grouped
 *                                              by section. Guest → 403.
 *   - GET    /api/settings/:section         — same access. 404 for an
 *                                              unknown section name.
 *   - PATCH  /api/settings/:section         — owner+admin only; emits
 *                                              one ActivityRow per
 *                                              changed key (kind:
 *                                              system, severity: info).
 *                                              Per-type validation.
 *
 * The recordActivity import is mocked so the emitter shape (kind,
 * severity, what, refs) can be asserted without standing up the audit
 * recorder.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { Request, Response, NextFunction } from "express";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: false },
}));

vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
}));

// Hoisted so the mock factory can see it.
const { recordActivityMock } = vi.hoisted(() => ({
  recordActivityMock: vi.fn().mockResolvedValue(null),
}));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: recordActivityMock,
}));

import { createSettingsRouter } from "../routes/settings.js";

interface MockSettingRow {
  id: string;
  key: string;
  section: string;
  type: string;
  valueJson: unknown;
  createdAt: Date;
  updatedAt: Date;
}

function seedRow(over: Partial<MockSettingRow> = {}): MockSettingRow {
  return {
    id: over.id ?? `s-${over.key ?? "row"}`,
    key: over.key ?? "workspace.name",
    section: over.section ?? "workspace",
    type: over.type ?? "string",
    valueJson: over.valueJson ?? "Droplet Home",
    createdAt: over.createdAt ?? new Date("2026-05-25T10:00:00Z"),
    updatedAt: over.updatedAt ?? new Date("2026-05-25T10:00:00Z"),
  };
}

function createPrismaMock(initial: MockSettingRow[] = []) {
  const rows = new Map<string, MockSettingRow>(
    initial.map((r) => [r.key, r]),
  );
  const mock: any = {
    rows,
    workspaceSetting: {
      findMany: vi.fn(
        async ({
          where,
          orderBy,
        }: { where?: { section?: string }; orderBy?: any } = {}) => {
          let result = [...rows.values()];
          if (where?.section) {
            result = result.filter((r) => r.section === where.section);
          }
          // Ignore orderBy in the mock — caller asserts on keys, not order.
          void orderBy;
          return result;
        },
      ),
      findUnique: vi.fn(
        async ({ where }: { where: { key: string } }) =>
          rows.get(where.key) ?? null,
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { key: string };
          data: { valueJson: unknown };
        }) => {
          const existing = rows.get(where.key);
          if (!existing) {
            const err: any = new Error("not found");
            err.code = "P2025";
            throw err;
          }
          const merged = {
            ...existing,
            valueJson: data.valueJson,
            updatedAt: new Date(),
          };
          rows.set(where.key, merged);
          return merged;
        },
      ),
    },
  };
  // WARP-483: PATCH applies its per-key writes inside one interactive
  // $transaction. The mock runs the callback against the same client so
  // `tx.workspaceSetting.update` is the very spy tests assert on, and
  // snapshots/restores the row set on throw to emulate a real rollback —
  // so "no partial write survives a mid-batch failure" is assertable.
  mock.$transaction = vi.fn(async (fn: (tx: any) => Promise<unknown>) => {
    const snapshot = new Map(rows);
    try {
      return await fn(mock);
    } catch (err) {
      rows.clear();
      for (const [k, v] of snapshot) rows.set(k, v);
      throw err;
    }
  });
  return mock;
}

function buildApp(
  prismaMock: any,
  user: { id: string; username: string; role: string } = {
    id: "owner-id",
    username: "stefan",
    role: "owner",
  },
) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).user = {
      ...user,
      displayName: user.username,
    };
    next();
  });
  app.use("/api", createSettingsRouter(prismaMock));
  return app;
}

const SEED_ROWS: MockSettingRow[] = [
  seedRow({ key: "workspace.name", section: "workspace", type: "string", valueJson: "Droplet Home" }),
  seedRow({ key: "workspace.locale", section: "workspace", type: "enum", valueJson: "en-US" }),
  seedRow({ key: "memory_privacy.brain_enabled", section: "memory_privacy", type: "bool", valueJson: true }),
  seedRow({ key: "memory_privacy.brain_retention_days", section: "memory_privacy", type: "number", valueJson: 365 }),
  seedRow({ key: "off_lan.peer_renewal_interval", section: "off_lan", type: "duration_seconds", valueJson: 2_592_000 }),
  seedRow({ key: "hardware.cameras_enabled", section: "hardware", type: "bool", valueJson: true }),
  seedRow({ key: "appearance.theme", section: "appearance", type: "enum", valueJson: "system" }),
];

beforeEach(() => {
  recordActivityMock.mockClear();
});

describe("GET /api/settings", () => {
  it("returns the full tree grouped by section for an owner", async () => {
    const prisma = createPrismaMock(SEED_ROWS);
    const app = buildApp(prisma);

    const res = await request(app).get("/api/settings");

    expect(res.status).toBe(200);
    // Tree shape: top-level keys are the SettingSection enum members.
    expect(res.body.settings).toBeDefined();
    expect(res.body.settings.workspace).toBeDefined();
    expect(res.body.settings.memory_privacy).toBeDefined();
    expect(res.body.settings.off_lan).toBeDefined();
    expect(res.body.settings.hardware).toBeDefined();
    expect(res.body.settings.appearance).toBeDefined();

    // Each section is an array of {key, type, value} entries.
    const workspace = res.body.settings.workspace;
    expect(Array.isArray(workspace)).toBe(true);
    const nameEntry = workspace.find((e: any) => e.key === "workspace.name");
    expect(nameEntry).toBeDefined();
    expect(nameEntry.type).toBe("string");
    expect(nameEntry.value).toBe("Droplet Home");
  });

  it("includes every SettingSection in the response, even empty ones", async () => {
    // Empty-section guarantee: the dashboard renders all five panes,
    // so the response shape must be stable even when a section has
    // zero seeded rows. Without this the UI would render undefined.
    const prisma = createPrismaMock([
      seedRow({ key: "workspace.name", section: "workspace" }),
    ]);
    const app = buildApp(prisma);

    const res = await request(app).get("/api/settings");

    expect(res.status).toBe(200);
    for (const section of [
      "workspace",
      "memory_privacy",
      "off_lan",
      "hardware",
      "appearance",
    ]) {
      expect(res.body.settings[section]).toBeDefined();
      expect(Array.isArray(res.body.settings[section])).toBe(true);
    }
  });

  it("returns 200 for admin and family roles", async () => {
    const prisma = createPrismaMock(SEED_ROWS);
    for (const role of ["admin", "family"]) {
      const app = buildApp(prisma, {
        id: `${role}-id`,
        username: role,
        role,
      });
      const res = await request(app).get("/api/settings");
      expect(res.status).toBe(200);
    }
  });

  it("returns 403 for guest", async () => {
    const prisma = createPrismaMock(SEED_ROWS);
    const app = buildApp(prisma, {
      id: "g1",
      username: "guest1",
      role: "guest",
    });
    const res = await request(app).get("/api/settings");
    expect(res.status).toBe(403);
  });
});

describe("GET /api/settings/:section", () => {
  it("returns one section for owner+admin+family", async () => {
    const prisma = createPrismaMock(SEED_ROWS);
    const app = buildApp(prisma);

    const res = await request(app).get("/api/settings/workspace");

    expect(res.status).toBe(200);
    expect(res.body.section).toBe("workspace");
    expect(Array.isArray(res.body.entries)).toBe(true);
    const keys = res.body.entries.map((e: any) => e.key);
    expect(keys).toContain("workspace.name");
    expect(keys).toContain("workspace.locale");
    // Cross-section rows must not bleed in.
    expect(keys).not.toContain("memory_privacy.brain_enabled");
  });

  it("rejects an unknown section name with 404", async () => {
    // The :section path-param is validated against the SettingSection
    // enum — an unknown section is a programmer-error, not a missing
    // resource (404 is still the closest semantic; 400 would be
    // defensible too but conflicts with the existing 404-for-bad-
    // path-param convention in routes/people.ts).
    const prisma = createPrismaMock(SEED_ROWS);
    const app = buildApp(prisma);

    const res = await request(app).get("/api/settings/atomic_secrets");
    expect(res.status).toBe(404);
  });

  it("returns 403 for guest", async () => {
    const prisma = createPrismaMock(SEED_ROWS);
    const app = buildApp(prisma, {
      id: "g1",
      username: "guest1",
      role: "guest",
    });
    const res = await request(app).get("/api/settings/workspace");
    expect(res.status).toBe(403);
  });
});

describe("PATCH /api/settings/:section — RBAC + activity emission", () => {
  it("owner can patch a key and emits one ActivityRow per changed key", async () => {
    const prisma = createPrismaMock(SEED_ROWS);
    const app = buildApp(prisma);

    const res = await request(app)
      .patch("/api/settings/workspace")
      .send({ "workspace.name": "Cruceru Household" });

    expect(res.status).toBe(200);
    expect(prisma.workspaceSetting.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { key: "workspace.name" },
        data: expect.objectContaining({ valueJson: "Cruceru Household" }),
      }),
    );
    expect(recordActivityMock).toHaveBeenCalledTimes(1);
    const recorded = recordActivityMock.mock.calls[0][0];
    expect(recorded.kind).toBe("system");
    expect(recorded.severity).toBe("info");
    expect(recorded.refs).toMatchObject({
      actor: "stefan",
      key: "workspace.name",
      section: "workspace",
    });
  });

  it("emits one ActivityRow per changed key when multiple keys land at once", async () => {
    const prisma = createPrismaMock(SEED_ROWS);
    const app = buildApp(prisma);

    const res = await request(app)
      .patch("/api/settings/workspace")
      .send({
        "workspace.name": "Cruceru Household",
        "workspace.locale": "fr-FR",
      });

    expect(res.status).toBe(200);
    expect(recordActivityMock).toHaveBeenCalledTimes(2);
    const keys = recordActivityMock.mock.calls.map(
      (c: any) => c[0].refs.key,
    );
    expect(keys).toEqual(
      expect.arrayContaining(["workspace.name", "workspace.locale"]),
    );
  });

  it("skips the update AND the audit row when the value is unchanged", async () => {
    // No-op short-circuit: same UX-loss-avoidance as PATCH /people/:id/role.
    // Avoids polluting the activity feed with no-change touches when the
    // dashboard re-submits the form on focus loss.
    const prisma = createPrismaMock(SEED_ROWS);
    const app = buildApp(prisma);

    const res = await request(app)
      .patch("/api/settings/workspace")
      .send({ "workspace.name": "Droplet Home" });

    expect(res.status).toBe(200);
    expect(prisma.workspaceSetting.update).not.toHaveBeenCalled();
    expect(recordActivityMock).not.toHaveBeenCalled();
  });

  it("family role is 403'd (owner+admin only)", async () => {
    const prisma = createPrismaMock(SEED_ROWS);
    const app = buildApp(prisma, {
      id: "fam-id",
      username: "fam",
      role: "family",
    });

    const res = await request(app)
      .patch("/api/settings/workspace")
      .send({ "workspace.name": "Hack" });

    expect(res.status).toBe(403);
    expect(prisma.workspaceSetting.update).not.toHaveBeenCalled();
    // WARP-237: no settings-change emit on a denied request, but
    // requireRole now emits a single "Access denied" policy-violation row.
    expect(recordActivityMock).toHaveBeenCalledTimes(1);
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "auth", what: "Access denied" }),
    );
  });

  it("rejects a PATCH against an unknown section with 404", async () => {
    const prisma = createPrismaMock(SEED_ROWS);
    const app = buildApp(prisma);
    const res = await request(app)
      .patch("/api/settings/atomic_secrets")
      .send({ foo: "bar" });
    expect(res.status).toBe(404);
  });

  it("rejects a PATCH that targets a key not in the section with 400", async () => {
    // The section path-param scopes the writable key-set. A key from a
    // different section is a client bug; 400 makes it visible instead
    // of silently writing to the wrong section's audit trail.
    const prisma = createPrismaMock(SEED_ROWS);
    const app = buildApp(prisma);

    const res = await request(app)
      .patch("/api/settings/workspace")
      .send({ "memory_privacy.brain_enabled": false });

    expect(res.status).toBe(400);
    expect(prisma.workspaceSetting.update).not.toHaveBeenCalled();
    expect(recordActivityMock).not.toHaveBeenCalled();
  });

  it("rejects a PATCH against an unknown key with 404", async () => {
    const prisma = createPrismaMock(SEED_ROWS);
    const app = buildApp(prisma);

    const res = await request(app)
      .patch("/api/settings/workspace")
      .send({ "workspace.nonexistent": "x" });

    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/settings/:section — transactional writes (WARP-483)", () => {
  it("applies a multi-key PATCH through a single interactive $transaction", async () => {
    const prisma = createPrismaMock(SEED_ROWS);
    const app = buildApp(prisma);

    const res = await request(app)
      .patch("/api/settings/workspace")
      .send({
        "workspace.name": "Cruceru Household",
        "workspace.locale": "fr-FR",
      });

    expect(res.status).toBe(200);
    // One transaction wraps the whole batch — not one per key, and not
    // a bare sequence of un-transacted updates.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.workspaceSetting.update).toHaveBeenCalledTimes(2);
  });

  it("does not open a transaction when nothing actually changes", async () => {
    // Pure no-op PATCH (value equals current). No write, so no tx.
    const prisma = createPrismaMock(SEED_ROWS);
    const app = buildApp(prisma);

    const res = await request(app)
      .patch("/api/settings/workspace")
      .send({ "workspace.name": "Droplet Home" });

    expect(res.status).toBe(200);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.workspaceSetting.update).not.toHaveBeenCalled();
  });

  it("rolls back the whole batch when one key fails — no partial write, no audit rows", async () => {
    const prisma = createPrismaMock(SEED_ROWS);
    // Fail the SECOND write in the batch. Pre-483 the first key's row
    // would already be committed AND its ActivityRow emitted before
    // this throw ever fired, leaving the section half-updated.
    let writes = 0;
    prisma.workspaceSetting.update.mockImplementation(
      async ({ where, data }: { where: { key: string }; data: { valueJson: unknown } }) => {
        writes += 1;
        if (writes === 2) throw new Error("db connection dropped mid-batch");
        const existing = prisma.rows.get(where.key);
        const merged = { ...existing, valueJson: data.valueJson };
        prisma.rows.set(where.key, merged);
        return merged;
      },
    );
    const app = buildApp(prisma);

    const res = await request(app)
      .patch("/api/settings/workspace")
      .send({
        "workspace.name": "Cruceru Household",
        "workspace.locale": "fr-FR",
      });

    expect(res.status).toBe(500);
    // Rollback restored the pre-transaction values — the first write
    // must NOT have survived the failure of the second.
    expect(prisma.rows.get("workspace.name")!.valueJson).toBe("Droplet Home");
    expect(prisma.rows.get("workspace.locale")!.valueJson).toBe("en-US");
    // Audit rows are emitted only after the commit — a rolled-back
    // batch emits none (no phantom "Setting updated" for a lost write).
    expect(recordActivityMock).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/settings/:section — per-type validation", () => {
  it("string: accepts a string, rejects a number", async () => {
    const prisma = createPrismaMock(SEED_ROWS);
    const app = buildApp(prisma);

    const ok = await request(app)
      .patch("/api/settings/workspace")
      .send({ "workspace.name": "Casa" });
    expect(ok.status).toBe(200);

    const bad = await request(app)
      .patch("/api/settings/workspace")
      .send({ "workspace.name": 42 });
    expect(bad.status).toBe(400);
  });

  it("bool: accepts true/false, rejects a string", async () => {
    const prisma = createPrismaMock(SEED_ROWS);
    const app = buildApp(prisma);

    const ok = await request(app)
      .patch("/api/settings/memory_privacy")
      .send({ "memory_privacy.brain_enabled": false });
    expect(ok.status).toBe(200);

    const bad = await request(app)
      .patch("/api/settings/memory_privacy")
      .send({ "memory_privacy.brain_enabled": "yes" });
    expect(bad.status).toBe(400);
  });

  it("number: accepts a finite number, rejects NaN / string", async () => {
    const prisma = createPrismaMock(SEED_ROWS);
    const app = buildApp(prisma);

    const ok = await request(app)
      .patch("/api/settings/memory_privacy")
      .send({ "memory_privacy.brain_retention_days": 90 });
    expect(ok.status).toBe(200);

    const bad = await request(app)
      .patch("/api/settings/memory_privacy")
      .send({ "memory_privacy.brain_retention_days": "ninety" });
    expect(bad.status).toBe(400);
  });

  it("duration_seconds: accepts non-negative integer, rejects negative + non-integer", async () => {
    const prisma = createPrismaMock(SEED_ROWS);
    const app = buildApp(prisma);

    const ok = await request(app)
      .patch("/api/settings/off_lan")
      .send({ "off_lan.peer_renewal_interval": 86400 });
    expect(ok.status).toBe(200);

    const neg = await request(app)
      .patch("/api/settings/off_lan")
      .send({ "off_lan.peer_renewal_interval": -1 });
    expect(neg.status).toBe(400);

    const frac = await request(app)
      .patch("/api/settings/off_lan")
      .send({ "off_lan.peer_renewal_interval": 3.14 });
    expect(frac.status).toBe(400);
  });

  it("enum: accepts an allowed member, rejects an unknown one", async () => {
    // The allowed-set for an enum-typed setting lives in the route's
    // ALLOWED_ENUM_VALUES map (not in the schema, so per-key vocab
    // changes don't need a migration). `appearance.theme` allows
    // light / dark / system.
    const prisma = createPrismaMock(SEED_ROWS);
    const app = buildApp(prisma);

    const ok = await request(app)
      .patch("/api/settings/appearance")
      .send({ "appearance.theme": "dark" });
    expect(ok.status).toBe(200);

    const bad = await request(app)
      .patch("/api/settings/appearance")
      .send({ "appearance.theme": "neon" });
    expect(bad.status).toBe(400);
  });

  it("rejects an empty PATCH body with 400 (force at least one key)", async () => {
    // PATCH semantics: explicit set of keys. An empty body is almost
    // certainly a UX bug (the dashboard submitted no diff); 400 makes
    // it visible rather than silently no-op.
    const prisma = createPrismaMock(SEED_ROWS);
    const app = buildApp(prisma);

    const res = await request(app).patch("/api/settings/workspace").send({});
    expect(res.status).toBe(400);
  });
});
