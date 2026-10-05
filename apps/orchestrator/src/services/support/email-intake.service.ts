/**
 * WARP-3529: the email-indexer has already committed an EmailMessage when this
 * service is called. The ledger on that immutable message makes retries safe;
 * the ticket, comment, link and final ledger state commit together.
 */
import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { writeActivity } from "../pm/pm.service.js";
import { outboundEmailGate } from "../off-lan-gate.service.js";
import { notifyOwnersAndAdmins } from "../notifications.service.js";
import { classifyInbound, parseStoredHeaders, referenceCandidates, ticketTokens, cleanTicketSubject } from "./email-headers.js";
import { inboundBodyHtml } from "./email-text.js";
import { DEFAULT_ACK_TEMPLATE, renderAckTemplate } from "./ack-template.js";
import { assignNewTicket } from "./assignment.service.js";
import { lockTicketClock, syncTicketSla } from "./sla-clock.service.js";
import { applyStateChange, findTicketRow } from "./ticket.service.js";
import type { SupportDeps } from "./requester.service.js";

type Tx = Prisma.TransactionClient;
const MAX_PER_SENDER_PER_HOUR = 20;
const REOPEN_MS_PER_DAY = 86_400_000;

function noReplyAddress(address: string): boolean {
  const local = address.trim().toLowerCase().split("@")[0] ?? "";
  return /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer-daemon|postmaster|bounces?)(?:[+._-].*)?$/.test(local);
}

function senderName(name: string | null, address: string): { displayName: string; givenName: string | null } {
  const clean = (name ?? "").replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
  if (!clean || clean.includes("@")) return { displayName: address, givenName: null };
  const givenName = clean.includes(",") ? null : clean.split(" ")[0] || null;
  return { displayName: clean, givenName };
}

async function finish(tx: Tx, messageId: string, status: "DONE" | "IGNORED", reason: string | null, at: Date) {
  await tx.emailMessage.update({
    where: { id: messageId },
    data: { deskIntakeStatus: status, deskIntakeReason: reason as never, deskIntakeAt: at },
  });
}

async function contactForSender(tx: Tx, ownerId: string, fromAddr: string, fromName: string | null) {
  const addressLower = fromAddr.trim().toLowerCase();
  const found = await tx.contactEmail.findFirst({
    where: { addressLower, contact: { userId: ownerId, isArchived: false } },
    orderBy: [{ isPrimary: "desc" }, { contactId: "asc" }],
    select: { contact: { select: { id: true, displayName: true, givenName: true, organization: true } } },
  });
  if (found) return found.contact;

  const name = senderName(fromName, fromAddr);
  // ContactEmail is intentionally not unique across owners. The intake owner is
  // explicit on PmSupportChannel, so a sender only reuses that owner's record.
  const contact = await tx.contact.create({
    data: {
      userId: ownerId,
      origin: "EXTRACTED",
      displayName: name.displayName,
      givenName: name.givenName,
      emails: { create: [{ address: fromAddr.trim(), addressLower, isPrimary: true }] },
    },
    select: { id: true, displayName: true, givenName: true, organization: true },
  });
  return contact;
}

