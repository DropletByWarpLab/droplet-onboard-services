/** WARP-3529 — message intake, its idempotence, and the queued acknowledgement
 * are exercised against Postgres so a mocked Prisma transaction cannot hide a
 * ticket without its link or a consumed message with no ticket. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

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
});
