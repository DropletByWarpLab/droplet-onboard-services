/**
 * WARP-3600 — the rest of what a final leaver deletion has to take with the
 * person, beyond brain memory (by `User.id`) and the username-keyed private
 * tables (`username-data-purge.service.ts`).
 *
 * Every delete here is scoped by the leaver's own identifiers read from the
 * row being removed, by equality only (never a pattern, never a prefix):
 *
 *   - the mailboxes they connected: `EmailAccount.userId` is their `User.id`.
 *     Deleting the account cascades its threads, messages, attachments and
 *     drafts, and takes the stored IMAP/SMTP credential with it, so the
 *     email-indexer has nothing left to poll;
 *   - the file index of their home: `FileContentChunk` (source `nextcloud`)
 *     and `FileIndexStatus` are keyed by the person's Nextcloud login, which
 *     is reusable. Residue would be read by the next person given the name.
 *     Brain chunks are keyed by `User.id` and are purged by `purgeUserData`.
 *
 * Run inside the transaction that deletes the `User` row, so the identity and
 * its data go together.
 */
import type { Prisma, PrismaClient } from "@prisma/client";

export interface LeaverOwnedDataCounts {
  emailAccounts: number;
  fileChunks: number;
  fileIndexRows: number;
}

/**
 * The shared-space sentinels (`__household__`, `__dept_<uuid>__`) are index
 * owners that are not a person. No Nextcloud login can be one, but the file
 * index is the one place a wrong key would delete a whole library's rows, so a
 * login that looks like one is refused outright instead of matched.
 */
const isIndexSentinel = (login: string) => login.startsWith("__");

export async function purgeLeaverOwnedData(
  tx: Prisma.TransactionClient,
  leaver: { id: string; nextcloudUsername: string | null },
): Promise<LeaverOwnedDataCounts> {
  const accounts = await tx.emailAccount.deleteMany({ where: { userId: leaver.id } });

  const login = leaver.nextcloudUsername;
  let fileChunks = 0;
  let fileIndexRows = 0;
  if (login && !isIndexSentinel(login)) {
    fileChunks = (
      await tx.fileContentChunk.deleteMany({ where: { userId: login, source: "nextcloud" } })
    ).count;
    fileIndexRows = (await tx.fileIndexStatus.deleteMany({ where: { userId: login } })).count;
  }
  return { emailAccounts: accounts.count, fileChunks, fileIndexRows };
}

export interface LeaverDepartmentShareOutcome {
  revoked: number;
  /** Nextcloud share ids that could not be revoked: left for an admin to review. */
  failed: number[];
}

/**
 * Revoke the department and Workspace shares the leaver minted. They were
 * created with the box's Nextcloud admin credential, so deleting the person's
 * Nextcloud account does not touch them and a public link would outlive its
 * creator. Scoped by `createdById` (their `User.id`); already-revoked rows are
 * left alone. The row is kept (`revokedAt`), as the revoke route keeps it, for
 * the "shared by me" history and audit.
 */
export async function revokeLeaverDepartmentShares(
  prisma: PrismaClient,
  leaverId: string,
  deleteShare: (ncShareId: number) => Promise<void>,
  now: Date = new Date(),
): Promise<LeaverDepartmentShareOutcome> {
  const shares = await prisma.departmentShare.findMany({
    where: { createdById: leaverId, revokedAt: null },
    select: { id: true, ncShareId: true },
  });
  const out: LeaverDepartmentShareOutcome = { revoked: 0, failed: [] };
  for (const s of shares) {
    try {
      try {
        await deleteShare(s.ncShareId);
      } catch (err) {
        // Already gone upstream is the state we want.
        if (!/\b404\b/.test(String((err as Error)?.message))) throw err;
      }
      await prisma.departmentShare.update({ where: { id: s.id }, data: { revokedAt: now } });
      out.revoked += 1;
    } catch {
      out.failed.push(s.ncShareId);
    }
  }
  return out;
}
