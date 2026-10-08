/**
 * The audit row for a mailbox removed through `POST /api/connections/disconnect`.
 * Matches the existing `DELETE /api/email/accounts/:id` audit contract.
 */
import { recordActivity } from "../activity.singleton.js";
import type { ActivityActor } from "../activity.service.js";

export async function auditMailboxDisconnected(input: {
  actor: ActivityActor;
  accountId: string;
  address: string | null;
}): Promise<void> {
  await recordActivity({
    kind: "email",
    severity: "warn",
    sourceIcon: "mail",
    // `warn`, not `info`: the cascade takes every stored thread,
    // message and draft with the account. That is worth a row somebody
    // can find later when the mail is gone.
    what: "Mailbox disconnected",
    // 🔴 The ADDRESS, read before the delete. An audit row carrying a
    // bare uuid for a row that no longer exists tells somebody
    // investigating a missing mail archive nothing at all.
    sub: input.address ?? undefined,
    refs: { accountId: input.accountId, ...(input.address ? { address: input.address } : {}) },
    actor: input.actor,
  });
}
