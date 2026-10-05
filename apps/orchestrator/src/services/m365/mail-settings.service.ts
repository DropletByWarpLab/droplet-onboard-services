/** Per-person read-only Outlook archive lifecycle. Connection lock always precedes mailbox lock. */
import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { GRAPH_RESOURCES, grantCovers } from "./graph-resources.js";
import { GRAPH_API_BASE_URL, GraphClient } from "./graph-client.js";
import { getAccessToken, type EntraClient } from "./m365-auth.service.js";
import type { M365GrantGeneration } from "./m365-contracts.js";

type Db = PrismaClient | Prisma.TransactionClient;
const MAIL_SETUP_ERROR = "Outlook email setup could not complete. Check the connection and try enabling email again.";
export interface MicrosoftMailView {
  enabled: boolean;
  state: "DISCONNECTED" | "WAITING" | "CONNECTED" | "NEEDS_RECONNECT" | "ERROR";
  needsConsent: boolean;
  lastSyncAt: Date | null;
  lastError: string | null;
  mailboxId: string | null;
  messageCount: number;
}
export function microsoftMailGranted(scopes: string | null | undefined): boolean {
  return grantCovers((scopes ?? "").split(/\s+/).filter(Boolean), GRAPH_RESOURCES.mail.leastPrivilegeScope);
}
export function microsoftMailViewOf(row: { mailEnabled?: boolean; mailSyncState?: MicrosoftMailView["state"]; grantedScopes?: string | null } | null,
  account?: { id: string; lastIdleAt: Date | null; lastError: string | null } | null, messageCount = 0): MicrosoftMailView {
  const enabled = row?.mailEnabled === true;
  return { enabled, state: row?.mailSyncState ?? "DISCONNECTED", needsConsent: enabled && !microsoftMailGranted(row?.grantedScopes),
    lastSyncAt: account?.lastIdleAt ?? null,
    lastError: account?.lastError ?? (enabled && row?.mailSyncState === "ERROR" ? MAIL_SETUP_ERROR : null), mailboxId: account?.id ?? null, messageCount };
}
export async function lockMicrosoftMailConnection(tx: Db, userId: string, generation?: M365GrantGeneration, cursorLinkHash?: string | null) {
  const locked = await tx.m365Connection.updateMany({ where: { userId, state: "CONNECTED", mailEnabled: true,
    ...(generation ? { tokenCacheEnc: generation.tokenCacheEnc, connectedAt: generation.connectedAt,
      cursorLinkHash: generation.cursorLinkHash, emailAccountId: generation.emailAccountId } : {}),
    ...(cursorLinkHash !== undefined ? { cursorLinkHash } : {}) }, data: { mailEnabled: true } });
  if (locked.count !== 1) return null;
  const row = await tx.m365Connection.findUnique({ where: { userId } });
  if (!row?.emailAccountId || !microsoftMailGranted(row.grantedScopes)) return null;
  const person = await tx.user.findFirst({ where: { id: userId, directoryStatus: "ACTIVE", deletionStatus: "NONE" }, select: { username: true } });
  if (!person) return null;
  const account = await tx.emailAccount.findFirst({ where: { id: row.emailAccountId, userId, authMode: "M365_GRAPH" } });
  return account ? { row, account, ownerUsername: person.username } : null;
}
export async function purgeMicrosoftMail(tx: Db, userId: string): Promise<void> {
  await tx.m365Connection.updateMany({ where: { userId }, data: { mailEnabled: false, mailSyncState: "DISCONNECTED" } });
  const row = await tx.m365Connection.findUnique({ where: { userId }, select: { emailAccountId: true } });
  if (row?.emailAccountId) await tx.emailAccount.deleteMany({ where: { id: row.emailAccountId, userId, authMode: "M365_GRAPH" } });
  await tx.m365Connection.updateMany({ where: { userId }, data: { emailAccountId: null } });
  await tx.m365DeltaCursor.deleteMany({ where: { userId, workload: "mail" } });
}
export class MicrosoftMailUnavailableError extends Error {
  constructor() { super("The Outlook mailbox is unavailable. Check the connection and try again."); this.name = "MicrosoftMailUnavailableError"; }
}
export class MicrosoftMailboxConflictError extends Error {
  constructor() { super("This email address already has a mailbox in Droplet. Remove that mailbox before importing it through Outlook."); this.name = "MicrosoftMailboxConflictError"; }
}
export async function setMicrosoftMailEnabled(prisma: PrismaClient, userId: string, enabled: boolean, entra: EntraClient, client = new GraphClient()) {
  if (!enabled) { await prisma.$transaction((tx) => purgeMicrosoftMail(tx, userId)); return true; }
  const before = await prisma.m365Connection.findUnique({ where: { userId } });
  if (before?.state !== "CONNECTED") return false;
  // Record the explicit choice before any network wait. Otherwise an OFF
  // during /me would leave the original false/null values unchanged and an
  // old ON could create a mailbox after the person had cancelled it.
  const optedIn = await prisma.$transaction(async (tx) => {
    const result = await tx.m365Connection.updateMany({ where: { userId, state: "CONNECTED", tokenCacheEnc: before.tokenCacheEnc,
      cursorLinkHash: before.cursorLinkHash, connectedAt: before.connectedAt, emailAccountId: before.emailAccountId, mailEnabled: before.mailEnabled },
      data: { mailEnabled: true } });
    if (result.count !== 1) return false;
    const person = await tx.user.findFirst({ where: { id: userId, directoryStatus: "ACTIVE", deletionStatus: "NONE" }, select: { id: true } });
    if (!person) throw new MicrosoftMailUnavailableError();
    await tx.m365Connection.updateMany({ where: { userId, state: "CONNECTED", mailEnabled: true }, data: {
      mailSyncState: !microsoftMailGranted(before.grantedScopes) ? "NEEDS_RECONNECT"
        : before.mailEnabled && before.emailAccountId ? before.mailSyncState : "WAITING",
    } });
    return true;
  });
  if (!optedIn) return false;
  // A missing scope records the choice without reading any mailbox data.
  if (!microsoftMailGranted(before.grantedScopes)) return true;
  let generation: M365GrantGeneration | undefined;
  try {
  const token = await getAccessToken(prisma, entra, userId, new Date(), (value) => { generation = value; });
  if (!generation || generation.mailEnabled !== true) return false;
  // UPN is not necessarily the Exchange primary address; resolve the actual mailbox.
  const profile = (await client.getPage(`${GRAPH_API_BASE_URL}/me?$select=mail,displayName`, token)).raw;
  const address = z.string().email().max(254).safeParse(profile.mail);
  if (!address.success || !generation) throw new MicrosoftMailUnavailableError();
  const grant = generation;
  return await prisma.$transaction(async (tx) => {
    const locked = await tx.m365Connection.updateMany({ where: { userId, state: "CONNECTED", tokenCacheEnc: grant.tokenCacheEnc,
      cursorLinkHash: grant.cursorLinkHash, connectedAt: grant.connectedAt, mailEnabled: grant.mailEnabled, emailAccountId: grant.emailAccountId }, data: { mailEnabled: true } });
    if (locked.count !== 1) return false;
    const person = await tx.user.findFirst({ where: { id: userId, directoryStatus: "ACTIVE", deletionStatus: "NONE" }, select: { id: true } });
    if (!person) throw new MicrosoftMailUnavailableError();
    const row = await tx.m365Connection.findUnique({ where: { userId } });
    if (!row || !microsoftMailGranted(row.grantedScopes)) throw new MicrosoftMailUnavailableError();
    const existing = row.emailAccountId ? await tx.emailAccount.findFirst({ where: { id: row.emailAccountId, userId, authMode: "M365_GRAPH" } }) : null;
    if (row.emailAccountId && !existing || existing && existing.address.toLowerCase() !== address.data.toLowerCase()) throw new MicrosoftMailboxConflictError();
    const duplicate = await tx.emailAccount.findFirst({ where: { address: { equals: address.data, mode: "insensitive" } }, select: { id: true } });
    if (duplicate && duplicate.id !== existing?.id) throw new MicrosoftMailboxConflictError();
    const account = existing ?? await tx.emailAccount.create({ data: { userId, address: address.data.toLowerCase(), username: address.data,
      displayName: "Outlook email", authMode: "M365_GRAPH", passwordEnc: null, imapHost: "", smtpHost: "", imapStatus: "paused" } });
    if (!existing) await tx.m365DeltaCursor.deleteMany({ where: { userId, workload: "mail" } });
    await tx.m365Connection.updateMany({ where: { userId, state: "CONNECTED", mailEnabled: true }, data: {
      emailAccountId: account.id, mailSyncState: existing && row.mailEnabled ? row.mailSyncState : "WAITING" } });
    return true;
  });
  } catch (error) {
    // Provider messages never enter status. A delayed failure affects only
    // this grant and cannot downgrade an OFF or a newer consent attempt.
    if (generation) await prisma.m365Connection.updateMany({ where: { userId, state: "CONNECTED", mailEnabled: true,
      tokenCacheEnc: generation.tokenCacheEnc, cursorLinkHash: generation.cursorLinkHash, connectedAt: generation.connectedAt,
      emailAccountId: generation.emailAccountId, mailSyncState: { not: "NEEDS_RECONNECT" } }, data: { mailSyncState: "ERROR" } });
    throw error;
  }
}
export async function ensureMicrosoftMailFolder(prisma: PrismaClient, userId: string, folderId: string, generation?: M365GrantGeneration) {
  return prisma.$transaction(async (tx) => {
    const owner = await lockMicrosoftMailConnection(tx, userId, generation);
    if (!owner) return false;
    await tx.m365MailFolder.upsert({ where: { accountId_folderId: { accountId: owner.account.id, folderId } },
      create: { accountId: owner.account.id, folderId }, update: {} });
    await tx.m365DeltaCursor.upsert({ where: { userId_workload_resourceId: { userId, workload: "mail", resourceId: folderId } },
      create: { userId, workload: "mail", resourceId: folderId, state: "IDLE" }, update: {} });
    return true;
  });
}
export async function recordMicrosoftMailFailure(prisma: PrismaClient, userId: string, reconnect: boolean, generation?: M365GrantGeneration) {
  await prisma.$transaction(async (tx) => {
    const owner = await lockMicrosoftMailConnection(tx, userId, generation);
    if (!owner) return;
    await tx.m365Connection.updateMany({ where: { userId, mailEnabled: true }, data: { mailSyncState: reconnect ? "NEEDS_RECONNECT" : "ERROR" } });
    await tx.emailAccount.updateMany({ where: { id: owner.account.id, userId, authMode: "M365_GRAPH" }, data: {
      lastError: reconnect ? "Reconnect Outlook to resume importing emails." : "Outlook email import could not complete. It will retry.", lastErrorAt: new Date() } });
  });
}
