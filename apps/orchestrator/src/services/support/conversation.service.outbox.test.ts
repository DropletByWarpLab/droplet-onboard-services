import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTransactionSeam } from "../../__tests__/helpers/prisma-tx-harness.js";

vi.mock("../pm/pm-outbox.js", () => ({ nudgeOutbox: vi.fn() }));
vi.mock("../off-lan-gate.service.js", () => ({ outboundEmailGate: vi.fn().mockResolvedValue(true) }));
vi.mock("./ticket.service.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./ticket.service.js")>(),
  findTicketRow: vi.fn(),
  assertDeskOpen: vi.fn().mockResolvedValue(undefined),
  getTicket: vi.fn().mockResolvedValue({ id: "ticket" }),
}));
vi.mock("./support-mappers.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./support-mappers.js")>(),
  loadPeople: vi.fn().mockResolvedValue(new Map([["owner", "Owner"]])),
}));

import { nudgeOutbox } from "../pm/pm-outbox.js";
import { findTicketRow } from "./ticket.service.js";
import { addReply, retryPublicReply } from "./conversation.service.js";

const NOW = new Date("2026-10-05T12:00:00.000Z");
const VIEWER = { id: "owner", role: "owner" as const };
const CONTEXT = { canReadProjects: true, canReadCrm: true };

function fixture(rejectCommit = false) {
  const comments: unknown[] = [];
  const activity: unknown[] = [];
  const drafts: unknown[] = [];
  const links: unknown[] = [];
  vi.mocked(findTicketRow).mockResolvedValue({
    id: "ticket", projectId: "desk", stateId: "new", sequenceId: 1, name: "Printer offline",
    state: { group: "unstarted" }, project: { identifier: "HELP" },
    ticket: { requesterEmail: "dana@example.test" },
  } as never);
  const tx = {
    pmComment: { create: vi.fn(async ({ data }: { data: object }) => {
      comments.push(data);
      return { ...data, id: "comment", createdAt: NOW };
    }) },
    pmActivity: { create: vi.fn(async ({ data }: { data: object }) => { activity.push(data); return {}; }) },
    pmWorkItem: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), update: vi.fn().mockResolvedValue({}) },
    pmTicket: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), update: vi.fn().mockResolvedValue({}) },
    emailDraft: { create: vi.fn(async ({ data }: { data: object }) => { drafts.push(data); return { id: "draft" }; }) },
    pmTicketEmailLink: { create: vi.fn(async ({ data }: { data: object }) => { links.push(data); return {}; }) },
  };
  const seam = createTransactionSeam({ client: () => tx, stores: { comments, activity, drafts, links } });
  const prisma = {
    pmProject: { findUniqueOrThrow: vi.fn().mockResolvedValue({ states: [{ id: "pending", group: "started" }], labels: [] }) },
    pmSupportChannel: { findFirst: vi.fn().mockResolvedValue({ emailAccountId: "account", emailAccount: { address: "support@example.test", authMode: "PASSWORD" } }) },
    pmComment: { findFirst: vi.fn().mockResolvedValue({ id: "comment", commentHtml: "<p>Reply</p>" }) },
    pmTicketEmailLink: { findFirst: vi.fn().mockResolvedValue({ emailThreadId: "thread" }) },
    $transaction: vi.fn(async (...[callback, options]: Parameters<typeof seam.$transaction>) =>
      seam.$transaction(async (client) => {
        const result = await callback(client);
        expect(nudgeOutbox).not.toHaveBeenCalled();
        if (rejectCommit) throw new Error("commit failed");
        return result;
      }, options),
    ),
  };
  return { prisma, tx, comments, activity, drafts, links };
}

const send = (f: ReturnType<typeof fixture>) => addReply(f.prisma as never, VIEWER, "ticket", {
  bodyHtml: "<p>We are on it.</p>", stateId: "pending",
}, CONTEXT, { now: () => NOW });

beforeEach(() => vi.clearAllMocks());

describe("reply activity wakes the shared outbox after commit", () => {
  it("records an unavailable delivery without queuing a reply for a legacy Graph channel", async () => {
    const f = fixture();
    f.prisma.pmSupportChannel.findFirst.mockResolvedValueOnce({ emailAccountId: "account", emailAccount: { address: "support@example.test", authMode: "M365_GRAPH" } });
    const result = await send(f);
    expect(result.entry.deliveryStatus).toBe("FAILED");
    expect(result.entry.deliveryFailure).toBe("EMAIL_UNAVAILABLE");
    expect(f.drafts).toHaveLength(0);
    expect(f.links).toHaveLength(0);
  });

  it("refuses retry on a read-only Graph channel before changing the comment", async () => {
    const f = fixture();
    f.prisma.pmSupportChannel.findFirst.mockResolvedValueOnce({ emailAccountId: "account", emailAccount: { address: "support@example.test", authMode: "M365_GRAPH" } });
    await expect(retryPublicReply(f.prisma as never, "ticket", "comment")).rejects.toThrow("email_account_read_only");
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
    expect(f.tx.emailDraft.create).not.toHaveBeenCalled();
  });

  it("wakes once after the state, reply, draft and message link commit", async () => {
    const f = fixture();
    await send(f);
    expect(f.activity).toHaveLength(2);
    expect(f.comments).toHaveLength(1);
    expect(f.drafts).toHaveLength(1);
    expect(f.links).toHaveLength(1);
    expect(nudgeOutbox).toHaveBeenCalledTimes(1);
  });

  it("does not wake when commit rolls back the reply and email records", async () => {
    const f = fixture(true);
    await expect(send(f)).rejects.toThrow("commit failed");
    expect(f.activity).toHaveLength(0);
    expect(f.comments).toHaveLength(0);
    expect(f.drafts).toHaveLength(0);
    expect(f.links).toHaveLength(0);
    expect(nudgeOutbox).not.toHaveBeenCalled();
  });

  it("does not wake when the draft fails after the state and reply activity writes", async () => {
    const f = fixture();
    f.tx.emailDraft.create.mockRejectedValueOnce(new Error("draft failed"));
    await expect(send(f)).rejects.toThrow("draft failed");
    expect(f.activity).toHaveLength(0);
    expect(f.comments).toHaveLength(0);
    expect(nudgeOutbox).not.toHaveBeenCalled();
  });
});
