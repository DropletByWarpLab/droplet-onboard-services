/**
 * WARP-3904 — the OAuth round trip for a connect card.
 *
 * Google and Microsoft 365 sign-in leaves the dashboard: the card writes one
 * small record to `sessionStorage`, the browser goes to the provider, and the
 * box's callback redirects back to `/chat?google=<outcome>` or
 * `/chat?m365=<outcome>`. This module is both ends of that record, kept pure
 * (storage and clock are injected) so the page's return handling is a unit
 * test rather than a click-through.
 *
 * What the record holds: which conversation the card was in, which provider,
 * and the display name for the follow-up turn. No secret, no token, no URL —
 * the provider's consent screen and the callback hold all of those, and the
 * dashboard never sees them. A record older than {@link CONNECT_RETURN_MAX_AGE_MS}
 * is ignored: a person who wandered off mid-consent should not have a
 * "connected" turn appear in a chat they have long since left.
 *
 * A crafted `/chat?google=connected` link can never cause a turn on its own:
 * a turn is sent only when this tab wrote a matching, fresh record first.
 */
import { connectOutcomeTurn } from "@droplet/shared-types";

export const CONNECT_RETURN_KEY = "droplet.chat.connect-return";
export const CONNECT_RETURN_MAX_AGE_MS = 15 * 60 * 1000;

/** The query parameter each provider's callback sets, which is also its provider key. */
export type ConnectReturnProvider = "google" | "m365";
export const CONNECT_RETURN_PROVIDERS: readonly ConnectReturnProvider[] = ["google", "m365"];

const PROVIDER_LABEL: Record<ConnectReturnProvider, string> = {
  google: "Google",
  m365: "Microsoft 365",
};

/** The one outcome string that means the account is connected. */
export const CONNECT_RETURN_SUCCESS = "connected";

export interface ConnectReturnRecord {
  conversationId: string | null;
  provider: string;
  displayName: string;
  /** `Date.now()` when the card started the sign-in. */
  at: number;
}

export type ConnectReturnResult =
  /** Nothing to do: no matching record for a success, or not a return at all. */
  | { kind: "none" }
  /** Signed in. `turn` is the quiet follow-up the page sends into `conversationId`. */
  | { kind: "connected"; conversationId: string | null; displayName: string; turn: string }
  /** Cancelled, expired, refused, or anything else that is not a success. No turn. */
  | { kind: "failed"; conversationId: string | null; displayName: string; message: string };

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** `sessionStorage`, or null where the browser blocks it. Never throws. */
export function safeSessionStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** Control characters flattened and length capped: this string ends up in a user turn. */
function cleanName(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  // eslint-disable-next-line no-control-regex
  const flat = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  return flat || fallback;
}

/** Write the record just before leaving for the provider. False when storage is blocked. */
export function saveConnectReturn(storage: StorageLike | null, record: ConnectReturnRecord): boolean {
  if (!storage) return false;
  try {
    storage.setItem(CONNECT_RETURN_KEY, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

/** Drop the record (a sign-in that never started must not leave one behind). */
export function clearConnectReturn(storage: StorageLike | null): void {
  try {
    storage?.removeItem(CONNECT_RETURN_KEY);
  } catch {
    /* blocked storage: nothing was written either */
  }
}

/** The stored record if it is well formed and fresh, else null. Does not clear it. */
function readRecord(storage: StorageLike | null, now: number): ConnectReturnRecord | null {
  if (!storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(CONNECT_RETURN_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<ConnectReturnRecord> | null;
    if (!v || typeof v !== "object") return null;
    if (typeof v.provider !== "string" || typeof v.at !== "number" || !Number.isFinite(v.at)) return null;
    const age = now - v.at;
    // A timestamp from the future is as untrustworthy as a stale one.
    if (age > CONNECT_RETURN_MAX_AGE_MS || age < -60_000) return null;
    const conversationId = typeof v.conversationId === "string" && v.conversationId.length > 0 && v.conversationId.length <= 128 ? v.conversationId : null;
    return { conversationId, provider: v.provider, displayName: typeof v.displayName === "string" ? v.displayName : "", at: v.at };
  } catch {
    return null;
  }
}

/** The copy for a sign-in that did not finish. Same for cancelled, expired and failed. */
export function connectReturnFailureMessage(displayName: string): string {
  return `Connecting ${displayName} didn't finish. You can try again from Settings.`;
}

/**
 * Read AND clear the record, then map the callback's outcome to what the page
 * should do. Always clears: a record is good for exactly one return.
 *
 * `provider` is the query parameter that was present (`google` or `m365`) and
 * must equal the record's provider, so a Google return cannot consume a
 * Microsoft record.
 */
export function takeConnectReturn(opts: {
  provider: ConnectReturnProvider;
  outcome: string;
  storage: StorageLike | null;
  now: number;
}): ConnectReturnResult {
  const { provider, outcome, storage, now } = opts;
  const record = readRecord(storage, now);
  clearConnectReturn(storage);
  const usable = record !== null && record.provider === provider ? record : null;
  const displayName = cleanName(usable?.displayName, PROVIDER_LABEL[provider]);

  if (outcome === CONNECT_RETURN_SUCCESS) {
    // No record means this tab did not start the sign-in (another browser, an
    // expired record, a hand-typed link). Say nothing rather than guess.
    if (!usable) return { kind: "none" };
    return {
      kind: "connected",
      conversationId: usable.conversationId,
      displayName,
      turn: connectOutcomeTurn(displayName, "connected"),
    };
  }
  return {
    kind: "failed",
    conversationId: usable?.conversationId ?? null,
    displayName,
    message: connectReturnFailureMessage(displayName),
  };
}
