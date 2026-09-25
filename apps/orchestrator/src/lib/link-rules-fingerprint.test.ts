/**
 * WARP-2979 (ADR-059 P4 §6.1) — a change to LINK_RULES without a
 * LINK_RULES_VERSION bump fails here, the P3 ruleset pattern.
 *
 * Every link Droplet writes stores the rules version that produced its
 * evidence (`SecurityZoneLink.rulesVersion`). A threshold changed under the
 * same version would make two links with the same version mean different
 * things. When this fails: bump LINK_RULES_VERSION, then pin the new pair
 * below, both lines in the same commit, deliberately.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { LINK_RULES, LINK_RULES_VERSION } from "./security-cooccurrence.js";

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

describe("the link rules fingerprint", () => {
  it("LINK_RULES is pinned to its version", () => {
    const fingerprint = createHash("sha256").update(canonical(LINK_RULES)).digest("hex");
    expect({ version: LINK_RULES_VERSION, fingerprint }).toEqual({
      // v1 — WARP-2979 P4 PR-1: §6.1's gates.
      version: 1,
      fingerprint: "64060c354cb1f4c5430fd1c5be7f54fc2941d6211d4030a58411621f35a572cb",
    });
  });

  it("the fingerprint moves when a number does (the check can fail)", () => {
    const base = canonical(LINK_RULES);
    const changed = [
      { ...LINK_RULES, pairMs: 60_000 },
      { ...LINK_RULES, partShare: 0 },
      { ...LINK_RULES, cameraCamera: { ...LINK_RULES.cameraCamera, auto: { ...LINK_RULES.cameraCamera.auto, minConfidence: 0.5 } } },
      { ...LINK_RULES, lockCamera: { ...LINK_RULES.lockCamera, propose: { ...LINK_RULES.lockCamera.propose, minK: 3 } } },
    ];
    for (const c of changed) expect(canonical(c)).not.toBe(base);
  });
});
