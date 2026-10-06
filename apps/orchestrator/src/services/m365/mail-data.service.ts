/** Outlook archive views and purge operations shared with grant lifecycle. */
import type { Prisma, PrismaClient } from "@prisma/client";
import { GRAPH_RESOURCES, grantCovers } from "./graph-resources.js";
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
export async function purgeMicrosoftMail(tx: Db, userId: string): Promise<void> {
  await tx.m365Connection.updateMany({ where: { userId }, data: { mailEnabled: false, mailSyncState: "DISCONNECTED" } });
  const row = await tx.m365Connection.findUnique({ where: { userId }, select: { emailAccountId: true } });
  if (row?.emailAccountId) await tx.emailAccount.deleteMany({ where: { id: row.emailAccountId, userId, authMode: "M365_GRAPH" } });
  await tx.m365Connection.updateMany({ where: { userId }, data: { emailAccountId: null } });
  await tx.m365DeltaCursor.deleteMany({ where: { userId, workload: "mail" } });
}
