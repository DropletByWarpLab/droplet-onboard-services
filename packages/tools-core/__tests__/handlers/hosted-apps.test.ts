import { describe, it, expect, vi } from "vitest";
import listHostedApps from "../../src/handlers/hosted-apps/list-hosted-apps.js";
import hostedAppLogs from "../../src/handlers/hosted-apps/hosted-app-logs.js";
import type { ToolContext } from "../../src/types.js";
function context(get = vi.fn(), userId: string | undefined = "alice") {
  return { userId, http: { orchestrator: { get } } } as unknown as ToolContext;
}
describe("hosted app reads", () => {
  it("preserves pagination and carries the acting human on both paths", async () => {
    const data = { apps: [{ slug: "notes", status: "running" }], nextCursor: "notes" };
    const get = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => data });
    expect(await listHostedApps.handler({ limit: 2, cursor: "old" }, context(get))).toEqual({ ok: true, data });
    expect(get.mock.calls[0]?.[0]).toBe("/api/hosted?onBehalfOf=alice&limit=2&cursor=old");
    await hostedAppLogs.handler({ slug: "notes" }, context(get));
    expect(get.mock.calls[1]?.[0]).toBe("/api/hosted/notes/logs?onBehalfOf=alice");
  });
  it("refuses missing identity and invalid slugs before any request; relays authorization refusal", async () => {
    const get = vi.fn().mockResolvedValue({ ok: false, status: 403 });
    expect(await hostedAppLogs.handler({ slug: "../other" }, context(get))).toMatchObject({ ok: false, error: { code: "INVALID_ARGS" } });
    expect(await listHostedApps.handler({}, { ...context(get), userId: undefined })).toMatchObject({ ok: false, error: { code: "NO_PRINCIPAL" } });
    expect(get).not.toHaveBeenCalled();
    expect(await hostedAppLogs.handler({ slug: "notes" }, context(get))).toMatchObject({ ok: false, error: { message: "orchestrator returned 403" } });
  });
});
