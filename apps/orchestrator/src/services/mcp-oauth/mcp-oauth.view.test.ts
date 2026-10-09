import { describe, expect, it } from "vitest";
import { providerDescriptor } from "@droplet/shared-types";
import { buildCredentialView } from "../saas-credential.service.js";

describe("WARP-2405 descriptor and credential view", () => {
  it("offers sign-in beside the API-token fields, and the view says only that it exists", () => {
    const d = providerDescriptor("atlassian")!;
    const view = buildCredentialView(d, null);
    expect(view.signIn).toEqual({ kind: "oauth" });
    expect(JSON.stringify(view)).not.toContain((d as unknown as { signIn: { mcpUrl: string } }).signIn.mcpUrl);
    expect(view.fields.map((f) => f.name)).toEqual(expect.arrayContaining(["email", "apiToken", "cloudId"]));
    expect(buildCredentialView(providerDescriptor("stripe")!, null).signIn).toBeUndefined();
  });
});
