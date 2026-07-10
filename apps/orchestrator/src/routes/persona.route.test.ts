/**
 * WARP-1118 — route tests for the personality API (§12).
 *
 *   GET   /api/persona   role-split read: owner/admin get ALL fields (incl.
 *                        customInstructions); family/guest/service get
 *                        preset + verbosity ONLY.
 *   PATCH /api/persona   owner/admin only, zod-validated (incl. 1200-char
 *                        customInstructions cap), audited.
 *
 * The audit assertion is the load-bearing one: because `recordSafely()`
 * swallows unknown-kind throws (§3/§5-13), a test that only checks "no
 * exception" or "the mock was called" would pass even if zero rows landed.
 * So we wire a REAL recorder (createActivityRecorder) over a fake prisma
 * that actually stores ActivityRow rows, and assert on the PERSISTED row —
 * kind `system`, what `persona_update`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";
import { createPersonaRouter } from "./persona.js";
import {
  composePersonaBlock,
  PERSONA_BLOCK_PREFIX,
  type PersonaRow as ServicePersonaRow,
} from "../services/persona.service.js";
import { _setActivityRecorderForTests } from "../services/activity.singleton.js";
import { createActivityRecorder } from "../services/activity.service.js";
import { createHmacSigner } from "../services/audit-signing.service.js";

const TEST_KEY = Buffer.alloc(32, 7);

interface PersonaRow {
  id: string;
  preset: string;
  verbosity: string;
  useFirstNames: boolean;
  customInstructions: string;
  updatedBy: string | null;
  updatedAt: Date;
}

interface StoredActivityRow {
  id: bigint;
  kind: string;
  what: string;
  severity: string;
  sourceIcon: string;
  sub: string | null;
  refs: Record<string, unknown> | null;
  signature: string;
  prevSignatureHash: string;
  actorType: string | null;
  actorId: string | null;
  schemaVersion: number;
  at: Date;
}

function makePrisma(initial: PersonaRow | null) {
  let row = initial;
  const activityRows: StoredActivityRow[] = [];
  let nextId = 1n;
  const prisma = {
    _row: () => row,
    _activityRows: activityRows,
    assistantPersona: {
      findUnique: async () => row,
      create: async ({ data }: { data: Partial<PersonaRow> }) => {
        row = {
          id: "singleton",
          preset: "warm_friendly",
          verbosity: "balanced",
          useFirstNames: true,
          customInstructions: "",
          updatedBy: null,
          updatedAt: new Date(),
          ...data,
        };
        return row;
      },
      upsert: async ({
        create,
        update,
      }: {
        where: { id: string };
        create: Partial<PersonaRow>;
        update: Partial<PersonaRow>;
      }) => {
        row = row
          ? { ...row, ...update, updatedAt: new Date() }
          : {
              id: "singleton",
              preset: "warm_friendly",
              verbosity: "balanced",
              useFirstNames: true,
              customInstructions: "",
              updatedBy: null,
              updatedAt: new Date(),
              ...create,
            };
        return row;
      },
    },
    // Minimal surface the real recorder's $transaction/$queryRawUnsafe needs.
    async $queryRawUnsafe<T>(query: string): Promise<T> {
      if (query.includes("pg_advisory_xact_lock")) {
        return [{ locked: true }] as unknown as T;
      }
      if (activityRows.length === 0) return [] as unknown as T;
      return [
        { signature: activityRows[activityRows.length - 1]!.signature },
      ] as unknown as T;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async $transaction(fn: (tx: any) => Promise<unknown>) {
      return fn(prisma);
    },
    activityRow: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const stored: StoredActivityRow = {
          id: nextId++,
          kind: data.kind as string,
          what: data.what as string,
          severity: data.severity as string,
          sourceIcon: data.sourceIcon as string,
          sub: (data.sub as string | null) ?? null,
          refs:
            data.refs && (data.refs as { _tag?: string })._tag === "Prisma.DbNull"
              ? null
              : (data.refs as Record<string, unknown> | null) ?? null,
          signature: data.signature as string,
          prevSignatureHash: data.prevSignatureHash as string,
          actorType: (data.actorType as string | null) ?? null,
          actorId: (data.actorId as string | null) ?? null,
          schemaVersion: data.schemaVersion as number,
          at: data.at as Date,
        };
        activityRows.push(stored);
        return stored;
      },
    },
  };
  return prisma;
}

function buildApp(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prisma: any,
  user: { id: string; username: string; role: string },
) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { user: typeof user }).user = { ...user };
    next();
  });
  app.use("/api", createPersonaRouter(prisma));
  return app;
}

const OWNER = { id: "11111111-1111-1111-1111-111111111111", username: "stefan", role: "owner" };
const FAMILY = { id: "22222222-2222-2222-2222-222222222222", username: "kid", role: "family" };
const GUEST = { id: "33333333-3333-3333-3333-333333333333", username: "guest", role: "guest" };
const SERVICE = { id: "44444444-4444-4444-4444-444444444444", username: "voice-io", role: "service" };

beforeEach(() => {
  // Real recorder over a per-test fake prisma is wired per-case (below), so
  // the persisted-row assertion is genuine. Default: no recorder.
  _setActivityRecorderForTests(null, null);
});
afterEach(() => {
  _setActivityRecorderForTests(null, null);
});

describe("GET /api/persona", () => {
  it("returns all fields to an owner (incl. customInstructions)", async () => {
    const prisma = makePrisma({
      id: "singleton",
      preset: "founder",
      verbosity: "detailed",
      useFirstNames: false,
      customInstructions: "sensitive steering guidance",
      updatedBy: "someone",
      updatedAt: new Date(),
    });
    const res = await request(buildApp(prisma, OWNER)).get("/api/persona");
    expect(res.status).toBe(200);
    expect(res.body.preset).toBe("founder");
    expect(res.body.verbosity).toBe("detailed");
    expect(res.body.useFirstNames).toBe(false);
    expect(res.body.customInstructions).toBe("sensitive steering guidance");
  });

  it("returns ONLY preset + verbosity to a family member", async () => {
    const prisma = makePrisma({
      id: "singleton",
      preset: "founder",
      verbosity: "detailed",
      useFirstNames: false,
      customInstructions: "sensitive steering guidance",
      updatedBy: "someone",
      updatedAt: new Date(),
    });
    const res = await request(buildApp(prisma, FAMILY)).get("/api/persona");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ preset: "founder", verbosity: "detailed" });
    expect(res.body).not.toHaveProperty("customInstructions");
    expect(res.body).not.toHaveProperty("useFirstNames");
    // The sensitive text must not appear anywhere in the response.
    expect(JSON.stringify(res.body)).not.toContain("sensitive steering");
  });

  it("returns ONLY preset + verbosity to a guest", async () => {
    const prisma = makePrisma({
      id: "singleton",
      preset: "warm_friendly",
      verbosity: "balanced",
      useFirstNames: true,
      customInstructions: "secret",
      updatedBy: null,
      updatedAt: new Date(),
    });
    const res = await request(buildApp(prisma, GUEST)).get("/api/persona");
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(["preset", "verbosity"]);
  });

  it("creates the default singleton on first read", async () => {
    const prisma = makePrisma(null);
    const res = await request(buildApp(prisma, OWNER)).get("/api/persona");
    expect(res.status).toBe(200);
    expect(res.body.preset).toBe("warm_friendly");
    expect(prisma._row()).not.toBeNull();
  });
});

describe("GET /api/persona/prompt (WARP-1119 — voice threading §14)", () => {
  const ROW: ServicePersonaRow = {
    id: "singleton",
    preset: "direct_technical",
    verbosity: "concise",
    useFirstNames: false,
    customInstructions: "Always give the numbers first.",
    updatedBy: null,
    updatedAt: new Date(),
  };

  it("returns the composed persona block as plain text to the service role", async () => {
    const prisma = makePrisma({ ...ROW });
    const res = await request(buildApp(prisma, SERVICE)).get("/api/persona/prompt");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.text).toBe(composePersonaBlock(ROW));
    // Composed block, not raw fields — starts with the style-only guard line.
    expect(res.text.startsWith(PERSONA_BLOCK_PREFIX)).toBe(true);
    expect(res.text).toContain("Always give the numbers first.");
  });

  it("returns the block to an owner (debugging read, §12)", async () => {
    const prisma = makePrisma({ ...ROW });
    const res = await request(buildApp(prisma, OWNER)).get("/api/persona/prompt");
    expect(res.status).toBe(200);
    expect(res.text.startsWith(PERSONA_BLOCK_PREFIX)).toBe(true);
  });

  it("403s family and guest (the composed block carries customInstructions text)", async () => {
    const prisma = makePrisma({ ...ROW });
    const famRes = await request(buildApp(prisma, FAMILY)).get("/api/persona/prompt");
    expect(famRes.status).toBe(403);
    expect(famRes.text).not.toContain("Always give the numbers first.");
    const guestRes = await request(buildApp(prisma, GUEST)).get("/api/persona/prompt");
    expect(guestRes.status).toBe(403);
  });

  it("materialises the default singleton on first read (fresh box)", async () => {
    const prisma = makePrisma(null);
    const res = await request(buildApp(prisma, SERVICE)).get("/api/persona/prompt");
    expect(res.status).toBe(200);
    expect(res.text.startsWith(PERSONA_BLOCK_PREFIX)).toBe(true);
    expect(prisma._row()).not.toBeNull();
  });
});

describe("PATCH /api/persona", () => {
  it("updates fields for an owner and persists a system/persona_update audit row", async () => {
    const prisma = makePrisma({
      id: "singleton",
      preset: "warm_friendly",
      verbosity: "balanced",
      useFirstNames: true,
      customInstructions: "",
      updatedBy: null,
      updatedAt: new Date(),
    });
    // Wire a REAL recorder over this fake prisma so the audit row actually
    // lands and we can assert on it.
    _setActivityRecorderForTests(
      createActivityRecorder({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        prisma: prisma as any,
        signer: createHmacSigner(TEST_KEY),
      }),
      createHmacSigner(TEST_KEY),
    );

    const res = await request(buildApp(prisma, OWNER)).patch("/api/persona").send({
      preset: "direct_technical",
      verbosity: "concise",
    });
    expect(res.status).toBe(200);
    expect(res.body.preset).toBe("direct_technical");
    expect(prisma._row()!.preset).toBe("direct_technical");
    expect(prisma._row()!.updatedBy).toBe(OWNER.id);

    // The load-bearing assertion: a row actually PERSISTED, of kind system,
    // what persona_update — not merely "the recorder was invoked".
    expect(prisma._activityRows.length).toBe(1);
    const auditRow = prisma._activityRows[0]!;
    expect(auditRow.kind).toBe("system");
    expect(auditRow.what).toBe("persona_update");
    expect(auditRow.actorType).toBe("user");
    expect(auditRow.actorId).toBe(OWNER.id);
    // before/after preset captured in refs (§7.3).
    expect(auditRow.refs).toMatchObject({
      before: "warm_friendly",
      after: "direct_technical",
    });
  });

  it("accepts customInstructions up to 1200 chars", async () => {
    const prisma = makePrisma(null);
    const res = await request(buildApp(prisma, OWNER))
      .patch("/api/persona")
      .send({ customInstructions: "x".repeat(1200) });
    expect(res.status).toBe(200);
    expect(prisma._row()!.customInstructions.length).toBe(1200);
  });

  it("400s customInstructions over the 1200-char cap", async () => {
    const prisma = makePrisma(null);
    const res = await request(buildApp(prisma, OWNER))
      .patch("/api/persona")
      .send({ customInstructions: "x".repeat(1201) });
    expect(res.status).toBe(400);
  });

  it("400s an unknown preset", async () => {
    const prisma = makePrisma(null);
    const res = await request(buildApp(prisma, OWNER))
      .patch("/api/persona")
      .send({ preset: "sardonic" });
    expect(res.status).toBe(400);
  });

  it("400s an empty PATCH (no fields)", async () => {
    const prisma = makePrisma(null);
    const res = await request(buildApp(prisma, OWNER)).patch("/api/persona").send({});
    expect(res.status).toBe(400);
  });

  it("403s a family-role writer (writes are owner/admin only)", async () => {
    const prisma = makePrisma(null);
    const res = await request(buildApp(prisma, FAMILY))
      .patch("/api/persona")
      .send({ preset: "founder" });
    expect(res.status).toBe(403);
  });

  it("403s a guest writer", async () => {
    const prisma = makePrisma(null);
    const res = await request(buildApp(prisma, GUEST))
      .patch("/api/persona")
      .send({ verbosity: "concise" });
    expect(res.status).toBe(403);
  });
});
