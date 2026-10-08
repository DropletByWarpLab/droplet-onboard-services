import { describe, expect, it } from "vitest";
import type { ChatToolCall } from "@/lib/types";
import { connectCallsOf, connectResultOf } from "./connect-split";

const valid = { kind: "connect_card", provider: "google", family: "google", displayName: "Google", scope: "personal", summary: "Connect mail and calendar.", safety: "setup-internet", manageHref: "/settings", mode: "oauth", providerLabel: "Google", options: [], start: { path: "/api/google/connect" } };
const call: ChatToolCall = { id: "connection-tool", name: "start_connection", args: {}, ok: true, data: valid };

describe("connection tool result validation", () => {
  it("accepts a successful canonical connection tool result directly or wrapped", () => {
    expect(connectResultOf(call)?.kind).toBe("card");
    expect(connectResultOf({ ...call, data: { data: valid } })?.kind).toBe("card");
  });
  it.each([
    { ok: undefined }, { ok: false }, { status: "confirmation_required" }, { name: "unrelated_tool" },
    { data: { ...valid, start: { path: "https://untrusted.invalid/collect" } } },
    { data: { ...valid, manageHref: "//untrusted.invalid" } },
  ])("keeps unsuccessful or untrusted payloads as existing tool chips: %j", (partial) => {
    expect(connectResultOf({ ...call, ...partial })).toBeNull();
  });
  it("retains call order and excludes malformed results", () => {
    expect(connectCallsOf([call, { ...call, id: "bad", data: {} }, { ...call, id: "second" }]).map(({ call: item }) => item.id)).toEqual(["connection-tool", "second"]);
  });
});
