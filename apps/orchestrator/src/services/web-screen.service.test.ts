import { describe, expect, it } from "vitest";
import { webInputRefusal } from "./web-screen.service.js";

describe("local public web outbound screen", () => {
  it("preserves ordinary percentage research queries", () => {
    expect(webInputRefusal("inflation forecast 5%" )).toBeNull();
  });
  it("refuses deeply encoded private data", () => {
    expect(webInputRefusal("alice%2525252540example.com")).toBe("invalid_input");
  });
  it("decodes escaped personal data before screening", () => {
    expect(webInputRefusal("alice%2540example.com")).toBe("sensitive_outbound_content");
  });
});
