import type { PrismaClient } from "@prisma/client";
import { ACK_TEMPLATE_MAX, DEFAULT_ACK_TEMPLATE, checkAckTemplate } from "./ack-template.js";

export const EMAIL_CHANNEL_ERRORS = {
  DESK_NOT_FOUND: "desk_not_found",
  ACCOUNT_NOT_FOUND: "email_account_not_found",
  ACCOUNT_READ_ONLY: "email_account_read_only",
  CONTACT_OWNER_NOT_FOUND: "contact_owner_not_found",
  EMAIL_MODULE_DISABLED: "email_module_disabled",
  INVALID_TEMPLATE: "invalid_auto_ack_template",
} as const;

export async function listDeskEmailAccounts(prisma: PrismaClient) {
  return prisma.emailAccount.findMany({
    where: { authMode: { in: ["PASSWORD", "GOOGLE_OAUTH"] } },
    select: { id: true, address: true, displayName: true },
    orderBy: [{ address: "asc" }, { id: "asc" }],
  });
}

export async function getDeskEmailChannel(prisma: PrismaClient, projectId: string) {
  const desk = await prisma.pmProject.findFirst({ where: { id: projectId, kind: "SERVICE_DESK" }, select: { id: true } });
  if (!desk) throw new Error(EMAIL_CHANNEL_ERRORS.DESK_NOT_FOUND);
  return prisma.pmSupportChannel.findUnique({
    where: { projectId_kind: { projectId, kind: "EMAIL" } },
    select: {
      id: true, projectId: true, kind: true, emailAccountId: true, enabled: true,
      contactOwnerUserId: true, autoAckEnabled: true, autoAckTemplate: true,
      reopenWindowDays: true, enabledAt: true,
      emailAccount: { select: { address: true, displayName: true } },
    },
  });
}

export async function bindDeskEmailChannel(
  prisma: PrismaClient,
  input: {
    projectId: string;
    emailAccountId: string | null;
    contactOwnerUserId: string;
    enabled?: boolean;
    autoAckEnabled?: boolean;
    autoAckTemplate?: string;
    reopenWindowDays?: number;
  },
) {
  const desk = await prisma.pmProject.findFirst({ where: { id: input.projectId, kind: "SERVICE_DESK", isArchived: false }, select: { id: true } });
  if (!desk) throw new Error(EMAIL_CHANNEL_ERRORS.DESK_NOT_FOUND);
  if (input.emailAccountId === null) {
    await prisma.pmSupportChannel.deleteMany({ where: { projectId: input.projectId, kind: "EMAIL" } });
    return null;
  }
  const [account, contactOwner] = await Promise.all([
    prisma.emailAccount.findUnique({ where: { id: input.emailAccountId }, select: { id: true, authMode: true } }),
    prisma.user.findFirst({ where: { id: input.contactOwnerUserId, directoryStatus: "ACTIVE" }, select: { id: true } }),
  ]);
  if (!account) throw new Error(EMAIL_CHANNEL_ERRORS.ACCOUNT_NOT_FOUND);
  if (account.authMode === "M365_GRAPH") throw new Error(EMAIL_CHANNEL_ERRORS.ACCOUNT_READ_ONLY);
  if (!contactOwner) throw new Error(EMAIL_CHANNEL_ERRORS.CONTACT_OWNER_NOT_FOUND);
  if (input.autoAckTemplate !== undefined && (input.autoAckTemplate.length > ACK_TEMPLATE_MAX || checkAckTemplate(input.autoAckTemplate).length > 0)) {
    throw new Error(EMAIL_CHANNEL_ERRORS.INVALID_TEMPLATE);
  }
  const existing = await prisma.pmSupportChannel.findUnique({ where: { projectId_kind: { projectId: input.projectId, kind: "EMAIL" } }, select: { enabled: true, emailAccountId: true } });
  return prisma.pmSupportChannel.upsert({
    where: { projectId_kind: { projectId: input.projectId, kind: "EMAIL" } },
    create: {
      projectId: input.projectId,
      emailAccountId: input.emailAccountId,
      contactOwnerUserId: input.contactOwnerUserId,
      enabled: input.enabled ?? true,
      enabledAt: new Date(),
      autoAckEnabled: input.autoAckEnabled ?? false,
      autoAckTemplate: input.autoAckTemplate ?? DEFAULT_ACK_TEMPLATE,
      reopenWindowDays: input.reopenWindowDays ?? 14,
    },
    update: {
      emailAccountId: input.emailAccountId,
      contactOwnerUserId: input.contactOwnerUserId,
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.enabled !== false && (!existing?.enabled || existing.emailAccountId !== input.emailAccountId) ? { enabledAt: new Date() } : {}),
      ...(input.autoAckEnabled !== undefined ? { autoAckEnabled: input.autoAckEnabled } : {}),
      ...(input.autoAckTemplate !== undefined ? { autoAckTemplate: input.autoAckTemplate } : {}),
      ...(input.reopenWindowDays !== undefined ? { reopenWindowDays: input.reopenWindowDays } : {}),
    },
    select: {
      id: true, projectId: true, kind: true, emailAccountId: true, enabled: true,
      contactOwnerUserId: true, autoAckEnabled: true, autoAckTemplate: true,
      reopenWindowDays: true, enabledAt: true,
      emailAccount: { select: { address: true, displayName: true } },
    },
  });
}
