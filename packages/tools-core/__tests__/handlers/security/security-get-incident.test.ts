/**
 * WARP-2979 (ADR-059 P4 §6.12.3) — `security_get_incident`: one incident by
 * id through A2. Hidden and missing are the same answer; the handler checks
 * the id before any call.
 */
import { describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import tool from "../../../src/handlers/security/security-get-incident.js";
import type { ToolContext } from "../../../src/types.js";
import { expectErr, expectOk } from "../../helpers/tool-result.js";

function ctxWith(get: Mock): ToolContext {
  return {
    http: {
      routing: {} as ToolContext["http"]["routing"],
      cameras: {} as ToolContext["http"]["cameras"],
      switchSvc: {} as ToolContext["http"]["switchSvc"],
      fileIndexer: {} as ToolContext["http"]["fileIndexer"],
      nextcloud: {} as ToolContext["http"]["nextcloud"],
      orchestrator: { get, post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
    },
    prisma: {} as ToolContext["prisma"],
    matter: {} as ToolContext["matter"],
    signal: new AbortController().signal,
  };
}

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const ID = "1b1b1b1b-0000-4000-8000-000000000001";

describe("security_get_incident", () => {
  it("is read-only", () => {
    expect(tool.name).toBe("security_get_incident");
    expect(tool.requiresWrite).toBe(false);
    expect(tool.requiresConfirmation).toBe(false);
  });

  it("GETs A2 for exactly that id and returns the incident under its type", async () => {
    const get = vi.fn().mockResolvedValue(reply(200, { incident: { id: ID, title: "Shop floor" }, extra: 1 }));
    const ctx = ctxWith(get);
    const out = expectOk(await tool.handler({ incident_id: ID }, ctx));
    expect(get).toHaveBeenCalledWith(`/api/security/assistant/incidents/${ID}`, { headers: { Accept: "application/json" }, signal: ctx.signal });
    expect(out.data).toEqual({ type: "security_incident", incident: { id: ID, title: "Shop floor" } });
  });

  it.each([
    ["404 INCIDENT_NOT_FOUND (missing or hidden)", 404, { error: { code: "INCIDENT_NOT_FOUND", message: "x" } }, "INCIDENT_NOT_FOUND"],
    ["404 module_disabled", 404, { error: "module_disabled", module: "security" }, "SECURITY_UNAVAILABLE"],
    ["503", 503, { error: { code: "SECURITY_UNAVAILABLE", message: "x" } }, "SECURITY_UNREACHABLE"],
  ])("%s → %s", async (_label, status, body, code) => {
    const get = vi.fn().mockResolvedValue(reply(status, body));
    expect(expectErr(await tool.handler({ incident_id: ID }, ctxWith(get))).error.code).toBe(code);
  });

  it.each([
    ["no id", {}],
    ["not a uuid", { incident_id: "../../zones" }],
    ["a number", { incident_id: 7 }],
    ["an extra argument", { incident_id: ID, verbose: true }],
  ])("%s → INVALID_ARGS with no call", async (_label, args) => {
    const get = vi.fn();
    expect(expectErr(await tool.handler(args as Record<string, unknown>, ctxWith(get))).error.code).toBe("INVALID_ARGS");
    expect(get).not.toHaveBeenCalled();
  });

  it("the description says the reasons are what is true, and never to name anyone", () => {
    expect(tool.description).toMatch(/what is true/i);
    expect(tool.description).toMatch(/never name or guess/i);
    expect((tool.inputSchema as { required?: string[] }).required).toEqual(["incident_id"]);
  });
});
