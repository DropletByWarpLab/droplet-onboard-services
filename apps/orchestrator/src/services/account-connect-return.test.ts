/**
 * Fixed local destinations only: the OAuth callback never chooses where the
 * browser lands. WARP-3904 adds `/chat` so a connection started from an Ask AI
 * card comes back to the conversation it began in.
 */
import { describe, expect, it } from "vitest";
import { ACCOUNT_CONNECT_RETURN_PATHS, accountConnectOutcomeUrl, accountConnectReturnTo } from "./account-connect-return.js";

describe("account connect return destinations", () => {
  it("are exactly the four fixed local pages", () => {
    expect([...ACCOUNT_CONNECT_RETURN_PATHS]).toEqual(["/settings", "/setup", "/setup?step=accounts", "/chat"]);
  });

  it.each([...ACCOUNT_CONNECT_RETURN_PATHS])("keeps %s", (path) => {
    expect(accountConnectReturnTo(path)).toBe(path);
  });

  it.each(["https://evil.example", "//evil.example", "/chat?x=1", "/chat/", "/chat#x", "/chat/connect-return", "/chat/connect-return/", "/setup?step=done", "/", "", undefined, null, 42, {}])(
    "turns %j into Settings",
    (value) => {
      expect(accountConnectReturnTo(value)).toBe("/settings");
    },
  );

  it("appends the outcome to the destination, with ? or & as it needs", () => {
    expect(accountConnectOutcomeUrl("/chat", "google", "connected")).toBe("/chat?google=connected");
    expect(accountConnectOutcomeUrl("/chat", "m365", "cancelled")).toBe("/chat?m365=cancelled");
    expect(accountConnectOutcomeUrl("/settings", "google", "failed")).toBe("/settings?google=failed");
    expect(accountConnectOutcomeUrl("/setup?step=accounts", "m365", "expired")).toBe("/setup?step=accounts&m365=expired");
  });
});