async function matchedTicket(tx: Tx, facts: {
  accountId: string;
  inReplyTo: string | null;
  references: string[];
  subject: string;
}): Promise<any | null> {
  const ids = referenceCandidates(facts.inReplyTo, facts.references);
  if (ids.length) {
    const link = await tx.pmTicketEmailLink.findFirst({
      where: {
        messageIdHeader: { in: ids },
        ticket: { workItem: { project: { supportChannels: { some: { emailAccountId: facts.accountId } } } } },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      include: { ticket: { include: { workItem: { include: { project: true, state: true } } } } },
    });
    if (link) return link.ticket.workItem;
  }
  const tokens = ticketTokens(facts.subject);
  if (tokens.length === 0) return null;
  // The mailbox scopes fallback lookup. A syntactically valid ticket key from
  // another desk must never move an email into that desk.
  for (const token of tokens) {
    const row = await tx.pmWorkItem.findFirst({
      where: {
        sequenceId: token.sequenceId,
        project: {
          identifier: token.identifier,
          kind: "SERVICE_DESK",
          supportChannels: { some: { emailAccountId: facts.accountId } },
        },
        ticket: { isNot: null },
      },
      include: { project: true, state: true, ticket: true },
    });
    if (row) return row;
  }
  return null;
}

async function queueAutoAck(tx: Tx, channel: any, ticket: any, requester: any, message: any, now: Date, headersChecked: boolean) {
  if (!channel.autoAckEnabled || !headersChecked || !ticket.ticket.requesterEmail || noReplyAddress(ticket.ticket.requesterEmail)) return;
  const body = renderAckTemplate(channel.autoAckTemplate || DEFAULT_ACK_TEMPLATE, {
    requesterName: requester.displayName,
    requesterGivenName: requester.givenName,
    ticketKey: `${ticket.project.identifier}-${ticket.sequenceId}`,
    ticketTitle: ticket.name,
    deskName: ticket.project.name,
  });
  const id = randomUUID();
  const domain = String(channel.emailAccount.address).split("@").at(-1) || "localhost";
  const messageId = `${id}@${domain}`;
  const subject = `[${ticket.project.identifier}-${ticket.sequenceId}] ${cleanTicketSubject(ticket.name)}`;
  const comment = await tx.pmComment.create({
    data: { workItemId: ticket.id, authorKind: "SYSTEM", visibility: "PUBLIC", commentHtml: body.html, deliveryStatus: "PENDING" },
  });
  const draft = await tx.emailDraft.create({
    data: {
      accountId: channel.emailAccountId,
      threadId: message.threadId,
      toAddrs: [ticket.ticket.requesterEmail] as Prisma.InputJsonValue,
      subject,
      body: body.text,
      draftedByDroplet: true,
      status: "queued",
      messageId,
      autoSubmitted: true,
    },
  });
  await tx.pmTicketEmailLink.create({
    data: { workItemId: ticket.id, direction: "OUTBOUND", messageIdHeader: messageId, emailThreadId: message.threadId, emailDraftId: draft.id, commentId: comment.id },
  });
  await tx.pmTicket.update({ where: { workItemId: ticket.id }, data: { lastPublicActivityAt: now } });
}

async function applyInbound(tx: Tx, message: any, channel: any, now: Date, deps: SupportDeps): Promise<boolean> {
  const senderKey = `support-email:${message.accountId}:${message.fromAddr.trim().toLowerCase()}`;
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${senderKey}, 0))`);
  const ownChannels = await tx.pmSupportChannel.findMany({ select: { emailAccount: { select: { address: true } } } });
  const ownAddresses = new Set(ownChannels.map((row) => row.emailAccount.address.trim().toLowerCase()));
  const headers = parseStoredHeaders(message.headers);
  const own = await tx.pmTicketEmailLink.findFirst({ where: { direction: "OUTBOUND", messageIdHeader: message.messageId }, select: { id: true } });
  const verdict = classifyInbound({ fromAddr: message.fromAddr, headers, ownAddresses, isOwnOutbound: !!own });
  if (verdict.kind === "ignore") {
    await finish(tx, message.id, "IGNORED", verdict.reason, now);
    return false;
  }

  if (noReplyAddress(message.fromAddr)) {
    await finish(tx, message.id, "IGNORED", "BOUNCE", now);
    return false;
  }
  const since = new Date(message.receivedAt.getTime() - 3_600_000);
  const recent = await tx.emailMessage.count({
    where: { accountId: message.accountId, fromAddr: { equals: message.fromAddr, mode: "insensitive" }, receivedAt: { gte: since, lte: message.receivedAt }, deskIntakeStatus: { in: ["DONE", "IGNORED"] } },
  });
  if (recent >= MAX_PER_SENDER_PER_HOUR) {
    const alreadyNotified = await tx.emailMessage.count({
      where: { accountId: message.accountId, fromAddr: { equals: message.fromAddr, mode: "insensitive" }, receivedAt: { gte: since, lte: message.receivedAt }, deskIntakeReason: "RATE_LIMITED" },
    });
    await finish(tx, message.id, "IGNORED", "RATE_LIMITED", now);
    return alreadyNotified === 0;
  }

  let oldTicket = await matchedTicket(tx, {
    accountId: message.accountId,
    inReplyTo: message.inReplyTo,
    references: headers?.references ?? [],
    subject: message.subject,
  });
  if (oldTicket) {
    // Staff replies, requester replies and clock ticks use the same row lock.
    // Re-read after it so a concurrent state change cannot reopen a stale state.
    await lockTicketClock(tx, oldTicket.id);
    oldTicket = await findTicketRow(tx, oldTicket.id);
  }
  const requester = await contactForSender(tx, channel.contactOwnerUserId, message.fromAddr, message.fromName);
  const bodyHtml = inboundBodyHtml(message.bodyHtml, message.bodyText);
  let ticket = oldTicket;
  let followUp = false;
  if (oldTicket) {
    if (oldTicket.state?.onCustomerReply === "FOLLOW_UP") followUp = true;
    if (oldTicket.state?.onCustomerReply === "REOPEN") {
      const solvedAt = oldTicket.ticket.solvedAt;
      if (solvedAt && message.receivedAt.getTime() - solvedAt.getTime() > channel.reopenWindowDays * REOPEN_MS_PER_DAY) followUp = true;
      else {
        const reopenState = await tx.pmState.findFirst({ where: { projectId: oldTicket.projectId, onCustomerReply: "REOPEN", group: "started" }, orderBy: [{ sortOrder: "asc" }, { id: "asc" }] });
        if (reopenState && reopenState.id !== oldTicket.stateId) {
          await applyStateChange(tx, oldTicket, reopenState, null, message.receivedAt, deps);
        }
      }
    }
  }
  if (!ticket || followUp) {
    const desk = channel.project;
    const states = await tx.pmState.findMany({ where: { projectId: desk.id }, orderBy: [{ sortOrder: "asc" }, { id: "asc" }] });
    const state = states.find((s) => s.isDefault) ?? states[0];
    if (!state) throw new Error("desk_has_no_states");
    const bumped = await tx.pmProject.update({ where: { id: desk.id }, data: { seqCounter: { increment: 1 } }, select: { seqCounter: true } });
    const assigneeIds = await assignNewTicket(tx, desk.id, null, deps);
    const created = await tx.pmWorkItem.create({
      data: {
        projectId: desk.id,
        sequenceId: bumped.seqCounter,
        name: cleanTicketSubject(message.subject),
        descriptionHtml: bodyHtml,
        stateId: state.id,
        priority: "none",
        createdById: channel.contactOwnerUserId,
        sortOrder: bumped.seqCounter,
        createdAt: message.receivedAt,
        updatedAt: message.receivedAt,
        assignees: { create: assigneeIds.map((userId) => ({ userId })) },
      },
      select: { id: true },
    });
    await tx.pmTicket.create({ data: { workItemId: created.id, requesterKind: "CONTACT", requesterContactId: requester.id, requesterUserId: null, requesterName: requester.displayName, requesterEmail: message.fromAddr, companyId: null, channel: "EMAIL", solvedAt: null } });
    // Retries must not grant more response time: the immutable inbound instant,
    // rather than the indexer's processing time, starts the promise.
    await syncTicketSla(tx, created.id, message.receivedAt, "create", deps);
    await writeActivity(tx, { workItemId: created.id, actorId: null, verb: "created" });
    ticket = await tx.pmWorkItem.findUniqueOrThrow({ where: { id: created.id }, include: { project: true, state: true, ticket: true } });
    if (oldTicket) {
      const [fromId, toId] = [oldTicket.id, ticket.id].sort();
      await tx.pmWorkItemRelation.create({ data: { fromId, toId, kind: "RELATES", createdById: null } });
      await writeActivity(tx, { workItemId: oldTicket.id, actorId: null, verb: "relation_added", field: "relation", newValue: `RELATES:${ticket.id}` });
      await writeActivity(tx, { workItemId: ticket.id, actorId: null, verb: "relation_added", field: "relation", newValue: `RELATES:${oldTicket.id}` });
    }
    if (bodyHtml) await tx.pmTicket.update({ where: { workItemId: ticket.id }, data: { lastPublicActivityAt: message.receivedAt } });
  } else if (bodyHtml) {
    const comment = await tx.pmComment.create({ data: { workItemId: ticket.id, contactId: requester.id, authorKind: "CONTACT", visibility: "PUBLIC", commentHtml: bodyHtml, createdAt: message.receivedAt } });
    await tx.pmTicket.update({ where: { workItemId: ticket.id }, data: { lastPublicActivityAt: message.receivedAt } });
    await tx.pmWorkItem.update({ where: { id: ticket.id }, data: { updatedAt: message.receivedAt } });
    await syncTicketSla(tx, ticket.id, message.receivedAt, "requester", deps);
    await writeActivity(tx, { workItemId: ticket.id, actorId: null, verb: "commented", field: "reply" });
    await tx.pmTicketEmailLink.create({ data: { workItemId: ticket.id, direction: "INBOUND", messageIdHeader: message.messageId, emailThreadId: message.threadId, emailMessageId: message.id, commentId: comment.id } });
  }
  if (!oldTicket || followUp || !bodyHtml) {
    await tx.pmTicketEmailLink.create({ data: { workItemId: ticket.id, direction: "INBOUND", messageIdHeader: message.messageId, emailThreadId: message.threadId, emailMessageId: message.id } });
  }
  await finish(tx, message.id, "DONE", null, now);
  if (!oldTicket || followUp) await queueAutoAck(tx, channel, ticket, requester, message, now, verdict.headersChecked);
  return false;
}

/** Process one committed message once. A channel bound later will only process
 * messages at or after enabledAt, so historical inbox mail never becomes tickets. */
export async function intakeEmailMessage(prisma: PrismaClient, accountId: string, messageId: string, now = new Date(), deps: SupportDeps = {}): Promise<void> {
  const message = await prisma.emailMessage.findUnique({ where: { accountId_messageId: { accountId, messageId } } });
  if (!message || !(message.deskIntakeStatus === "PENDING" || (message.deskIntakeStatus === "FAILED" && message.deskIntakeReason === "PROCESSING_ERROR"))) return;
  const channel = await prisma.pmSupportChannel.findUnique({ where: { emailAccountId: accountId }, include: { project: true, emailAccount: { select: { address: true } } } });
  if (!channel || !channel.enabled || message.receivedAt < channel.enabledAt) return;
  let mayAutoAck = false;
  try { mayAutoAck = await outboundEmailGate(prisma); } catch { mayAutoAck = false; }
  try {
    const notifyRateLimit = await prisma.$transaction(async (tx) => {
      if (message.deskIntakeStatus === "FAILED") {
        const reset = await tx.emailMessage.updateMany({
          where: { id: message.id, deskIntakeStatus: "FAILED", deskIntakeReason: "PROCESSING_ERROR" },
          data: { deskIntakeStatus: "PENDING", deskIntakeReason: null, deskIntakeAt: null },
        });
        if (!reset.count) return false;
      }
      // FAILED is used as a transaction-local claim marker. The row lock and
      // predicate recheck make a concurrent indexer retry a no-op; a rollback
      // restores PENDING, while finish() writes the durable terminal state.
      const claimed = await tx.emailMessage.updateMany({
        where: { id: message.id, deskIntakeStatus: "PENDING" },
        data: { deskIntakeAttempts: { increment: 1 }, deskIntakeStatus: "FAILED", deskIntakeReason: "PROCESSING_ERROR", deskIntakeAt: now },
      });
      if (!claimed.count) return false;
      return applyInbound(tx, { ...message, headers: message.headers }, { ...channel, autoAckEnabled: channel.autoAckEnabled && mayAutoAck }, now, deps);
    });
    if (notifyRateLimit) {
      await notifyOwnersAndAdmins(prisma, "Service desk email rate limited", "A sender exceeded the limit of 20 messages per hour. Further messages were ignored.");
    }
  } catch (error) {
    await prisma.emailMessage.updateMany({ where: { id: message.id, deskIntakeStatus: "PENDING" }, data: { deskIntakeStatus: "FAILED", deskIntakeReason: "PROCESSING_ERROR", deskIntakeAt: now } });
    throw error;
  }
}
