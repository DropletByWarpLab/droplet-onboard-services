/**
 * WARP-2900 (ADR-056 slice H3), review #2325 blocker 2 — which static tools
 * an extension may run as its installing owner (POST /api/extensions/self/call).
 *
 *   - the allowlist is PINNED: empty in v1. Adding a tool is a reviewed
 *     change to this test and to docs/security/extension-trust.md;
 *   - any entry must be a catalog read that stays on the box: no egress
 *     channel (the /api/web screen), no connector (cloud / erp), no model
 *     call (the model may be a cloud provider), no mail server;
 *   - get_weather, currency_convert and cloud_query_dataset are refused
 *     even from an allowlist that names them (MUTATION: drop the off-box
 *     check from extensionSelfCallRefusal → red).
 */
import { describe, it, expect } from "vitest";
import { TOOL_CATALOG, TOOL_ROUTES } from "@droplet/tools-core";
import {
  EXTENSION_SELF_CALL_TOOLS,
  extensionSelfCallRefusal,
  selfCallReachesOffBox,
} from "./extension-self-call.js";

const tool = (name: string) => {
  const t = TOOL_CATALOG.find((c) => c.name === name);
  if (!t) throw new Error(`${name} is not in TOOL_CATALOG`);
  return t;
};

describe("the /self/call allowlist", () => {
  it("is empty in v1: no static tool is callable by an extension", () => {
    // A tool joins by an edit here, reviewed: it must pass the test below.
    expect(EXTENSION_SELF_CALL_TOOLS).toEqual([]);
    expect(Object.isFrozen(EXTENSION_SELF_CALL_TOOLS)).toBe(true);
  });

  it("holds only catalog reads that stay on the box", () => {
    for (const name of EXTENSION_SELF_CALL_TOOLS) {
      const t = tool(name);
      expect(t.requiresWrite || t.requiresConfirmation, `${name} is not a read`).toBe(false);
      expect(selfCallReachesOffBox(t), `${name} leaves the box`).toBeNull();
    }
  });
});

describe("what leaves the box", () => {
  it.each([
    ["get_weather", /\/api\/web\//],
    ["currency_convert", /\/api\/web\//],
    ["cloud_query_dataset", /cloud/],
    ["erp_find_patient", /erp/],
    ["summarize_file", /\/api\/llm\//],
    ["translate_text", /\/api\/llm\//],
    ["email_read", /\/api\/email\//],
  ])("%s reaches off the box", (name, why) => {
    expect(selfCallReachesOffBox(tool(name))).toMatch(why);
  });

  it.each(["list_network_devices", "calculate", "get_current_datetime", "list_cameras"])(
    "%s stays on the box",
    (name) => {
      expect(selfCallReachesOffBox(tool(name))).toBeNull();
    },
  );

  it("a tool with no route entry is treated as leaving the box (fail closed)", () => {
    const routed = new Set(TOOL_ROUTES.map((r) => r.tool));
    const fake = { ...tool("calculate"), name: "no_route_entry_tool" };
    expect(routed.has(fake.name)).toBe(false);
    expect(selfCallReachesOffBox(fake)).toMatch(/no route entry/);
  });
});

describe("extensionSelfCallRefusal", () => {
  it("refuses a write before anything else", () => {
    const write = TOOL_CATALOG.find((t) => t.requiresWrite)!;
    expect(extensionSelfCallRefusal(write, [write.name])).toMatchObject({ code: "write_tool_refused" });
  });

  it.each(["get_weather", "currency_convert", "cloud_query_dataset"])(
    "refuses %s even when an allowlist names it",
    (name) => {
      expect(extensionSelfCallRefusal(tool(name), [name])).toMatchObject({ code: "off_box_tool_refused" });
    },
  );

  it("refuses a box-local read the allowlist does not name", () => {
    expect(extensionSelfCallRefusal(tool("list_network_devices"))).toMatchObject({ code: "tool_not_allowlisted" });
    expect(extensionSelfCallRefusal(tool("list_network_devices"), [])).toMatchObject({ code: "tool_not_allowlisted" });
  });

  it("admits a box-local read the allowlist names", () => {
    expect(extensionSelfCallRefusal(tool("list_network_devices"), ["list_network_devices"])).toBeNull();
  });
});
