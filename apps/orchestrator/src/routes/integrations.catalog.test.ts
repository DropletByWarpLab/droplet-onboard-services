import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { providerDescriptors } from "@droplet/shared-types";

vi.mock("../config.js", () => ({ config: { AUTH_ENABLED: false } }));
vi.mock("../services/activity.singleton.js", () => ({ recordActivity: vi.fn() }));
const { list } = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("../services/integrations.service.js", () => ({ createIntegrationsService: () => ({ list }) }));
import { createIntegrationsRouter } from "./integrations.js";

function appAs(role: string | null) {
  const app = express();
  app.use((req, _res, next) => { if (role !== null) (req as unknown as { user: unknown }).user = { id: "synthetic", role }; next(); });
  app.use("/api", createIntegrationsRouter({} as never));
  return app;
}

describe("native integration descriptor catalog", () => {
  it.each(["owner", "admin"])("%s sees every registered setup descriptor without a database lookup", async role => {
    const response = await request(appAs(role)).get("/api/integrations/catalog");
    expect(response.status).toBe(200);
    expect(response.body.providers.map((p: { provider: string }) => p.provider)).toEqual(providerDescriptors().map(p => p.id));
    expect(list).not.toHaveBeenCalled();
    const eaglesoft = response.body.providers.find((p: { provider: string }) => p.provider === "eaglesoft");
    expect(eaglesoft.connectInput).toBe("lan");
    expect(eaglesoft.connectPath).toBe("/api/integrations/eaglesoft/connect");
    expect(eaglesoft.lanProvisioning.script).toContain("CREATE USER droplet_ro IDENTIFIED BY '<GENERATED_BY_DROPLET>';");
    const api = response.body.providers.find((p: { provider: string }) => p.provider === "eaglesoft-api");
    expect(api.connectInput).toBe("lan_api"); expect(api.testPath).toBe("/api/integrations/eaglesoft/test");
    const xero = response.body.providers.find((p: { provider: string }) => p.provider === "xero");
    expect(xero.credentialVariants.length).toBeGreaterThan(1);
    expect(xero.connectInput).toBe("credentials"); expect(xero.probedOnConnect).toBe(true);
  });
  it.each([null, "family", "guest", "service"])("%s cannot read administrative setup metadata", async role => {
    const response = await request(appAs(role)).get("/api/integrations/catalog");
    expect(response.status).toBe(403); expect(response.body.providers).toBeUndefined();
  });
  it("read-only and unsupported tracks expose no false write or connect controls", async () => {
    const response = await request(appAs("owner")).get("/api/integrations/catalog");
    for (const provider of response.body.providers) {
      if (["rest", "mcp", "catalog-only"].includes(provider.track)) expect(provider.canEnableWrites).toBe(false);
      if (["mcp", "catalog-only"].includes(provider.track)) { expect(provider.connectPath).toBeNull(); expect(provider.testPath).toBeNull(); }
      if (provider.track === "mcp") expect(provider.description).toEqual(expect.any(String));
      for (const field of [...provider.credentialFields, ...provider.credentialVariants.flatMap((v: { fields: unknown[] }) => v.fields)]) {
        expect(field).not.toHaveProperty("value"); expect(field).not.toHaveProperty("defaultValue");
      }
      expect(provider).not.toHaveProperty("providerConfig"); expect(provider).not.toHaveProperty("providerTokensEnc");
    }
  });
});
