/** WARP-3113 — Delete keeps a leaver's files this many days, then the box
 *  removes the account. Mirrors RETENTION_DAYS in the orchestrator's
 *  leaver-deletion.service.ts; the box's `deletionDueAt` is the truth. */
export const DELETION_RETENTION_DAYS = 30;

/** The Delete dialog's body, shared by the Users and Settings pages. */
export const DELETE_USER_COPY =
  `They're signed out and can't sign in from now on. Their files are kept for ${DELETION_RETENTION_DAYS} days, ` +
  "then deleted with the account. You can cancel until then. " +
  "Handing their files to a colleague isn't available yet.";
