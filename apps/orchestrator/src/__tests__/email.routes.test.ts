/**
 * WARP-465 (D1) — email backbone routes.
 *
 * Covers accounts list, threads list + filter, thread detail, draft
 * CRUD, queue-send + off-LAN gate refusal. Mocked EmailGate so the
 * gate path is exercisable without WARP-467's OffLanAllowlistChannel
 * model in scope.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { Request, Response, NextFunction } from "express";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: false },
}));

const { recordActivityMock } = vi.hoisted(() => ({
  recordActivityMock: vi.fn().mockResolvedValue(null),
}));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: recordActivityMock,
}));

import { createEmailRouter, type EmailGate } from "../routes/email.js";
import type { AuthUser } from "../middleware/auth.js";

interface AccountRow {
  id: string;
  userId: string | null;
  displayName: string;
  address: string;
  imapStatus: "idle" | "reconnecting" | "error" | "paused";
  lastIdleAt: Date | null;
  lastErrorAt: Date | null;
  lastError: string | null;
}
interface ThreadRow {
  id: string;
  accountId: string;
  threadKey: string;
  subject: string;
  lastSender: string | null;
  snippet: string | null;
  messageCount: number;
  triageStatus: "inbox" | "triaged" | "archived";
  draftedByDroplet: boolean;
  lastMessageAt: Date;
}
interface DraftRow {
  id: string;
  accountId: string;
  threadId: string | null;
  toAddrs: unknown;
  ccAddrs: unknown;
  bccAddrs: unknown;
  subject: string;
  body: string;
  draftedByDroplet: boolean;
  status: "draft" | "queued" | "sending" | "sent" | "failed";
  sentAt: Date | null;
  claimedAt: Date | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function createPrismaMock(opts: {
  accounts?: AccountRow[];
  threads?: ThreadRow[];
  drafts?: DraftRow[];
} = {}) {
  const accounts = new Map<string, AccountRow>(
    (opts.accounts ?? []).map((a) => [a.id, a]),
  );
  const threads = new Map<string, ThreadRow>(
    (opts.threads ?? []).map((t) => [t.id, t]),
  );
  const drafts = new Map<string, DraftRow>(
    (opts.drafts ?? []).map((d) => [d.id, d]),
  );
  let nextId = 1;

  return {
    accounts,
    threads,
    drafts,
    emailAccount: {
      findMany: vi.fn(async () => [...accounts.values()].sort(
        (a, b) => a.address.localeCompare(b.address),
      )),
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          accounts.get(where.id) ?? null,
      ),
    },
    emailThread: {
      findMany: vi.fn(
        async ({
          where,
          take,
        }: {
          where: {
            accountId: string;
            triageStatus?: string;
            draftedByDroplet?: boolean;
          };
          orderBy?: unknown;
          take?: number;
        }) => {
          let rows = [...threads.values()].filter(
            (t) => t.accountId === where.accountId,
          );
          if (where.triageStatus) {
            rows = rows.filter((t) => t.triageStatus === where.triageStatus);
          }
          if (where.draftedByDroplet !== undefined) {
            rows = rows.filter((t) => t.draftedByDroplet === where.draftedByDroplet);
          }
          rows.sort(
            (a, b) => b.lastMessageAt.getTime() - a.lastMessageAt.getTime(),
          );
          return take ? rows.slice(0, take) : rows;
        },
      ),
      findUnique: vi.fn(
        async ({
          where,
          include,
        }: {
          where: { id: string };
          include?: { messages?: unknown };
        }) => {
          const t = threads.get(where.id);
          if (!t) return null;
          if (include?.messages) {
            return { ...t, messages: [] };
          }
          return t;
        },
      ),
    },
    emailDraft: {
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          drafts.get(where.id) ?? null,
      ),
      create: vi.fn(
        async ({
          data,
        }: {
          data: Omit<DraftRow, "id" | "createdAt" | "updatedAt" | "status" | "sentAt" | "claimedAt" | "error">;
        }) => {
          const id = `draft-${nextId++}`;
          const now = new Date();
          const row: DraftRow = {
            id,
            createdAt: now,
            updatedAt: now,
            status: "draft",
            sentAt: null,
            claimedAt: null,
            error: null,
            ...data,
          };
          drafts.set(id, row);
          return row;
        },
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Partial<DraftRow>;
        }) => {
          const existing = drafts.get(where.id);
          if (!existing) throw new Error("not found");
          const merged = { ...existing, ...data, updatedAt: new Date() };
          drafts.set(where.id, merged);
          return merged;
        },
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: {
            id?: string;
            status?: DraftRow["status"];
            updatedAt?: { lt?: Date };
            claimedAt?: { lt?: Date };
          };
          data: Partial<DraftRow>;
        }) => {
          let count = 0;
          for (const [id, row] of drafts) {
            if (where.id !== undefined && row.id !== where.id) continue;
            if (where.status !== undefined && row.status !== where.status) continue;
            if (where.updatedAt?.lt !== undefined && !(row.updatedAt < where.updatedAt.lt))
              continue;
            // claimedAt filter: a NULL claimedAt never satisfies `lt cutoff`
            // (matches Postgres NULL comparison semantics), so an unclaimed
            // draft is never reconciled.
            if (
              where.claimedAt?.lt !== undefined &&
              !(row.claimedAt !== null && row.claimedAt < where.claimedAt.lt)
            )
              continue;
            drafts.set(id, { ...row, ...data, updatedAt: new Date() });
            count++;
          }
          return { count };
        },
      ),
      findUniqueOrThrow: vi.fn(
        async ({ where }: { where: { id: string } }) => {
          const row = drafts.get(where.id);
          if (!row) throw new Error("No EmailDraft found");
          return row;
        },
      ),
    },
  };
}

const ALLOW_GATE: EmailGate = {
  outboundEmailEnabled: vi.fn().mockResolvedValue(true),
};
const DENY_GATE: EmailGate = {
  outboundEmailEnabled: vi.fn().mockResolvedValue(false),
};

function mkUser(role: AuthUser["role"], username = "stefan"): AuthUser {
  return { id: `user-${role}`, username, displayName: username, role };
}

function buildApp(
  prismaMock: ReturnType<typeof createPrismaMock>,
  gate: EmailGate,
  user: AuthUser,
) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = user;
    next();
  });
  app.use("/api", createEmailRouter(prismaMock as any, gate));
  return app;
}

beforeEach(() => {
  recordActivityMock.mockClear();
  vi.clearAllMocks();
});

describe("WARP-465 — GET /api/email/accounts", () => {
  it("returns accounts; guest 403", async () => {
    const prisma = createPrismaMock({
      accounts: [
        {
          id: "a1",
          userId: "stefan",
          displayName: "Personal",
          address: "stefan@example.com",
          imapStatus: "idle",
          lastIdleAt: new Date(),
          lastErrorAt: null,
          lastError: null,
        },
      ],
    });
    const ok = await request(buildApp(prisma, ALLOW_GATE, mkUser("family"))).get(
      "/api/email/accounts",
    );
    expect(ok.status).toBe(200);
    expect(ok.body.accounts).toHaveLength(1);

    const forbidden = await request(buildApp(prisma, ALLOW_GATE, mkUser("guest"))).get(
      "/api/email/accounts",
    );
    expect(forbidden.status).toBe(403);
  });
});

describe("WARP-465 — GET /api/email/:accountId/threads", () => {
  function seed(): ReturnType<typeof createPrismaMock> {
    const now = new Date();
    const old = new Date(now.getTime() - 86_400_000);
    return createPrismaMock({
      accounts: [
        {
          id: "a1",
          // Owned by the family caller — assertAccountAccessible compares
          // EmailAccount.userId to req.user.id (mkUser mints `user-<role>`).
          userId: "user-family",
          displayName: "x",
          address: "a@b.com",
          imapStatus: "idle",
          lastIdleAt: now,
          lastErrorAt: null,
          lastError: null,
        },
      ],
      threads: [
        {
          id: "t-inbox",
          accountId: "a1",
          threadKey: "k1",
          subject: "Inbox 1",
          lastSender: "x@y.com",
          snippet: "x",
          messageCount: 1,
          triageStatus: "inbox",
          draftedByDroplet: false,
          lastMessageAt: now,
        },
        {
          id: "t-triaged",
          accountId: "a1",
          threadKey: "k2",
          subject: "Triaged 1",
          lastSender: "x@y.com",
          snippet: "y",
          messageCount: 1,
          triageStatus: "triaged",
          draftedByDroplet: false,
          lastMessageAt: old,
        },
        {
          id: "t-droplet",
          accountId: "a1",
          threadKey: "k3",
          subject: "Droplet-drafted",
          lastSender: "x@y.com",
          snippet: "z",
          messageCount: 1,
          triageStatus: "inbox",
          draftedByDroplet: true,
          lastMessageAt: now,
        },
      ],
    });
  }

  it("filters by triageStatus when filter=inbox|triaged|archived", async () => {
    const prisma = seed();
    const inbox = await request(buildApp(prisma, ALLOW_GATE, mkUser("family"))).get(
      "/api/email/a1/threads?filter=inbox",
    );
    expect(inbox.status).toBe(200);
    expect(inbox.body.threads.map((t: { id: string }) => t.id)).toEqual(["t-inbox", "t-droplet"]);

    const triaged = await request(buildApp(prisma, ALLOW_GATE, mkUser("family"))).get(
      "/api/email/a1/threads?filter=triaged",
    );
    expect(triaged.body.threads.map((t: { id: string }) => t.id)).toEqual(["t-triaged"]);
  });

  it("filter=droplet returns draftedByDroplet=true regardless of triage", async () => {
    const prisma = seed();
    const res = await request(buildApp(prisma, ALLOW_GATE, mkUser("family"))).get(
      "/api/email/a1/threads?filter=droplet",
    );
    expect(res.body.threads.map((t: { id: string }) => t.id)).toEqual(["t-droplet"]);
  });

  it("400 on unknown filter", async () => {
    const prisma = seed();
    const res = await request(buildApp(prisma, ALLOW_GATE, mkUser("family"))).get(
      "/api/email/a1/threads?filter=bogus",
    );
    expect(res.status).toBe(400);
  });
});

describe("WARP-465 — POST /api/email/:accountId/drafts", () => {
  it("creates a draft with default status=draft", async () => {
    const prisma = createPrismaMock({
      accounts: [
        {
          id: "a1",
          // Owned by the family caller (see threads seed note).
          userId: "user-family",
          displayName: "x",
          address: "a@b.com",
          imapStatus: "idle",
          lastIdleAt: null,
          lastErrorAt: null,
          lastError: null,
        },
      ],
    });
    const res = await request(buildApp(prisma, ALLOW_GATE, mkUser("family")))
      .post("/api/email/a1/drafts")
      .send({
        toAddrs: ["c@d.com"],
        subject: "Hi",
        body: "Body",
      });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("draft");
    expect(res.body.subject).toBe("Hi");
  });

  it("404 when account missing", async () => {
    const prisma = createPrismaMock();
    const res = await request(buildApp(prisma, ALLOW_GATE, mkUser("family")))
      .post("/api/email/nope/drafts")
      .send({ toAddrs: ["c@d.com"], subject: "Hi" });
    expect(res.status).toBe(404);
  });

  it("400 on invalid email in toAddrs", async () => {
    const prisma = createPrismaMock({
      accounts: [
        {
          id: "a1",
          userId: null,
          displayName: "x",
          address: "a@b.com",
          imapStatus: "idle",
          lastIdleAt: null,
          lastErrorAt: null,
          lastError: null,
        },
      ],
    });
    const res = await request(buildApp(prisma, ALLOW_GATE, mkUser("family")))
      .post("/api/email/a1/drafts")
      .send({ toAddrs: ["not-an-email"], subject: "Hi" });
    expect(res.status).toBe(400);
  });
});

describe("WARP-890 — idempotent outbound (claim + reconcile)", () => {
  function withDraft(status: DraftRow["status"], claimedAt: Date | null = null) {
    return createPrismaMock({
      accounts: [
        {
          id: "a1",
          userId: "user-family",
          displayName: "x",
          address: "a@b.com",
          imapStatus: "idle",
          lastIdleAt: new Date(),
          lastErrorAt: null,
          lastError: null,
        },
      ],
      drafts: [
        {
          id: "d1",
          accountId: "a1",
          threadId: null,
          toAddrs: ["c@d.com"],
          ccAddrs: null,
          bccAddrs: null,
          subject: "Test",
          body: "Body",
          draftedByDroplet: false,
          status,
          sentAt: null,
          claimedAt,
          error: null,
          createdAt: new Date(),
          // updatedAt is deliberately FRESH on every fixture row — the
          // reconcile must NOT key off it (a fresh updatedAt would otherwise
          // mask a long-claimed draft); it keys off claimedAt.
          updatedAt: new Date(),
        },
      ],
    });
  }

  it("claim flips a queued draft to sending, stamps claimedAt, returns claimed:true", async () => {
    const prisma = withDraft("queued");
    const before = Date.now();
    const res = await request(buildApp(prisma, ALLOW_GATE, mkUser("service")))
      .post("/api/email/drafts/d1/claim")
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.claimed).toBe(true);
    expect(prisma.drafts.get("d1")?.status).toBe("sending");
    const claimedAt = prisma.drafts.get("d1")?.claimedAt;
    expect(claimedAt).toBeInstanceOf(Date);
    expect(claimedAt!.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("claim of a non-queued draft returns claimed:false and leaves it (re-tick is a no-op)", async () => {
    const prisma = withDraft("sending");
    const res = await request(buildApp(prisma, ALLOW_GATE, mkUser("service")))
      .post("/api/email/drafts/d1/claim")
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.claimed).toBe(false);
    expect(prisma.drafts.get("d1")?.status).toBe("sending"); // unchanged
  });

  it("claim requires the service role (403 otherwise)", async () => {
    const prisma = withDraft("queued");
    const res = await request(buildApp(prisma, ALLOW_GATE, mkUser("admin")))
      .post("/api/email/drafts/d1/claim")
      .send({});
    expect(res.status).toBe(403);
  });

  it("PATCH /status accepts the sending -> sent transition", async () => {
    const prisma = withDraft("sending");
    const res = await request(buildApp(prisma, ALLOW_GATE, mkUser("service")))
      .patch("/api/email/drafts/d1/status")
      .send({ status: "sent" });
    expect(res.status).toBe(200);
    expect(prisma.drafts.get("d1")?.status).toBe("sent");
  });

  it("reconcile fails out a sending draft claimed before the grace window", async () => {
    const old = new Date(Date.now() - 60 * 60 * 1000); // claimed 1h ago (past default 10m)
    const prisma = withDraft("sending", old);
    const res = await request(buildApp(prisma, ALLOW_GATE, mkUser("service")))
      .post("/api/email/drafts/reconcile-stale-sending")
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.reconciled).toBe(1);
    expect(prisma.drafts.get("d1")?.status).toBe("failed");
  });

  it("reconcile leaves a freshly-claimed sending draft alone", async () => {
    const prisma = withDraft("sending", new Date());
    const res = await request(buildApp(prisma, ALLOW_GATE, mkUser("service")))
      .post("/api/email/drafts/reconcile-stale-sending")
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.reconciled).toBe(0);
    expect(prisma.drafts.get("d1")?.status).toBe("sending");
  });

  it("reconcile ignores a sending draft with a NULL claimedAt (never matches the cutoff)", async () => {
    // A stale updatedAt must NOT trigger reconcile when claimedAt is unset:
    // proves the cutoff keys off claimedAt, not updatedAt.
    const prisma = withDraft("sending", null);
    const res = await request(buildApp(prisma, ALLOW_GATE, mkUser("service")))
      .post("/api/email/drafts/reconcile-stale-sending")
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.reconciled).toBe(0);
    expect(prisma.drafts.get("d1")?.status).toBe("sending");
  });
});

describe("WARP-465 — POST /api/email/drafts/:id/send", () => {
  function withDraft(status: "draft" | "queued" | "sending" | "sent" | "failed" = "draft") {
    return createPrismaMock({
      // The send/PATCH routes now run assertAccountAccessible against the
      // draft's accountId (belt-and-braces IDOR check) — the account row
      // must exist for the lookup to pass.
      accounts: [
        {
          id: "a1",
          userId: "user-family",
          displayName: "x",
          address: "a@b.com",
          imapStatus: "idle",
          lastIdleAt: new Date(),
          lastErrorAt: null,
          lastError: null,
        },
      ],
      drafts: [
        {
          id: "d1",
          accountId: "a1",
          threadId: null,
          toAddrs: ["c@d.com"],
          ccAddrs: null,
          bccAddrs: null,
          subject: "Test",
          body: "Body",
          draftedByDroplet: false,
          status,
          sentAt: null,
          claimedAt: null,
          error: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    });
  }

  it("queues a draft for send; emits ActivityRow; returns 202", async () => {
    const prisma = withDraft();
    const res = await request(buildApp(prisma, ALLOW_GATE, mkUser("admin")))
      .post("/api/email/drafts/d1/send")
      .send({});
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("queued");
    expect(prisma.drafts.get("d1")?.status).toBe("queued");
    expect(recordActivityMock).toHaveBeenCalledTimes(1);
    expect(recordActivityMock.mock.calls[0][0].kind).toBe("email");
  });

  it("451 when off-LAN gate denies", async () => {
    const prisma = withDraft();
    const res = await request(buildApp(prisma, DENY_GATE, mkUser("admin")))
      .post("/api/email/drafts/d1/send")
      .send({});
    expect(res.status).toBe(451);
    expect(res.body.channel).toBe("outbound_email");
    expect(prisma.drafts.get("d1")?.status).toBe("draft"); // unchanged
    expect(recordActivityMock).not.toHaveBeenCalled();
  });

  it("family-role send is 403 (owner/admin only)", async () => {
    const prisma = withDraft();
    const res = await request(buildApp(prisma, ALLOW_GATE, mkUser("family")))
      .post("/api/email/drafts/d1/send")
      .send({});
    expect(res.status).toBe(403);
  });

  it("409 when draft already queued", async () => {
    const prisma = withDraft("queued");
    const res = await request(buildApp(prisma, ALLOW_GATE, mkUser("admin")))
      .post("/api/email/drafts/d1/send")
      .send({});
    expect(res.status).toBe(409);
  });

  it("404 when draft missing", async () => {
    const prisma = createPrismaMock();
    const res = await request(buildApp(prisma, ALLOW_GATE, mkUser("admin")))
      .post("/api/email/drafts/nope/send")
      .send({});
    expect(res.status).toBe(404);
  });
});

describe("WARP-465 — PATCH /api/email/drafts/:id", () => {
  it("edits a draft while status=draft", async () => {
    const prisma = createPrismaMock({
      // The send/PATCH routes now run assertAccountAccessible against the
      // draft's accountId (belt-and-braces IDOR check) — the account row
      // must exist for the lookup to pass.
      accounts: [
        {
          id: "a1",
          userId: "user-family",
          displayName: "x",
          address: "a@b.com",
          imapStatus: "idle",
          lastIdleAt: new Date(),
          lastErrorAt: null,
          lastError: null,
        },
      ],
      drafts: [
        {
          id: "d1",
          accountId: "a1",
          threadId: null,
          toAddrs: ["c@d.com"],
          ccAddrs: null,
          bccAddrs: null,
          subject: "Old",
          body: "old body",
          draftedByDroplet: false,
          status: "draft",
          sentAt: null,
          claimedAt: null,
          error: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    });
    const res = await request(buildApp(prisma, ALLOW_GATE, mkUser("family")))
      .patch("/api/email/drafts/d1")
      .send({ subject: "New", body: "new body" });
    expect(res.status).toBe(200);
    expect(res.body.subject).toBe("New");
    expect(res.body.body).toBe("new body");
  });

  it("409 when draft already queued/sent", async () => {
    const prisma = createPrismaMock({
      // The send/PATCH routes now run assertAccountAccessible against the
      // draft's accountId (belt-and-braces IDOR check) — the account row
      // must exist for the lookup to pass.
      accounts: [
        {
          id: "a1",
          userId: "user-family",
          displayName: "x",
          address: "a@b.com",
          imapStatus: "idle",
          lastIdleAt: new Date(),
          lastErrorAt: null,
          lastError: null,
        },
      ],
      drafts: [
        {
          id: "d1",
          accountId: "a1",
          threadId: null,
          toAddrs: ["c@d.com"],
          ccAddrs: null,
          bccAddrs: null,
          subject: "x",
          body: "x",
          draftedByDroplet: false,
          status: "sent",
          sentAt: new Date(),
          claimedAt: null,
          error: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    });
    const res = await request(buildApp(prisma, ALLOW_GATE, mkUser("family")))
      .patch("/api/email/drafts/d1")
      .send({ subject: "New" });
    expect(res.status).toBe(409);
  });
});
