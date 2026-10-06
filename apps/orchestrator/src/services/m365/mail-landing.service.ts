/** Folder-scoped Outlook copies; a moved/deleted provider item never deletes the local archive. */
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { afterCommitEmailIngest, prepareEmailIngest, storeEmailIngest, type EmailIngestResult } from "../email/mail-ingest.service.js";
import { GRAPH_API_BASE_URL, GraphClient, GraphRequestError } from "./graph-client.js";
import { lockMicrosoftMailConnection } from "./mail-settings.service.js";
import { MICROSOFT_MAIL_FIELDS, microsoftMailId, microsoftMailNeedsHydration, parseMicrosoftMailMessage,
  MicrosoftMailUnavailableError, type MicrosoftMailEntry } from "./mail-normalizer.js";
import type { PageHandler } from "./m365-sync.service.js";

/** Body and selected headers are hydrated outside the transaction; persistence
 * is then fenced by the exact connection generation and cursor checkpoint. */
export function createMicrosoftMailPageHandler(prisma: PrismaClient, client: GraphClient, now = () => new Date()): PageHandler {
  return async (cursor, page, run) => {
    if (cursor.workload !== "mail") return;
    const cursorState = cursor.state;
    if (cursorState !== "IDLE" && cursorState !== "BACKOFF" && cursorState !== "RESYNC_REQUIRED" && cursorState !== "SYNCING") throw new MicrosoftMailUnavailableError();
    if (!run.accessToken || !run.grantGeneration || !Array.isArray(page.raw.value) ||
        page.items.length > 1000 || Boolean(page.links.nextLink) === Boolean(page.links.deltaLink)) throw new MicrosoftMailUnavailableError();
    const connection = await prisma.m365Connection.findUnique({ where: { userId: cursor.userId } });
    if (!connection?.emailAccountId || connection.state !== "CONNECTED" || !connection.mailEnabled) throw new MicrosoftMailUnavailableError();
    const account = await prisma.emailAccount.findFirst({
      where: { id: connection.emailAccountId, userId: cursor.userId, authMode: "M365_GRAPH" },
    });
    if (!account) throw new MicrosoftMailUnavailableError();

    // An entity may occur more than once and delta order is not guaranteed.
    // Hydrate duplicate live representations to merge its current state once.
    const counts = new Map<string, number>();
    for (const item of page.items) { const id = microsoftMailId(item); counts.set(id, (counts.get(id) ?? 0) + 1); }
    const hydrated = new Map<string, Promise<MicrosoftMailEntry>>();
    const entries: MicrosoftMailEntry[] = [];
    for (const item of page.items) {
      const id = microsoftMailId(item);
      const removed = item["@removed"] !== undefined;
      if (!removed && (microsoftMailNeedsHydration(item) || !run.fullEnumeration || counts.get(id)! > 1)) {
        let request = hydrated.get(id);
        if (!request) {
          request = (async () => {
            try {
              const complete = await client.getPage(`${GRAPH_API_BASE_URL}/me/messages/${encodeURIComponent(id)}?$select=${MICROSOFT_MAIL_FIELDS.join(",")}`,
                run.accessToken!, { mail: true });
              // A GET by immutable id must not swap in another message.
              if (microsoftMailId(complete.raw) !== id) throw new MicrosoftMailUnavailableError();
              return parseMicrosoftMailMessage(complete.raw, account.address);
            } catch (error) {
              // Deletion between delta enumeration and hydration is ordinary.
              // Only membership changes; an existing archived copy survives.
              if (error instanceof GraphRequestError && error.statusCode === 404) return { kind: "removed" as const, providerMessageId: id };
              throw error;
            }
          })();
          hydrated.set(id, request);
        }
        entries.push(await request);
      } else entries.push(parseMicrosoftMailMessage(item, account.address));
    }
    // A current full representation wins over an unordered tombstone for the
    // same id. Its current parent folder decides this folder's membership.
    const merged = new Map<string, MicrosoftMailEntry>();
    for (const entry of entries) {
      if (entry.kind === "message" || merged.get(entry.providerMessageId)?.kind !== "message") merged.set(entry.providerMessageId, entry);
    }
    const prepared = new Map([...merged].flatMap(([id, entry]) => entry.kind === "message"
      ? [[id, prepareEmailIngest(account.id, entry.payload, { ...entry.metadata,
        externalAttachmentMetadata: entry.metadata.externalAttachmentMetadata ?? undefined })] as const] : []));
    const results: EmailIngestResult[] = [];
    await prisma.$transaction(async (tx) => {
      const owner = await lockMicrosoftMailConnection(tx, cursor.userId, run.grantGeneration, cursor.cursorLinkHash);
      if (!owner || owner.account.id !== account.id || !await tx.m365DeltaCursor.findFirst({ where: {
        id: cursor.id, userId: cursor.userId, workload: "mail", resourceId: cursor.resourceId,
        deltaLink: cursor.deltaLink, resumeLink: cursor.resumeLink, state: cursorState,
      } })) throw new MicrosoftMailUnavailableError();
      const folder = await tx.m365MailFolder.upsert({
        where: { accountId_folderId: { accountId: account.id, folderId: cursor.resourceId } },
        create: { accountId: account.id, folderId: cursor.resourceId }, update: {},
      });
      const runId = run.fullEnumeration ? run.isFirstPage ? randomUUID() : folder.externalSyncRun : null;
      if (run.fullEnumeration && !runId) throw new MicrosoftMailUnavailableError();
      if (run.fullEnumeration && run.isFirstPage) await tx.m365MailFolder.updateMany({
        where: { id: folder.id, accountId: account.id }, data: { externalSyncRun: runId },
      });
      for (const entry of merged.values()) {
        if (entry.kind === "message") {
          const result = await storeEmailIngest(tx, prepared.get(entry.providerMessageId)!);
          results.push(result);
          if (entry.parentFolderId === cursor.resourceId) {
            await tx.m365MailMembership.upsert({
              where: { accountId_folderId_providerMessageId: { accountId: account.id, folderId: cursor.resourceId, providerMessageId: entry.providerMessageId } },
              create: { accountId: account.id, folderId: cursor.resourceId, providerMessageId: entry.providerMessageId,
                messageId: result.emailMessageId, externalSeenRun: runId },
              update: { messageId: result.emailMessageId, ...(runId ? { externalSeenRun: runId } : {}) },
            });
            continue;
          }
        }
        await tx.m365MailMembership.deleteMany({ where: { accountId: account.id, folderId: cursor.resourceId, providerMessageId: entry.providerMessageId } });
      }
      if (run.fullEnumeration && run.isLastPage) await tx.m365MailMembership.deleteMany({ where: {
        accountId: account.id, folderId: cursor.resourceId, OR: [{ externalSeenRun: null }, { externalSeenRun: { not: runId! } }],
      } });
      if (run.isLastPage) {
        // Keep the marker after final page commit: cursor checkpoint persistence
        // can still fail, and a replay must not forget earlier pages in the run.
        await tx.m365MailFolder.updateMany({ where: { id: folder.id, accountId: account.id }, data: { lastSyncAt: now(), lastError: null } });
      }
      // A committed page is immediately searchable while the remaining
      // history continues loading. Folder completion is recorded separately.
      await tx.emailAccount.updateMany({ where: { id: account.id, userId: cursor.userId, authMode: "M365_GRAPH" },
        data: { lastIdleAt: now(), lastError: null, lastErrorAt: null } });
      await tx.m365Connection.updateMany({ where: { userId: cursor.userId, mailEnabled: true, emailAccountId: account.id },
        data: { mailSyncState: "CONNECTED" } });
    }, { timeout: 60_000 });
    await afterCommitEmailIngest(prisma, results);
  };
}
