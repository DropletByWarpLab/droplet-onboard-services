import { describe, expect, it } from "vitest";
import { providerDescriptor } from "@droplet/shared-types";
import { buildCredentialView } from "../saas-credential.service.js";
import { mcpSignInView } from "./mcp-oauth.service.js";
import { fakeMcpOAuthDb } from "./__tests__/fake-db.js";

describe("WARP-2405 descriptor and credential view", () => {
  it("offers sign-in and NO credential fields (WARP-3961), and the view says only that sign-in exists", () => {
    const d = providerDescriptor("atlassian")!;
    const view = buildCredentialView(d, null);
    expect(view.signIn).toEqual({ kind: "oauth" });
    expect(JSON.stringify(view)).not.toContain((d as unknown as { signIn: { mcpUrl: string } }).signIn.mcpUrl);
    expect(view.fields).toEqual([]);
    expect(buildCredentialView(providerDescriptor("stripe")!, null).signIn).toBeUndefined();
  });
});

describe("mcpSignInView (WARP-3961)", () => {
  const REDIRECT = "https://box.example/api/mcp/oauth/callback";

  it("carries the pinned site on both sides, null when none, and no apiToken field", async () => {
    const db = fakeMcpOAuthDb();
    await db.seed({
      provider: "atlassian", scope: "MEMBER", memberId: "u1", issuer: "i", tokenEndpointHost: "h",
      state: "CONNECTED", tokensEnc: "dcv1:x", siteId: "cloud-1", siteName: "Acme", siteUrl: "https://acme.atlassian.net",
    });
    await db.seed({
      provider: "atlassian", scope: "WORKSPACE", memberId: null, issuer: "i", tokenEndpointHost: "h",
      workspaceAckAt: new Date(), workspaceAckBy: "boss",
    });
    const view = await mcpSignInView(db.prisma, "atlassian", "u1", REDIRECT, "admin");
    expect(view.member).toMatchObject({ siteName: "Acme", siteUrl: "https://acme.atlassian.net" });
    expect(view.workspace).toMatchObject({ siteName: null, siteUrl: null });
    expect(view).not.toHaveProperty("apiToken");
    expect(JSON.stringify(view)).not.toContain("cloud-1"); // the site id itself is not a client concern
  });
});
