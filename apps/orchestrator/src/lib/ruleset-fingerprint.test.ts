/**
 * WARP-2978 (ADR-059 §3.5: "Rules are code, versioned") — a change to a rule's
 * numbers without a SECURITY_RULESET_VERSION bump fails here.
 *
 * Every incident and every reason row stores the ruleset version that judged
 * it. A threshold changed under the same version would make two incidents
 * with the same `rulesetVersion` mean different things. When this fails:
 * bump SECURITY_RULESET_VERSION, then pin the new pair below — both lines in
 * the same commit, deliberately.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { RULESET, SECURITY_RULESET_VERSION } from "./security-rules.js";

/** JSON with object keys sorted at every depth — independent of declaration order. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

describe("the ruleset fingerprint", () => {
  it("RULESET is pinned to its version", () => {
    const fingerprint = createHash("sha256").update(canonical(RULESET)).digest("hex");
    expect({ version: SECURITY_RULESET_VERSION, fingerprint }).toEqual({
      version: 1,
      fingerprint: "f16dcbbbdc8f6a9efaab17b8b1286718749ed0312f7a5aac2b744bf90c06aac6",
    });
  });

  it("the fingerprint moves when a threshold does (the check can fail)", () => {
    const changed = { ...RULESET, camera_offline: { ...RULESET.camera_offline, minOfflineMs: 90_000 } };
    expect(canonical(changed)).not.toBe(canonical(RULESET));
  });
});
