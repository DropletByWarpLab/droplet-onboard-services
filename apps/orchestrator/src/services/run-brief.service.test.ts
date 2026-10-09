import { describe, it, expect } from "vitest";
import { applyRunBrief, isRunBriefKey, RUN_BRIEFS } from "./run-brief.service.js";
describe("validated run briefs", () => {
  it("adds the actual runtime and owner review constraints to the person's objective", () => {
    const brief = applyRunBrief("app-setup", "Keep my blue dashboard");
    expect(brief).toContain("Keep my blue dashboard");
    expect(brief).toContain("127.0.0.1 on PORT");
    expect(brief).toContain("DROPLET_EXT_BASE_PATH");
    expect(brief).toContain("workspace_propose is your final action");
    expect(brief).toContain("Promotion signs it later");
    expect(brief).toContain("no network installs");
    expect(RUN_BRIEFS["app-setup"].length).toBeLessThan(2000);
  });
  it("accepts only a registered key and leaves ordinary goals intact", () => {
    expect(isRunBriefKey("app-setup")).toBe(true);
    expect(isRunBriefKey("constructor")).toBe(false);
    expect(() => applyRunBrief("deploy-it", "g")).toThrow("Unsupported run brief");
    expect(applyRunBrief(null, "g")).toBe("g");
  });
});
