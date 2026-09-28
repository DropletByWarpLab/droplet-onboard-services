/**
 * WARP-3267 — email attachments: ingest limits, owner-only download,
 * filename sanitising, and forwards limited to the draft's own mailbox.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { Request, Response, NextFunction } from "express";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: false, agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));

const { recordActivityMock } = vi.hoisted(() => ({
  recordActivityMock: vi.fn().mockResolvedValue(null),
}));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: recordActivityMock,
}));

import {
  createEmailRouter,
  EMAIL_ATTACHMENT_LIMITS,
  sanitizeAttachmentFilename,
  type EmailGate,
} from "../routes/email.js";
import type { AuthUser } from "../middleware/auth.js";

const GATE: EmailGate = { outboundEmailEnabled: async () => true };

interface Att {
  id: string;
  emailMessageId: string;
  accountId: string;
  filename: string;
  size: number;
  status: "stored" | "too_large" | "over_limit";
  data: Uint8Array | null;
}

const A1 = "11111111-1111-4111-8111-111111111111"; // alice's mailbox attachment
const B1 = "22222222-2222-4222-8222-222222222222"; // bob's mailbox attachment

function mkPrisma() {
  const accounts: Record<string, { id: string; userId: string | null }> = {
    "acct-alice": { id: "acct-alice", userId: "u-alice" },
    "acct-bob": { id: "acct-bob", userId: "u-bob" },
  };
  const attachments: Att[] = [
    {
      id: A1,
      emailMessageId: "m-alice",
      accountId: "acct-alice",
      filename: "../../etc/in‮voice\r\n\"x\".pdf",
      size: 4,
      status: "stored",
      data: Buffer.from("%PDF"),
    },
    {
      id: B1,
      emailMessageId: "m-bob",
      accountId: "acct-bob",
      filename: "bob.pdf",
      size: 4,
      status: "stored",
      data: Buffer.from("%PDF"),
    },
  ];
  const created: unknown[] = [];
  return {
    created,
    emailAccount: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => accounts[where.id] ?? null),
    },
    emailAttachment: {
      findFirst: vi.fn(
        async ({ where }: { where: { id: string; emailMessageId: string; accountId: string } }) =>
          attachments.find(
            (a) =>
              a.id === where.id &&
              a.emailMessageId === where.emailMessageId &&
              a.accountId === where.accountId,
          ) ?? null,
      ),
      findMany: vi.fn(
        async ({ where }: { where: { id: { in: string[] }; accountId: string } }) =>
          attachments.filter(
            (a) => where.id.in.includes(a.id) && a.accountId === where.accountId && a.status === "stored",
          ),
      ),
    },
    emailThread: {
      upsert: vi.fn(async () => ({ id: "t1" })),
      update: vi.fn(async () => ({})),
    },
    emailMessage: {
      create: vi.fn(async (args: unknown) => {
        created.push(args);
        return {};
      }),
    },
    emailDraft: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "d1", ...data })),
    },
  };
}

function mkUser(id: string, role: AuthUser["role"]): AuthUser {
  return { id, username: id, displayName: id, role } as AuthUser;
}

function buildApp(prisma: ReturnType<typeof mkPrisma>, user: AuthUser) {
  const app = express();
  app.use(express.json({ limit: "40mb" }));
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = user;
    next();
  });
  app.use("/api", createEmailRouter(prisma as any, GATE));
  return app;
}

const SERVICE = mkUser("_service:email", "service" as AuthUser["role"]);

function ingestBody(attachments: unknown[]) {
  return {
    messageId: "m@x",
    fromAddr: "a@x.com",
    toAddrs: ["b@x.com"],
    subject: "files",
    bodyText: "see attached",
    receivedAt: new Date().toISOString(),
    threadKey: "m@x",
    attachments,
  };
}

function stored(bytes: Buffer, name = "f.pdf") {
  return {
    filename: name,
    contentType: "application/pdf",
    size: 0, // the route measures, never trusts
    sha256: "0".repeat(64),
    status: "stored",
    data: bytes.toString("base64"),
  };
}

const DL = (acct: string, msg: string, att: string) =>
  `/api/email/${acct}/messages/${msg}/attachments/${att}`;

beforeEach(() => {
  recordActivityMock.mockClear();
});

describe("WARP-3267 — ingest stores attachments within the limits", () => {
  it("stores a part with the size and hash measured on the box", async () => {
    const prisma = mkPrisma();
    const res = await request(buildApp(prisma, SERVICE))
      .post("/api/email/acct-alice/messages-ingest")
      .send(ingestBody([stored(Buffer.from("%PDF"))]));
    expect(res.status).toBe(201);
    const data = (prisma.created[0] as { data: { attachments: { create: any[] } } }).data;
    const [row] = data.attachments.create;
    expect(row.size).toBe(4);
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row.sha256).not.toBe("0".repeat(64));
    expect(row.accountId).toBe("acct-alice");
    expect(Buffer.from(row.data).toString()).toBe("%PDF");
  });

  it("stores an RTL-override filename clean, so every listing shows the clean name", async () => {
    const prisma = mkPrisma();
    const res = await request(buildApp(prisma, SERVICE))
      .post("/api/email/acct-alice/messages-ingest")
      .send(ingestBody([stored(Buffer.from("MZ"), "invoice\u202Efdp.exe")]));
    expect(res.status).toBe(201);
    const [row] = (prisma.created[0] as { data: { attachments: { create: any[] } } }).data
      .attachments.create;
    expect(row.filename).toBe("invoice_fdp.exe");
  });

  it("refuses a part over the per-attachment limit", async () => {
    const prisma = mkPrisma();
    const res = await request(buildApp(prisma, SERVICE))
      .post("/api/email/acct-alice/messages-ingest")
      .send(ingestBody([stored(Buffer.alloc(EMAIL_ATTACHMENT_LIMITS.maxBytes + 1))]));
    // The schema's base64 length bound or the decoded check — either way,
    // nothing is stored.
    expect([400, 413]).toContain(res.status);
    expect(prisma.emailMessage.create).not.toHaveBeenCalled();
  });

  it("refuses more stored parts than the count limit", async () => {
    const prisma = mkPrisma();
    const many = Array.from({ length: EMAIL_ATTACHMENT_LIMITS.maxStored + 1 }, () =>
      stored(Buffer.from("x")),
    );
    const res = await request(buildApp(prisma, SERVICE))
      .post("/api/email/acct-alice/messages-ingest")
      .send(ingestBody(many));
    expect(res.status).toBe(413);
    expect(prisma.emailMessage.create).not.toHaveBeenCalled();
  });

  it("refuses stored parts over the per-message total", async () => {
    const prisma = mkPrisma();
    const nine = Buffer.alloc(9 * 1024 * 1024);
    const res = await request(buildApp(prisma, SERVICE))
      .post("/api/email/acct-alice/messages-ingest")
      .send(ingestBody([stored(nine), stored(nine), stored(nine)]));
    expect(res.status).toBe(413);
  });

  it("refuses bytes on a part listed as too large", async () => {
    const prisma = mkPrisma();
    const res = await request(buildApp(prisma, SERVICE))
      .post("/api/email/acct-alice/messages-ingest")
      .send(ingestBody([{ ...stored(Buffer.from("x")), status: "too_large" }]));
    expect(res.status).toBe(413);
  });

  it("is service-only", async () => {
    const res = await request(buildApp(mkPrisma(), mkUser("u-alice", "owner")))
      .post("/api/email/acct-alice/messages-ingest")
      .send(ingestBody([]));
    expect(res.status).toBe(403);
  });
});

describe("WARP-3267 — download is owner-only and never inline", () => {
  it("serves the mailbox owner a sanitised download with nosniff, and audits it", async () => {
    const res = await request(buildApp(mkPrisma(), mkUser("u-alice", "family"))).get(
      DL("acct-alice", "m-alice", A1),
    );
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/octet-stream");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    const cd = res.headers["content-disposition"] as string;
    expect(cd.startsWith("attachment;")).toBe(true);
    expect(cd).not.toMatch(/\.\.|\/|\r|\n|‮/);
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ what: "Email attachment downloaded" }),
    );
  });

  it("gives another member a 404, not the file", async () => {
    const res = await request(buildApp(mkPrisma(), mkUser("u-bob", "family"))).get(
      DL("acct-alice", "m-alice", A1),
    );
    expect(res.status).toBe(404);
    expect(recordActivityMock).not.toHaveBeenCalled();
  });

  it("gives a 404 when the attachment belongs to another mailbox's message", async () => {
    // Bob's own account in the URL, Alice's attachment id: still no file.
    const res = await request(buildApp(mkPrisma(), mkUser("u-bob", "family"))).get(
      DL("acct-bob", "m-bob", A1),
    );
    expect(res.status).toBe(404);
  });

  it("refuses an external guest", async () => {
    const res = await request(buildApp(mkPrisma(), mkUser("u-guest", "guest"))).get(
      DL("acct-alice", "m-alice", A1),
    );
    expect(res.status).toBe(403);
  });

  it("lets an admin read any mailbox's attachment, as for the thread", async () => {
    const res = await request(buildApp(mkPrisma(), mkUser("u-admin", "admin"))).get(
      DL("acct-alice", "m-alice", A1),
    );
    expect(res.status).toBe(200);
  });
});

describe("WARP-3267 — sanitizeAttachmentFilename", () => {
  it("drops directories, control and bidi characters, quotes and leading dots", () => {
    const out = sanitizeAttachmentFilename("../../etc/in‮voice\r\n\"x\".pdf");
    expect(out).toBe("in_voice___x_.pdf");
    expect(sanitizeAttachmentFilename("..\\..\\boot.ini")).toBe("boot.ini");
    expect(sanitizeAttachmentFilename("...")).toBe("attachment");
    expect(sanitizeAttachmentFilename("a".repeat(500)).length).toBe(200);
  });
});

describe("WARP-3267 — a forward carries only its own mailbox's attachments", () => {
  const draft = (ids: string[]) => ({
    toAddrs: ["c@x.com"],
    subject: "Fwd: files",
    attachmentIds: ids,
  });

  it("accepts an attachment of the same mailbox", async () => {
    const res = await request(buildApp(mkPrisma(), mkUser("u-alice", "family")))
      .post("/api/email/acct-alice/drafts")
      .send(draft([A1]));
    expect(res.status).toBe(201);
    expect(res.body.attachmentIds).toEqual([A1]);
  });

  it("refuses another mailbox's attachment", async () => {
    const res = await request(buildApp(mkPrisma(), mkUser("u-alice", "family")))
      .post("/api/email/acct-alice/drafts")
      .send(draft([B1]));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("attachment_not_found");
  });
});
