/**
 * WARP-3519 (WS-2) — who can READ a work item.
 *
 * Three things need the same answer and must not each carry their own copy of
 * it: a mention is kept only for somebody who can read the item, a watcher
 * somebody else adds must be able to read it, and the notify sweep must not
 * tell somebody about an item they cannot open.
 *
 * The rule is the one the routes already enforce, read off the same sources:
 *
 *  - PM is company-shared. Every human tier above the `projects` floor reads
 *    every item — derived from the access catalog (`maxLevelFor`, which is
 *    `null` below the floor and for `service`), never a list of role names, so
 *    this cannot drift from the module's tier floor (WARP-3365 / WARP-3369).
 *  - An external guest reads exactly the items ASSIGNED TO THEM and nothing
 *    else (modules/guest-shares.ts, middleware/guest-share.ts).
 *  - A deactivated account reads nothing (`directoryStatus`, the SCIM
 *    soft-deactivation — the row stays, the person is gone).
 *
 * `projects` is deliberately not feature-gated per person (module-mounts.ts
 * FEATURE_GATED_MODULES: a CRM-only role still reads /api/pm), so there is no
 * per-person grant to consult beyond the tier.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { maxLevelFor } from "../access-catalog.js";
import type { Role } from "../jwt.service.js";

type Db = PrismaClient | Prisma.TransactionClient;

/** Does this tier read company-shared Projects data at all? `guest` does not
 *  (it reads only what is assigned to it); `service` is a machine principal,
 *  not a person; anything unrecognised fails closed. */
export function roleReadsSharedProjects(role: string): boolean {
  return maxLevelFor(role as Role, "projects") !== null;
}

/**
 * The subset of `userIds` who can read `workItemId`. Unknown ids, deactivated
 * accounts, `service` principals and guests not assigned to THIS item are
 * simply absent from the result — never an error, never a partial throw.
 *
 * Two queries at most, whatever the size of the input.
 */
export async function filterItemReaders(
  db: Db,
  workItemId: string,
  userIds: readonly string[],
): Promise<Set<string>> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return new Set();

  const users = await db.user.findMany({
    where: { id: { in: ids }, directoryStatus: "ACTIVE" },
    select: { id: true, role: true },
  });

  const guestIds = users.filter((u) => u.role === "guest").map((u) => u.id);
  const assignedGuests =
    guestIds.length === 0
      ? new Set<string>()
      : new Set(
          (
            await db.pmWorkItemAssignee.findMany({
              where: { workItemId, userId: { in: guestIds } },
              select: { userId: true },
            })
          ).map((a) => a.userId),
        );

  return new Set(
    users
      .filter((u) => (u.role === "guest" ? assignedGuests.has(u.id) : roleReadsSharedProjects(u.role)))
      .map((u) => u.id),
  );
}
