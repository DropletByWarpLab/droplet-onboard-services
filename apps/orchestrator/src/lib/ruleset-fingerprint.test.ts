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
      // v2 — WARP-2978 PR-D: after_hours_presence accepts `detection_ongoing` (a person still in view at 30 s).
      version: 2,
      fingerprint: "ba5c80e441be07f803ea6b3d6bb1cbe08e89a50d3baaecee5cb6b40ed2b4c380",
    });
  });

  it("the fingerprint moves when a threshold does (the check can fail)", () => {
    const changed = { ...RULESET, camera_offline: { ...RULESET.camera_offline, minOfflineMs: 90_000 } };
    expect(canonical(changed)).not.toBe(canonical(RULESET));
  });
});
