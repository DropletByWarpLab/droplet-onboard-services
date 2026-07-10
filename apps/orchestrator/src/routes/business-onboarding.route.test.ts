/**
 * WARP-1121 (Phase 3, §12) — route tests for the onboarding lifecycle API
 * (start/skip/commit) + the review-dismiss route on the profile router.
 *
 *   RBAC   owner/admin only on all four (real requireRole, not mocked).
 *   409    every illegal/raced transition maps to onboarding_state_conflict
 *          with the loser's observed state in the body (drives the
 *          "another admin finished this" banner).
 *   Audit  kind `system` + what business_onboarding_start|skip|commit /
 *          review_dismiss asserted on the PERSISTED ActivityRow via a REAL
 *          recorder over the fake prisma (recordSafely swallows unknown-kind
 *          throws — a "mock called" check would lie, §5-13).
 *
 * Mirrors business-profile.route.test.ts's harness.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";
import { createBusinessOnboardingRouter } from "./business-onboarding.js";
import { createBusinessProfileRouter } from "./business-profile.js";
import { _setActivityRecorderForTests } from "../services/activity.singleton.js";
import { createActivityRecorder } from "../services/activity.service.js";
import { createHmacSigner } from "../services/audit-signing.service.js";
import {
  CLOSING_TURN,
  INTERVIEW_SESSION_TITLE,
  ONBOARDING_FACTS_ADDED_BY,
} from "../services/business-onboarding.service.js";

const TEST_KEY = Buffer.alloc(32, 7);

interface ProfileRow {
  id: string;
  onboardingState: string;
  interviewChatId: string | null;
  summary: string;
  whatWeDo: string;
  customers: string;
  teamShape: string;
  toolsUsed: string;
  typicalDay: string;
  goals: string;
  lastSource: string | null;
  reviewNudgeState: string;
  reviewDueAt: Date | null;
  reviewDismissedAt: Date | null;
  updatedBy: string | null;
  updatedAt: Date;
}

const DEFAULTS: ProfileRow = {
  id: "singleton",
  onboardingState: "not_started",
  interviewChatId: null,
  summary: "",
  whatWeDo: "",
  customers: "",
  teamShape: "",
  toolsUsed: "",
  typicalDay: "",
  goals: "",
  lastSource: null,
  reviewNudgeState: "none",
  reviewDueAt: null,
  reviewDismissedAt: null,
  updatedBy: null,
  updatedAt: new Date("2026-07-09T00:00:00Z"),
};

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

function makePrisma(initial: Partial<ProfileRow> | null = {}) {
  let row: ProfileRow | null =
    initial === null ? null : { ...DEFAULTS, ...initial };
  const activityRows: StoredActivityRow[] = [];
  const sessions: Array<{ id: string; userId: string; title: string | null }> = [];
  const messages: Array<{ sessionId: string; role: string; content: string }> = [];
  const facts: Array<Record<string, unknown>> = [];
  let nextId = 1n;
  let nextSession = 1;

  const stateMatches = (
    cond: string | { in: string[] } | undefined,
  ): boolean => {
    if (!row) return false;
    if (cond === undefined) return true;
    if (typeof cond === "string") return row.onboardingState === cond;
    return cond.in.includes(row.onboardingState);
  };

  const prisma = {
    _row: () => row,
    _activityRows: activityRows,
    _sessions: sessions,
    _messages: messages,
    _facts: facts,
    businessProfile: {
      findUnique: async () => row,
      create: async ({ data }: { data: Partial<ProfileRow> }) => {
        row = { ...DEFAULTS, ...data };
        return row;
      },
      update: async ({ data }: { data: Partial<ProfileRow> }) => {
        if (!row) throw new Error("no row");
        row = { ...row, ...data, updatedAt: new Date() };
        return row;
      },
      upsert: async ({
        create,
        update,
      }: {
        create: Partial<ProfileRow>;
        update: Partial<ProfileRow>;
      }) => {
        row = row
          ? { ...row, ...update, updatedAt: new Date() }
          : { ...DEFAULTS, ...create };
        return row;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: {
          id: string;
          onboardingState?: string | { in: string[] };
          interviewChatId?: null;
        };
        data: Partial<ProfileRow>;
      }) => {
        if (!stateMatches(where.onboardingState)) return { count: 0 };
        if ("interviewChatId" in where && where.interviewChatId === null && row!.interviewChatId !== null) {
          return { count: 0 };
        }
        row = { ...row!, ...data };
        return { count: 1 };
      },
    },
    chatSession: {
      create: async ({
        data,
      }: {
        data: { userId: string; title?: string | null };
      }) => {
        const s = {
          id: `session-${nextSession++}`,
          userId: data.userId,
          title: data.title ?? null,
        };
        sessions.push(s);
        return s;
      },
      update: async () => ({}),
    },
    chatMessage: {
      create: async ({
        data,
      }: {
        data: { sessionId: string; role: string; content: string };
      }) => {
        messages.push(data);
        return data;
      },
    },
    memoryFact: {
      createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => {
        facts.push(...data);
        return { count: data.length };
      },
      updateMany: async () => ({ count: 0 }),
    },
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
              : ((data.refs as Record<string, unknown> | null) ?? null),
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
  app.use("/api", createBusinessOnboardingRouter(prisma));
  app.use("/api", createBusinessProfileRouter(prisma));
  return app;
}

function wireRealRecorder(prisma: unknown) {
  _setActivityRecorderForTests(
    createActivityRecorder({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: prisma as any,
      signer: createHmacSigner(TEST_KEY),
    }),
    createHmacSigner(TEST_KEY),
  );
}

const OWNER = { id: "11111111-1111-1111-1111-111111111111", username: "stefan", role: "owner" };
const ADMIN = { id: "44444444-4444-4444-4444-444444444444", username: "adm", role: "admin" };
const FAMILY = { id: "22222222-2222-2222-2222-222222222222", username: "kid", role: "family" };
const GUEST = { id: "33333333-3333-3333-3333-333333333333", username: "guest", role: "guest" };

beforeEach(() => {
  _setActivityRecorderForTests(null, null);
});
afterEach(() => {
  _setActivityRecorderForTests(null, null);
});

describe("RBAC (§9.5) — owner/admin only on every lifecycle route", () => {
  it.each([
    ["/api/business-onboarding/start"],
    ["/api/business-onboarding/skip"],
    ["/api/business-onboarding/commit"],
    ["/api/business-profile/review-dismiss"],
  ])("family and guest get 403 on POST %s", async (path) => {
    const prisma = makePrisma({});
    for (const user of [FAMILY, GUEST]) {
      const res = await request(buildApp(prisma, user)).post(path).send({});
      expect(res.status).toBe(403);
    }
    // Nothing moved, nothing audited.
    expect(prisma._row()!.onboardingState).toBe("not_started");
    expect(prisma._activityRows).toHaveLength(0);
  });
});

describe("POST /api/business-onboarding/start", () => {
  it("starts the interview and persists the audit row", async () => {
    const prisma = makePrisma({});
    wireRealRecorder(prisma);
    const res = await request(buildApp(prisma, OWNER))
      .post("/api/business-onboarding/start")
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      conversationId: "session-1",
      state: "in_progress",
      created: true,
    });
    // The persisted session belongs to the caller's USERNAME (ChatSession
    // keys on username — a uuid here would orphan the sidebar entry).
    expect(prisma._sessions[0]).toMatchObject({
      userId: "stefan",
      title: INTERVIEW_SESSION_TITLE,
    });
    expect(prisma._activityRows).toHaveLength(1);
    expect(prisma._activityRows[0]).toMatchObject({
      kind: "system",
      what: "business_onboarding_start",
    });
  });

  it("is idempotent while in flight — 200, no second session, NO audit row", async () => {
    const prisma = makePrisma({
      onboardingState: "in_progress",
      interviewChatId: "conv-live",
    });
    wireRealRecorder(prisma);
    const res = await request(buildApp(prisma, ADMIN))
      .post("/api/business-onboarding/start")
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.conversationId).toBe("conv-live");
    expect(res.body.created).toBe(false);
    expect(prisma._sessions).toHaveLength(0);
    expect(prisma._activityRows).toHaveLength(0);
  });

  it("re-run from completed returns re_running", async () => {
    const prisma = makePrisma({
      onboardingState: "completed",
      interviewChatId: "old",
    });
    wireRealRecorder(prisma);
    const res = await request(buildApp(prisma, OWNER))
      .post("/api/business-onboarding/start")
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("re_running");
  });
});

describe("POST /api/business-onboarding/skip", () => {
  it("skips from not_started and persists the audit row", async () => {
    const prisma = makePrisma({});
    wireRealRecorder(prisma);
    const res = await request(buildApp(prisma, OWNER))
      .post("/api/business-onboarding/skip")
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ from: "not_started", state: "skipped" });
    expect(prisma._activityRows[0]).toMatchObject({
      kind: "system",
      what: "business_onboarding_skip",
    });
  });

  it("409s with the observed state on an illegal edge", async () => {
    const prisma = makePrisma({ onboardingState: "skipped" });
    wireRealRecorder(prisma);
    const res = await request(buildApp(prisma, OWNER))
      .post("/api/business-onboarding/skip")
      .send({});
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: "onboarding_state_conflict",
      state: "skipped",
    });
    expect(prisma._activityRows).toHaveLength(0);
  });
});

describe("POST /api/business-onboarding/commit", () => {
  const PAYLOAD = {
    profile: { whatWeDo: "We fix teeth." },
    summary: "A dental practice.",
    facts: [
      { category: "Business", fact: "Open Tue-Sat", audience: "family" },
      { category: "Tone", fact: "Short replies", audience: "admin" },
    ],
  };

  it("commits: profile + facts + closing message + audit row", async () => {
    const prisma = makePrisma({
      onboardingState: "in_progress",
      interviewChatId: "conv-1",
    });
    wireRealRecorder(prisma);
    const res = await request(buildApp(prisma, OWNER))
      .post("/api/business-onboarding/commit")
      .send(PAYLOAD);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      state: "completed",
      factsSaved: 2,
      factsSuperseded: 0,
    });
    expect(prisma._row()).toMatchObject({
      onboardingState: "completed",
      lastSource: "onboarding",
      whatWeDo: "We fix teeth.",
    });
    expect(prisma._facts).toHaveLength(2);
    expect(prisma._facts[0]).toMatchObject({
      addedBy: ONBOARDING_FACTS_ADDED_BY,
      evidenceChatId: "conv-1",
    });
    expect(prisma._messages).toEqual([
      { sessionId: "conv-1", role: "assistant", content: CLOSING_TURN },
    ]);
    expect(prisma._activityRows).toHaveLength(1);
    const audit = prisma._activityRows[0]!;
    expect(audit.kind).toBe("system");
    expect(audit.what).toBe("business_onboarding_commit");
    // Counts in refs — never transcript text (§15).
    expect(audit.refs).toMatchObject({ factsSaved: 2 });
  });

  it("409s when another admin finished first (design §7.10)", async () => {
    const prisma = makePrisma({ onboardingState: "completed" });
    wireRealRecorder(prisma);
    const res = await request(buildApp(prisma, ADMIN))
      .post("/api/business-onboarding/commit")
      .send(PAYLOAD);
    expect(res.status).toBe(409);
    expect(res.body.state).toBe("completed");
    expect(prisma._facts).toHaveLength(0);
    expect(prisma._activityRows).toHaveLength(0);
  });

  it("400s an over-bounds payload via zod (reject, never truncate)", async () => {
    const prisma = makePrisma({
      onboardingState: "in_progress",
      interviewChatId: "conv-1",
    });
    const res = await request(buildApp(prisma, OWNER))
      .post("/api/business-onboarding/commit")
      .send({
        facts: [{ category: "Business", fact: "x".repeat(281) }],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_commit_payload");
  });

  it("400s content-hygiene violations from the service", async () => {
    const prisma = makePrisma({
      onboardingState: "in_progress",
      interviewChatId: "conv-1",
    });
    const res = await request(buildApp(prisma, OWNER))
      .post("/api/business-onboarding/commit")
      .send({ summary: "nice biz ```rm -rf```" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_commit_payload");
  });
});

describe("POST /api/business-profile/review-dismiss (§12)", () => {
  it("sets the explicit dismissed state + timestamp and audits", async () => {
    const prisma = makePrisma({ reviewNudgeState: "due" });
    wireRealRecorder(prisma);
    const res = await request(buildApp(prisma, OWNER))
      .post("/api/business-profile/review-dismiss")
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.reviewNudgeState).toBe("dismissed");
    expect(prisma._row()).toMatchObject({ reviewNudgeState: "dismissed" });
    expect(prisma._row()!.reviewDismissedAt).toBeInstanceOf(Date);
    // The schedule timestamp is NOT nulled — dismissal is its own column.
    expect(prisma._activityRows[0]).toMatchObject({
      kind: "system",
      what: "review_dismiss",
    });
  });
});
