/**
 * WARP-3200 — a workshop workspace is deleted only while no extension that
 * can still be installed is built from it, and nothing makes an extension
 * installable from a workspace that is being, or has been, deleted.
 *
 * The sandbox re-exports an extension's code from its source workspace on
 * every install (a promote, an enable, the reconciler after a reboot), so an
 * installable extension whose workspace is gone can never start again. An
 * `uninstalled` extension is the one status that lets the workspace go.
 *
 * Reading the extension and then deleting is a check-then-act, and two
 * writers can revive an extension from `uninstalled` (or create it) while a
 * delete is between the two: a promote's store and an enable's claim. So
 * both sides take ONE row lock, on the `WorkshopWorkspace` row, and decide
 * only once they hold it:
 *
 *   - the delete: `FOR UPDATE`, then reads the extension, then deletes the
 *     row, all in one READ COMMITTED transaction;
 *   - a promote's store and an enable's claim: `FOR KEY SHARE`, in the same
 *     transaction as the status they write. No row → they refuse.
 *
 * Whichever takes the row first wins. A promote/enable that got there first
 * commits its status before the delete's lock is granted, and the delete's
 * extension read — a new statement under READ COMMITTED, so a new snapshot —
 * sees it and refuses. A delete that got there first holds the reviver until
 * it commits; the reviver's lock then finds no row and it stores nothing.
 * `FOR KEY SHARE` conflicts only with `FOR UPDATE` and a DELETE, so ordinary
 * updates of the workspace (a run's propose) never wait on a promote.
 *
 * The sandbox's repository is NOT removed inside the transaction: see the
 * delete route (routes/workspace.ts) for that order and why.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { READ_COMMITTED_TX } from "../lib/prisma-tx.js";

/**
 * Holds the workspace for an extension write in `tx` (a promote's store, an
 * enable's claim) until `tx` ends. False when the workspace is gone: the
 * caller must write nothing.
 */
export async function holdWorkspaceAsSource(tx: Prisma.TransactionClient, workspaceId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "WorkshopWorkspace" WHERE "id" = ${workspaceId} FOR KEY SHARE`;
  return rows.length > 0;
}

export type WorkspaceRowDelete =
  | { deleted: true }
  | { deleted: false; reason: "not_found" }
  | { deleted: false; reason: "extension_source"; extensionName: string };

/**
 * Deletes the workspace's row unless an extension that can still be
 * installed is built from it. The guard and the delete are one transaction
 * behind the row lock, so no promote or enable can land between them.
 */
export async function deleteWorkspaceRowUnlessSource(prisma: PrismaClient, workspaceId: string): Promise<WorkspaceRowDelete> {
  return prisma.$transaction(async (tx): Promise<WorkspaceRowDelete> => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "WorkshopWorkspace" WHERE "id" = ${workspaceId} FOR UPDATE`;
    if (locked.length === 0) return { deleted: false, reason: "not_found" };
    const extension = await tx.extension.findUnique({
      where: { workspaceId },
      select: { name: true, status: true },
    });
    if (extension && extension.status !== "uninstalled") {
      return { deleted: false, reason: "extension_source", extensionName: extension.name };
    }
    await tx.workshopWorkspace.delete({ where: { id: workspaceId } });
    return { deleted: true };
  }, READ_COMMITTED_TX);
}
