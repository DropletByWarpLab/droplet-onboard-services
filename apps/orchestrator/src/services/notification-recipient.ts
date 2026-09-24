/**
 * WARP-2911 — the recipient of every notification is a USERNAME, and this is
 * where a `User.id` handed to that slot is refused.
 *
 * A leaf module on purpose: `notifications.service.ts` (sendNotification,
 * publishNotificationToast, recordNotification) and `push-dispatch.service.ts`
 * (dispatchToUser) both run this check, and `notifications.service.ts` imports
 * `push-dispatch.service.ts` — so the check cannot live in either without a
 * circular import.
 *
 * The SHAPE comes from `@droplet/auth-policy`, the same constant every place a
 * username is minted refuses (`isReservedUserId`), so a username that can be
 * created is a username that can be notified; the two cannot drift apart.
 */
import { isUserIdShaped } from "@droplet/auth-policy";

export type NotificationRecipientErrorCode = "NOTIFICATION_RECIPIENT_IS_ID";

/**
 * A caller handed a `User.id` where the recipient's USERNAME goes.
 *
 * A PROGRAMMING error, and deliberately a throw rather than a `logger.warn`:
 * the failure it replaces was silent and total (the broker drops the toast,
 * no PushSubscription matches, no reader can see the row), and it shipped
 * three times (WARP-2783, WARP-2813, WARP-2910) because a warning nobody reads
 * is what silence already looked like. `caller` is the frame that called the
 * entry point — the code that passed the id — so the log line says where to
 * look. Not in the error handler's trusted set: a route that
 * throws it answers a generic 500.
 *
 * Callers that fan out to many recipients catch it PER RECIPIENT, so one bad
 * recipient never costs the others their notification.
 */
export class NotificationRecipientError extends Error {
  readonly code: NotificationRecipientErrorCode;
  /** `fn (path/to/caller.ts:line:col)`, or null when no frame is available. */
  readonly caller: string | null;

  constructor(code: NotificationRecipientErrorCode, message: string, caller: string | null) {
    super(message);
    this.name = "NotificationRecipientError";
    this.code = code;
    this.caller = caller;
  }

  static isId(entryPoint: string, caller: string | null): NotificationRecipientError {
    return new NotificationRecipientError(
      "NOTIFICATION_RECIPIENT_IS_ID",
      `NOTIFICATION_RECIPIENT_IS_ID: ${entryPoint} was handed a User.id as the recipient; ` +
        `it takes the recipient's User.username` +
        (caller ? ` (passed from ${caller})` : ""),
      caller,
    );
  }

  toJSON(): { name: string; code: NotificationRecipientErrorCode; message: string; caller: string | null } {
    return { name: this.name, code: this.code, message: this.message, caller: this.caller };
  }
}

/** A frame in THIS file (not a test file that merely shares its name). */
const OWN_FRAME = /[\\/]notification-recipient\.[cm]?[jt]s:\d+/;

/**
 * Whoever called the entry point: the frame right after this module's own
 * frames and the entry point's (sendNotification, dispatchToUser, …).
 *
 * Not "the first frame outside the notification modules": a caller that is
 * itself in those modules (the camera fan-out calls dispatchToUser from
 * push-dispatch) was skipped along with them, and the hint landed on
 * `processTicksAndRejections (node:internal/…)`, which names nothing.
 */
function callerOfEntryPoint(): string | null {
  const frames = (new Error().stack ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("at "));
  const entry = frames.findIndex((line) => !OWN_FRAME.test(line));
  const frame = entry < 0 ? undefined : frames[entry + 1];
  return frame ? frame.slice("at ".length) : null;
}

/** The one recipient check every notification entry point runs, first. */
export function assertRecipientIsUsername(entryPoint: string, username: string): void {
  if (isUserIdShaped(username)) {
    throw NotificationRecipientError.isId(entryPoint, callerOfEntryPoint());
  }
}
