/** WARP-3113 — Delete keeps a leaver's files this many days, then the box
 *  removes the account. Mirrors RETENTION_DAYS in the orchestrator's
 *  leaver-deletion.service.ts; the box's `deletionDueAt` is the truth. */
export const DELETION_RETENTION_DAYS = 30;

/** The Delete dialog's body, shared by the Users and Settings pages. */
export const DELETE_USER_COPY =
  `They're signed out and can't sign in from now on. Their files are kept for ${DELETION_RETENTION_DAYS} days, ` +
  "then deleted with the account. You can cancel until then.";

/** WARP-3169 — who may receive a leaver's files: an owner, admin or member
 *  (wire role `family`), never an external guest. Mirrors the box's check. */
export const HANDOVER_RECIPIENT_ROLES: ReadonlySet<string> = new Set(["owner", "admin", "family"]);
