/** WARP-3529 — message intake, its idempotence, and the queued acknowledgement
 * are exercised against Postgres so a mocked Prisma transaction cannot hide a
 * ticket without its link or a consumed message with no ticket. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { addReply } from "../services/support/conversation.service.js";
import { updateTicket } from "../services/support/ticket.service.js";
import { grants } from "./helpers/support-routes.js";

vi.unmock("@prisma/client");
vi.mock("../services/off-lan-gate.service.js", () => ({ outboundEmailGate: vi.fn().mockResolvedValue(true) }));
vi.mock("../services/notifications.service.js", () => ({ notifyOwnersAndAdmins: vi.fn().mockResolvedValue({ notified: [], failed: [] }) }));

const RUN = process.env.RUN_PG_INTEGRATION === "1" && Boolean(process.env.DATABASE_URL);
const PREFIX = "warp3529e-";

describe.skipIf(!RUN)("service desk email intake (WARP-3529)", () => {
  let prisma: PrismaClient;
  let intake: typeof import("../services/support/email-intake.service.js");
  let ownerId = "";
  let deskId = "";
  let accountId = "";
  let threadId = "";
  let ticketId = "";
  let firstMessageId = "";
  let ackMessageId = "";

  beforeAll(async () => {
    const { PrismaClient: RealPrismaClient } = await vi.importActual<typeof import("@prisma/client")>("@prisma/client");
    prisma = new RealPrismaClient();
    await prisma.$connect();
    intake = await import("../services/support/email-intake.service.js");
  });

  async function cleanup() {
    await prisma.pmProject.deleteMany({ where: { name: { startsWith: PREFIX } } });
    await prisma.emailAccount.deleteMany({ where: { address: { startsWith: PREFIX } } });
    await prisma.pmWorkspace.deleteMany({ where: { slug: { startsWith: PREFIX } } });
    await prisma.contact.deleteMany({ where: { displayName: { startsWith: PREFIX } } });
    await prisma.user.deleteMany({ where: { username: { startsWith: PREFIX } } });
  }

  afterAll(async () => { await cleanup(); await prisma.$disconnect(); });

  beforeEach(async () => {
    await cleanup();
    const owner = await prisma.user.create({ data: { username: `${PREFIX}owner`, displayName: `${PREFIX}owner`, role: "owner" } });
    ownerId = owner.id;
    const workspace = await prisma.pmWorkspace.create({ data: { slug: `${PREFIX}ws`, name: `${PREFIX}ws` } });
    const desk = await prisma.pmProject.create({ data: { workspaceId: workspace.id, name: `${PREFIX}desk`, identifier: "EML", kind: "SERVICE_DESK", createdById: ownerId } });
    deskId = desk.id;
    await prisma.pmState.createMany({ data: [
      { projectId: deskId, name: "New", group: "unstarted", isDefault: true, slaClock: "RUNNING", onCustomerReply: "NONE" },
      { projectId: deskId, name: "Open", group: "started", slaClock: "RUNNING", onCustomerReply: "NONE" },
      { projectId: deskId, name: "Pending", group: "started", slaClock: "PAUSED", onCustomerReply: "REOPEN" },
      { projectId: deskId, name: "Solved", group: "completed", slaClock: "STOPPED", onCustomerReply: "REOPEN" },
      { projectId: deskId, name: "Closed", group: "completed", slaClock: "STOPPED", onCustomerReply: "FOLLOW_UP" },
    ] });
    const account = await prisma.emailAccount.create({ data: {
      userId: ownerId, displayName: "Support", address: `${PREFIX}support@example.test`,
      imapHost: "imap.example.test", smtpHost: "smtp.example.test", username: "support", passwordEnc: "test-ciphertext",
    } });
    accountId = account.id;
    await prisma.pmSupportChannel.create({ data: {
      projectId: deskId, emailAccountId: accountId, contactOwnerUserId: ownerId,
      enabled: true, enabledAt: new Date("2026-01-01T00:00:00Z"), autoAckEnabled: true,
      autoAckTemplate: "Hello {{requester.firstName}}, ticket {{ticket.key}} is open.",
    } });
    const thread = await prisma.emailThread.create({ data: {
      accountId, threadKey: "customer-root@example.test", subject: "Printer offline",
      lastMessageAt: new Date("2026-10-01T10:00:00Z"),
    } });
    threadId = thread.id;
    firstMessageId = "customer-root@example.test";
    const message = await prisma.emailMessage.create({ data: {
      accountId, threadId, messageId: firstMessageId, fromAddr: "dana@example.test", fromName: `${PREFIX}Dana Reyes`,
      toAddrs: [`${PREFIX}support@example.test`], subject: "Printer offline", bodyText: "The printer is down.",
      receivedAt: new Date("2026-10-01T10:00:00Z"),
      headers: { references: [], autoSubmitted: "no", precedence: null, xAutoreply: null, xAutorespond: null, returnPath: "dana@example.test", reportType: null },
    } });
    firstMessageId = message.messageId;
    ticketId = "";
    ackMessageId = "";
  });

  it("creates one ticket, links the acknowledgement, and threads the customer reply back to it", async () => {
    const now = new Date("2026-10-01T10:01:00Z");
    await intake.intakeEmailMessage(prisma, accountId, firstMessageId, now);
    const ticket = await prisma.pmTicket.findFirstOrThrow({ where: { channel: "EMAIL", requesterEmail: "dana@example.test" }, include: { workItem: true } });
    ticketId = ticket.workItemId;
    expect(ticket.workItem.name).toBe("Printer offline");
    expect(ticket.workItem.descriptionHtml).toContain("The printer is down.");
    expect(await prisma.pmTicketEmailLink.count({ where: { workItemId: ticketId, direction: "INBOUND" } })).toBe(1);
    const ackLink = await prisma.pmTicketEmailLink.findFirstOrThrow({ where: { workItemId: ticketId, direction: "OUTBOUND" } });
    const ack = await prisma.emailDraft.findUniqueOrThrow({ where: { id: ackLink.emailDraftId! } });
    expect(ack.status).toBe("queued");
    expect(ack.autoSubmitted).toBe(true);
    expect(ack.body).toContain("EML-1");
    ackMessageId = ack.messageId!;

    const repeated = await prisma.emailMessage.create({ data: {
      accountId, threadId, messageId: "customer-reply@example.test", inReplyTo: ackMessageId,
      fromAddr: "dana@example.test", fromName: `${PREFIX}Dana Reyes`, toAddrs: [`${PREFIX}support@example.test`],
      subject: "Re: [EML-1] Printer offline", bodyText: "I have another detail.",
      receivedAt: new Date("2026-10-01T10:02:00Z"),
      headers: { references: [firstMessageId, ackMessageId], autoSubmitted: "no", precedence: null, xAutoreply: null, xAutorespond: null, returnPath: "dana@example.test", reportType: null },
    } });
    await intake.intakeEmailMessage(prisma, accountId, repeated.messageId, new Date("2026-10-01T10:03:00Z"));
    await intake.intakeEmailMessage(prisma, accountId, repeated.messageId, new Date("2026-10-01T10:04:00Z"));
    expect(await prisma.pmTicket.count({ where: { workItemId: ticketId } })).toBe(1);
    expect(await prisma.pmComment.count({ where: { workItemId: ticketId, authorKind: "CONTACT", visibility: "PUBLIC" } })).toBe(1);
    expect(await prisma.pmTicketEmailLink.count({ where: { workItemId: ticketId, emailMessageId: repeated.id } })).toBe(1);
    expect((await prisma.emailMessage.findUniqueOrThrow({ where: { id: repeated.id } })).deskIntakeStatus).toBe("DONE");
  });

  const ctx = { canReadProjects: false, canReadCrm: false };
  const access = { resolveAccess: async () => grants([["support", "act"]]) };
  const viewer = () => ({ id: ownerId, role: "owner" as const });
  async function enableSla() {
    await prisma.pmSlaPolicy.create({ data: { projectId: deskId, targets: { none: { firstResponseMins: 60, nextResponseMins: 30, resolutionMins: 240 } } } });
  }
  async function inboundReply(messageId = "sla-customer-reply@example.test", receivedAt = new Date("2026-10-01T10:10:00Z")) {
    return prisma.emailMessage.create({ data: {
      accountId, threadId, messageId, inReplyTo: firstMessageId, fromAddr: "dana@example.test", fromName: `${PREFIX}Dana Reyes`,
      toAddrs: [`${PREFIX}support@example.test`], subject: "Re: [EML-1] Printer offline", bodyText: "Here is the detail.", receivedAt,
      headers: { references: [firstMessageId], autoSubmitted: "no", precedence: null, xAutoreply: null, xAutorespond: null, returnPath: "dana@example.test", reportType: null },
    } });
  }
  async function emailTicket() {
    return prisma.pmTicket.findFirstOrThrow({ where: { channel: "EMAIL", requesterEmail: "dana@example.test" }, include: { workItem: true } });
  }
  it("starts an assigned email ticket's promise at receipt rather than delayed processing or retry time", async () => {
    await enableSla();
    await prisma.pmAssignmentRule.create({ data: { projectId: deskId, mode: "ROUND_ROBIN", memberIds: [ownerId] } });
    await intake.intakeEmailMessage(prisma, accountId, firstMessageId, new Date("2026-10-01T12:00:00Z"), access);
    const ticket = await emailTicket();
    expect(ticket.workItem.createdAt.toISOString()).toBe("2026-10-01T10:00:00.000Z");
    expect(ticket.firstResponseDueAt?.toISOString()).toBe("2026-10-01T11:00:00.000Z");
    expect(ticket.firstRespondedAt).toBeNull(); // An automatic acknowledgement is not a staff response.
    expect((await prisma.pmWorkItemAssignee.findMany({ where: { workItemId: ticket.workItemId } })).map((a) => a.userId)).toEqual([ownerId]);
    await intake.intakeEmailMessage(prisma, accountId, firstMessageId, new Date("2026-10-01T13:00:00Z"), access);
    expect((await emailTicket()).firstResponseDueAt?.toISOString()).toBe("2026-10-01T11:00:00.000Z");
    expect(await prisma.pmTicketEmailLink.count({ where: { emailMessage: { messageId: firstMessageId } } })).toBe(1);
  });
  it("starts the next-response promise at the customer message's immutable timestamp without resetting it on replay", async () => {
    await enableSla();
    await intake.intakeEmailMessage(prisma, accountId, firstMessageId, new Date("2026-10-01T10:01:00Z"));
    const ticket = await emailTicket();
    await addReply(prisma, viewer(), ticket.workItemId, { bodyHtml: "Checking now." }, ctx, { ...access, now: () => new Date("2026-10-01T10:05:00Z") });
    const message = await inboundReply();
    await intake.intakeEmailMessage(prisma, accountId, message.messageId, new Date("2026-10-01T11:00:00Z"));
    expect((await emailTicket()).nextResponseDueAt?.toISOString()).toBe("2026-10-01T10:40:00.000Z");
    expect((await prisma.pmComment.findFirstOrThrow({ where: { workItemId: ticket.workItemId, authorKind: "CONTACT" } })).createdAt).toEqual(message.receivedAt);
    await intake.intakeEmailMessage(prisma, accountId, message.messageId, new Date("2026-10-01T12:00:00Z"));
    expect((await emailTicket()).nextResponseDueAt?.toISOString()).toBe("2026-10-01T10:40:00.000Z");
    expect(await prisma.pmComment.count({ where: { workItemId: ticket.workItemId, authorKind: "CONTACT" } })).toBe(1);
  });
  it("excludes the pause before a received customer message from that message's next-response clock", async () => {
    await enableSla();
    await intake.intakeEmailMessage(prisma, accountId, firstMessageId, new Date("2026-10-01T10:01:00Z"));
    const ticket = await emailTicket();
    await addReply(prisma, viewer(), ticket.workItemId, { bodyHtml: "Waiting for your detail." }, ctx, { ...access, now: () => new Date("2026-10-01T10:05:00Z") });
    const pending = await prisma.pmState.findFirstOrThrow({ where: { projectId: deskId, name: "Pending" } });
    const open = await prisma.pmState.findFirstOrThrow({ where: { projectId: deskId, name: "Open" } });
    await updateTicket(prisma, viewer(), ticket.workItemId, { stateId: pending.id }, ctx, { ...access, now: () => new Date("2026-10-01T10:06:00Z") });
    const message = await inboundReply();
    await intake.intakeEmailMessage(prisma, accountId, message.messageId, new Date("2026-10-01T10:20:00Z"));
    expect((await emailTicket()).slaStatus).toBe("PAUSED");
    await updateTicket(prisma, viewer(), ticket.workItemId, { stateId: open.id }, ctx, { ...access, now: () => new Date("2026-10-01T11:00:00Z") });
    expect((await emailTicket()).nextResponseDueAt?.toISOString()).toBe("2026-10-01T11:30:00.000Z");
  });
  it("rolls back ticket creation, assignment, activities and links if the transactional clock cannot be saved", async () => {
    await enableSla();
    await prisma.pmAssignmentRule.create({ data: { projectId: deskId, mode: "ROUND_ROBIN", memberIds: [ownerId] } });
    const failing = prisma.$extends({ query: { pmTicket: { async update({ args, query }) {
      if (args.data.slaTargets !== undefined) throw new Error("injected SLA write failure");
      return query(args);
    } } } });
    await expect(intake.intakeEmailMessage(failing as unknown as PrismaClient, accountId, firstMessageId, new Date("2026-10-01T12:00:00Z"), access)).rejects.toThrow("injected SLA write failure");
    expect(await prisma.pmWorkItem.count({ where: { projectId: deskId } })).toBe(0);
    expect((await prisma.pmProject.findUniqueOrThrow({ where: { id: deskId } })).seqCounter).toBe(0);
    expect((await prisma.pmAssignmentRule.findUniqueOrThrow({ where: { projectId: deskId } })).lastAssignedUserId).toBeNull();
    expect(await prisma.pmActivity.count({ where: { workItem: { projectId: deskId } } })).toBe(0);
    expect(await prisma.pmTicketEmailLink.count({ where: { emailMessage: { messageId: firstMessageId } } })).toBe(0);
    expect((await prisma.emailMessage.findUniqueOrThrow({ where: { accountId_messageId: { accountId, messageId: firstMessageId } } })).deskIntakeStatus).toBe("FAILED");
    await intake.intakeEmailMessage(prisma, accountId, firstMessageId, new Date("2026-10-01T13:00:00Z"), access);
    expect((await emailTicket()).firstResponseDueAt?.toISOString()).toBe("2026-10-01T11:00:00.000Z");
  });
  it("rolls back the requester reply and inbound link with a failed clock update, then retries once", async () => {
    await enableSla();
    await intake.intakeEmailMessage(prisma, accountId, firstMessageId, new Date("2026-10-01T10:01:00Z"));
    const ticket = await emailTicket();
    await addReply(prisma, viewer(), ticket.workItemId, { bodyHtml: "Checking now." }, ctx, { ...access, now: () => new Date("2026-10-01T10:05:00Z") });
    const message = await inboundReply();
    const failing = prisma.$extends({ query: { pmTicket: { async update({ args, query }) {
      if (args.data.slaTargets !== undefined) throw new Error("injected requester clock failure");
      return query(args);
    } } } });
    await expect(intake.intakeEmailMessage(failing as unknown as PrismaClient, accountId, message.messageId, new Date("2026-10-01T11:00:00Z"))).rejects.toThrow("injected requester clock failure");
    expect(await prisma.pmComment.count({ where: { workItemId: ticket.workItemId, authorKind: "CONTACT" } })).toBe(0);
    expect(await prisma.pmActivity.count({ where: { workItemId: ticket.workItemId, verb: "commented", actorId: null } })).toBe(0);
    expect(await prisma.pmTicketEmailLink.count({ where: { emailMessageId: message.id } })).toBe(0);
    expect((await emailTicket()).nextResponseDueAt).toBeNull();
    await intake.intakeEmailMessage(prisma, accountId, message.messageId, new Date("2026-10-01T12:00:00Z"));
    expect((await emailTicket()).nextResponseDueAt?.toISOString()).toBe("2026-10-01T10:40:00.000Z");
    expect(await prisma.pmComment.count({ where: { workItemId: ticket.workItemId, authorKind: "CONTACT" } })).toBe(1);
    expect(await prisma.pmTicketEmailLink.count({ where: { emailMessageId: message.id } })).toBe(1);
  });
});
