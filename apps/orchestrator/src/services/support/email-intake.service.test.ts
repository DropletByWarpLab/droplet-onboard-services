import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTransactionSeam } from "../../__tests__/helpers/prisma-tx-harness.js";

vi.unmock("@prisma/client");
vi.mock("../pm/pm-outbox.js", () => ({ nudgeOutbox: vi.fn() }));
vi.mock("../off-lan-gate.service.js", () => ({ outboundEmailGate: vi.fn().mockResolvedValue(true) }));
vi.mock("../notifications.service.js", () => ({ notifyOwnersAndAdmins: vi.fn().mockResolvedValue(undefined) }));

import { nudgeOutbox } from "../pm/pm-outbox.js";
import { intakeEmailMessage } from "./email-intake.service.js";

const NOW = new Date("2026-10-05T12:00:00.000Z");

function fixture(opts: { autoReply?: boolean; claimed?: boolean; rejectCommit?: boolean } = {}) {
  const activity: unknown[] = [];
  const tickets: unknown[] = [];
  const links: unknown[] = [];
  const project = { id: "desk", name: "Support", identifier: "HELP" };
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    emailMessage: {
      updateMany: vi.fn().mockResolvedValue({ count: opts.claimed === false ? 0 : 1 }),
      update: vi.fn().mockResolvedValue({}),
      count: vi.fn().mockResolvedValue(0),
    },
    pmSupportChannel: { findMany: vi.fn().mockResolvedValue([]) },
    pmTicketEmailLink: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn(async ({ data }: { data: unknown }) => { links.push(data); return {}; }),
    },
    contactEmail: { findFirst: vi.fn().mockResolvedValue({ contact: { id: "contact", displayName: "Dana", givenName: "Dana" } }) },
    pmState: { findMany: vi.fn().mockResolvedValue([{ id: "new", isDefault: true }]) },
    pmProject: { update: vi.fn().mockResolvedValue({ seqCounter: 1 }) },
    pmWorkItem: {
      create: vi.fn(async ({ data }: { data: unknown }) => { tickets.push(data); return { id: "ticket" }; }),
      findUniqueOrThrow: vi.fn().mockResolvedValue({ id: "ticket", sequenceId: 1, name: "Printer offline", project, ticket: { requesterEmail: "dana@example.test" } }),
    },
    pmTicket: { create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}) },
    pmActivity: { create: vi.fn(async ({ data }: { data: unknown }) => { activity.push(data); return {}; }) },
  };
  const seam = createTransactionSeam({ client: () => tx, stores: { activity, tickets, links } });
  const prisma = {
    emailMessage: {
      findUnique: vi.fn().mockResolvedValue({
        id: "message", accountId: "account", messageId: "customer@example.test", threadId: "thread",
        deskIntakeStatus: "PENDING", receivedAt: NOW, fromAddr: "dana@example.test", fromName: "Dana",
        subject: "Printer offline", bodyText: "The printer is down.", bodyHtml: null, inReplyTo: null,
        headers: { references: [], autoSubmitted: opts.autoReply ? "auto-replied" : "no", precedence: null, xAutoreply: null, xAutorespond: null, returnPath: "dana@example.test", reportType: null },
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    pmSupportChannel: { findUnique: vi.fn().mockResolvedValue({
      project, emailAccountId: "account", emailAccount: { address: "support@example.test", authMode: "PASSWORD" },
      contactOwnerUserId: "owner", enabled: true, enabledAt: new Date(0), autoAckEnabled: false,
    }) },
    $transaction: vi.fn(async (...[callback, options]: Parameters<typeof seam.$transaction>) =>
      seam.$transaction(async (client) => {
        const result = await callback(client);
        expect(nudgeOutbox).not.toHaveBeenCalled();
        if (opts.rejectCommit) throw new Error("commit failed");
        return result;
      }, options),
    ),
  };
  return { prisma, tx, activity, tickets, links };
}

beforeEach(() => vi.clearAllMocks());

describe("email intake wakes the shared outbox after commit", () => {
  it("does not create tickets or automatic replies for a legacy read-only Graph channel", async () => {
    const f = fixture();
    const channel = await f.prisma.pmSupportChannel.findUnique();
    f.prisma.pmSupportChannel.findUnique.mockResolvedValueOnce({ ...channel, autoAckEnabled: true, emailAccount: { ...channel.emailAccount, authMode: "M365_GRAPH" } });
    await intakeEmailMessage(f.prisma as never, "account", "m365:immutable-provider-id", NOW);
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
    expect(f.tickets).toHaveLength(0);
    expect(f.links).toHaveLength(0);
  });

  it("wakes once after the ticket, message link and activity commit", async () => {
    const f = fixture();
    await intakeEmailMessage(f.prisma as never, "account", "customer@example.test", NOW);
    expect(f.tickets).toHaveLength(1);
    expect(f.links).toHaveLength(1);
    expect(f.activity).toHaveLength(1);
    expect(nudgeOutbox).toHaveBeenCalledTimes(1);
  });

  it.each([{ autoReply: true }, { claimed: false }])("does not wake when intake writes no activity: %j", async (opts) => {
    const f = fixture(opts);
    await intakeEmailMessage(f.prisma as never, "account", "customer@example.test", NOW);
    expect(f.activity).toHaveLength(0);
    expect(nudgeOutbox).not.toHaveBeenCalled();
  });

  it("does not wake when commit rolls back the ticket, link and activity", async () => {
    const f = fixture({ rejectCommit: true });
    await expect(intakeEmailMessage(f.prisma as never, "account", "customer@example.test", NOW)).rejects.toThrow("commit failed");
    expect(f.tickets).toHaveLength(0);
    expect(f.links).toHaveLength(0);
    expect(f.activity).toHaveLength(0);
    expect(nudgeOutbox).not.toHaveBeenCalled();
  });

  it("does not wake when the activity insertion fails", async () => {
    const f = fixture();
    f.tx.pmActivity.create.mockRejectedValueOnce(new Error("activity failed"));
    await expect(intakeEmailMessage(f.prisma as never, "account", "customer@example.test", NOW)).rejects.toThrow("activity failed");
    expect(f.tickets).toHaveLength(0);
    expect(nudgeOutbox).not.toHaveBeenCalled();
  });
});
