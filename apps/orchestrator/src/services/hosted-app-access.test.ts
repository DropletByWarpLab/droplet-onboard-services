import { describe, expect, it, vi } from "vitest";
import type { Request } from "express";
import type { PrismaClient } from "@prisma/client";
import { TOOLS, type ToolContext } from "@droplet/tools-core";
import { computeEffectiveAccess, type EffectiveAccessInputs } from "./effective-access.service.js";
import { toolAllowedInScope } from "./tool-access.service.js";
import { createHostedService, HostedError } from "./hosted.service.js";

vi.mock("../config.js", () => ({ config: { JWT_SECRET: "test-secret-at-least-thirty-two-characters", corsAllowedOrigins: ["https://droplet-ai.lan"], DROPLET_LAN_HOSTNAME: "droplet-ai.lan" } }));

describe("hosted read-tool admission and family app visibility", () => {
  it("composes a family domain grant without a Workshop module and still requires a current app grant", async () => {
    const inputs: EffectiveAccessInputs = {
      user: { id: "family-user", role: "family", accessRole: {
        mayOperateLocks: false, cloudModelsAllowed: false, storageQuotaBytes: null,
        maxUploadSizeMb: null, llmDailyMessageCap: null, featureGrants: [],
        toolGrants: [{ domain: "hosted_apps", level: "view" }], connectorGrants: [],
      } },
      exceptions: [], workspaceModuleIds: new Set(["chat"]), cloudEscapeEnabled: false,
      connections: [], usagePolicy: null, deptRights: [],
    };
    const access = computeEffectiveAccess(inputs);
    const scope = { domains: new Set(access.toolDomains), writeDomains: new Set<string>(), locks: false };
    expect(toolAllowedInScope("list_hosted_apps", scope)).toBe(true);
    inputs.user.accessRole!.toolGrants = [];
    expect(computeEffectiveAccess(inputs).toolDomains).not.toContain("hosted_apps");

    const user = { id: "family-user", username: "alex", displayName: "Alex", role: "family", directoryStatus: "ACTIVE", email: null };
    const row = { id: "notes", workspaceId: "notes-work", name: "Notes", status: "live", currentVersion: null, lastHealthAt: null, hostedAppGrants: [] as { role: string }[] };
    const prisma = { user: { findMany: vi.fn(async () => [user]), findUnique: vi.fn(async () => user) }, extension: { findMany: vi.fn(async () => [row]) } } as unknown as PrismaClient;
    const service = createHostedService(prisma, { enabled: () => true, sandbox: {} as never });
    const get = vi.fn(async (path: string) => {
      const url = new URL(path, "https://droplet-ai.lan");
      const req = { user: { id: "_service:mcp", role: "service" }, query: Object.fromEntries(url.searchParams), headers: {}, header: () => undefined } as unknown as Request;
      try {
        const data = url.pathname.endsWith("/logs") ? await service.logs(req, "notes", 200) : await service.list(req);
        return { ok: true, status: 200, json: async () => data };
      } catch (error) {
        if (!(error instanceof HostedError)) throw error;
        return { ok: false, status: error.status, json: async () => ({ error: error.code }) };
      }
    });
    const ctx = { userId: "alex", http: { orchestrator: { get } } } as unknown as ToolContext;
    const list = TOOLS.get("list_hosted_apps")!;
    expect(await list.handler({}, ctx)).toMatchObject({ ok: true, data: { apps: [] } });
    row.hostedAppGrants = [{ role: "family" }];
    expect(await list.handler({}, ctx)).toMatchObject({ ok: true, data: { apps: [{ slug: "notes" }] } });
    expect(await TOOLS.get("hosted_app_logs")!.handler({ slug: "notes" }, ctx)).toMatchObject({ ok: false, error: { message: "orchestrator returned 403" } });
    user.directoryStatus = "DEACTIVATED";
    expect(await list.handler({}, ctx)).toMatchObject({ ok: false, error: { message: "orchestrator returned 403" } });
  });
});
