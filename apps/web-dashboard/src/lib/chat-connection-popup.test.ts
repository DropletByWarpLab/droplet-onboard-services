import { describe, expect, it } from "vitest";
import {
  CHAT_CONNECTION_POPUP_TTL,
  connectionPopupEntryUrl,
  connectionPopupRecordFromUrl,
  isConnectionPopupMessage,
  parseConnectionPopupRecord,
  type ConnectionPopupRecord,
} from "./chat-connection-popup";

const NOW = 1_800_000_000_000;
const RECORD: ConnectionPopupRecord = {
  provider: "google",
  nonce: "12345678-1234-1234-1234-123456789abc",
  openerOrigin: "https://droplet.example",
  startedAt: NOW,
};

describe("chat account popup correlation", () => {
  it("accepts fresh records and the TTL boundary, then expires them", () => {
    expect(parseConnectionPopupRecord(RECORD, NOW)).toEqual(RECORD);
    expect(parseConnectionPopupRecord(RECORD, NOW + CHAT_CONNECTION_POPUP_TTL)).toEqual(RECORD);
    expect(parseConnectionPopupRecord(RECORD, NOW + CHAT_CONNECTION_POPUP_TTL + 1)).toBeNull();
    expect(parseConnectionPopupRecord(RECORD, NOW - 1)).toBeNull();
  });

  it.each([
    null,
    [],
    { ...RECORD, provider: "stripe" },
    { ...RECORD, nonce: "short" },
    { ...RECORD, nonce: "a".repeat(65) },
    { ...RECORD, nonce: "a".repeat(31) + "/" },
    { ...RECORD, startedAt: "1800000000000" },
    { ...RECORD, startedAt: Number.NaN },
    { ...RECORD, startedAt: Number.POSITIVE_INFINITY },
    { ...RECORD, openerOrigin: "https://droplet.example/" },
    { ...RECORD, openerOrigin: "https://droplet.example/chat" },
    { ...RECORD, openerOrigin: "https://user:password@droplet.example" },
    { ...RECORD, openerOrigin: "javascript:void(0)" },
    { ...RECORD, openerOrigin: "null" },
  ])("rejects malformed record %j", (record) => {
    expect(parseConnectionPopupRecord(record, NOW)).toBeNull();
  });

  it("uses a fixed canonical entry path and round-trips only correlation metadata", () => {
    const raw = connectionPopupEntryUrl("https://canonical.example/api/google/callback?token=discard", RECORD);
    const url = new URL(raw);
    expect(url.origin).toBe("https://canonical.example");
    expect(url.pathname).toBe("/chat/connect");
    expect(url.searchParams.has("token")).toBe(false);
    expect(connectionPopupRecordFromUrl(raw, NOW)).toEqual(RECORD);
    expect(connectionPopupRecordFromUrl(raw, NOW + CHAT_CONNECTION_POPUP_TTL + 1)).toBeNull();
  });

  it.each(["not a URL", "https://", ""]) ("rejects malformed entry URL %j without throwing", (raw) => {
    expect(connectionPopupRecordFromUrl(raw, NOW)).toBeNull();
  });

  it("rejects incomplete URL records", () => {
    expect(connectionPopupRecordFromUrl("https://droplet.example/chat/connect?provider=google", NOW)).toBeNull();
  });

  it("requires the reserved popup, callback origin, matching provider and nonce", () => {
    const popup = {} as Window;
    const attempt = { popup, expectedOrigin: "https://canonical.example", record: RECORD };
    const event = {
      source: popup,
      origin: "https://canonical.example",
      data: { type: "droplet.connection-return", provider: "google", nonce: RECORD.nonce, outcome: "connected" },
    };
    expect(isConnectionPopupMessage(event, attempt, NOW)).toBe(true);
    expect(isConnectionPopupMessage({ ...event, source: {} as Window }, attempt, NOW)).toBe(false);
    expect(isConnectionPopupMessage({ ...event, source: null }, attempt, NOW)).toBe(false);
    expect(isConnectionPopupMessage({ ...event, origin: "https://attacker.example" }, attempt, NOW)).toBe(false);
    expect(isConnectionPopupMessage({ ...event, origin: "https://canonical.example.attacker.test" }, attempt, NOW)).toBe(false);
    expect(isConnectionPopupMessage({ ...event, data: { ...event.data, nonce: "abcdefab-abcd-abcd-abcd-abcdefabcdef" } }, attempt, NOW)).toBe(false);
    expect(isConnectionPopupMessage({ ...event, data: { ...event.data, provider: "m365" } }, attempt, NOW)).toBe(false);
    expect(isConnectionPopupMessage({ ...event, data: { ...event.data, type: "connected" } }, attempt, NOW)).toBe(false);
    expect(isConnectionPopupMessage(event, attempt, NOW + CHAT_CONNECTION_POPUP_TTL + 1)).toBe(false);
  });

  it.each(["connected", "cancelled", "expired", "failed", "different_account", "invalid"])("accepts closed outcome %s", (outcome) => {
    const popup = {} as Window;
    expect(isConnectionPopupMessage({ source: popup, origin: RECORD.openerOrigin, data: { type: "droplet.connection-return", provider: RECORD.provider, nonce: RECORD.nonce, outcome } }, { popup, expectedOrigin: RECORD.openerOrigin, record: RECORD }, NOW)).toBe(true);
  });

  it.each([null, "connected", {}, { type: "droplet.connection-return", nonce: RECORD.nonce, provider: "google", outcome: "https://attacker.example" }])("rejects non-protocol data %j", (data) => {
    const popup = {} as Window;
    expect(isConnectionPopupMessage({ source: popup, origin: RECORD.openerOrigin, data }, { popup, expectedOrigin: RECORD.openerOrigin, record: RECORD }, NOW)).toBe(false);
  });
});
