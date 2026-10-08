export const CHAT_CONNECTION_POPUP_KEY = "droplet.chatConnectionPopup";
export const CHAT_CONNECTION_POPUP_TTL = 15 * 60 * 1000;
export type PopupProvider = "google" | "m365";
export interface ConnectionPopupRecord {
  provider: PopupProvider;
  nonce: string;
  openerOrigin: string;
  startedAt: number;
}
export const POPUP_OUTCOMES = new Set(["connected", "cancelled", "expired", "failed", "different_account", "invalid"]);

export function parseConnectionPopupRecord(value: unknown, now = Date.now()): ConnectionPopupRecord | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<ConnectionPopupRecord>;
  if (v.provider !== "google" && v.provider !== "m365") return null;
  if (typeof v.nonce !== "string" || !/^[a-zA-Z0-9-]{32,64}$/.test(v.nonce)) return null;
  if (typeof v.startedAt !== "number" || !Number.isFinite(v.startedAt) || now - v.startedAt > CHAT_CONNECTION_POPUP_TTL || now < v.startedAt) return null;
  try {
    if (typeof v.openerOrigin !== "string") return null;
    const origin = new URL(v.openerOrigin);
    if (!["http:", "https:"].includes(origin.protocol) || origin.origin !== v.openerOrigin) return null;
  } catch { return null; }
  return v as ConnectionPopupRecord;
}

export function connectionPopupEntryUrl(base: string, record: ConnectionPopupRecord): string {
  const url = new URL("/chat/connect", base);
  url.searchParams.set("provider", record.provider);
  url.searchParams.set("channel", record.nonce);
  url.searchParams.set("openerOrigin", record.openerOrigin);
  url.searchParams.set("at", String(record.startedAt));
  return url.toString();
}

export function connectionPopupRecordFromUrl(raw: string, now = Date.now()): ConnectionPopupRecord | null {
  try {
    const url = new URL(raw);
    return parseConnectionPopupRecord({ provider: url.searchParams.get("provider"), nonce: url.searchParams.get("channel"), openerOrigin: url.searchParams.get("openerOrigin"), startedAt: Number(url.searchParams.get("at")) }, now);
  } catch { return null; }
}

export function isConnectionPopupMessage(event: Pick<MessageEvent, "origin" | "source" | "data">, attempt: {
  popup: Window; expectedOrigin: string; record: ConnectionPopupRecord;
}, now = Date.now()): boolean {
  const data: unknown = event.data;
  if (!parseConnectionPopupRecord(attempt.record, now) || event.source !== attempt.popup || event.origin !== attempt.expectedOrigin || !data || typeof data !== "object") return false;
  const signal = data as Record<string, unknown>;
  return signal.type === "droplet.connection-return" && signal.nonce === attempt.record.nonce && signal.provider === attempt.record.provider && typeof signal.outcome === "string" && POPUP_OUTCOMES.has(signal.outcome);
}
