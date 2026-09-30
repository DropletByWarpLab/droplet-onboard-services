/**
 * WARP-2978 (ADR-059 §3.5: "Rules are code, versioned") — a change to a rule's
 * numbers without a SECURITY_RULESET_VERSION bump fails here.
 *
 * WARP-2980 (P5 PR-B): what is pinned is FINGERPRINTED_RULES — P3's RULESET
 * and the pattern rules (PATTERN_RULES: each code's release and thresholds, the
 * severity modifiers, the baseline numbers) together, so a pattern threshold
 * or a release flip moves it as a P3 number does.
 *
 * Every incident and every reason row stores the ruleset version that judged
 * it. A threshold changed under the same version would make two incidents
 * with the same `rulesetVersion` mean different things. When this fails:
 * bump SECURITY_RULESET_VERSION, then pin the new pair below — both lines in
 * the same commit, deliberately.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { FINGERPRINTED_RULES, SECURITY_RULESET_VERSION } from "./security-rules.js";

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
  it("RULESET and PATTERN_RULES are pinned to their version", () => {
    const fingerprint = createHash("sha256").update(canonical(FINGERPRINTED_RULES)).digest("hex");
    expect({ version: SECURITY_RULESET_VERSION, fingerprint }).toEqual({
      // v2 — WARP-2978 PR-D: after_hours_presence accepts `detection_ongoing` (a person still in view at 30 s).
      // v3 — WARP-2980 P5 PR-B: the pattern codes (all `trial`), their severity modifiers and the baseline numbers.
      // v4 — WARP-2979 P4 PR-1: camera_offline_during_activity, and alerts only through person-set links (rankPick,
      //      after_hours_presence's personLinked — code, riding the same bump).
      version: 4,
      fingerprint: "bc7bca3747b1cdadfa36ea561b030833d67f43e9d4d5c91a96f047efd034fe15",
    });
  });

  it("the fingerprint moves when a threshold does (the check can fail) — a P3 number, a pattern threshold, a baseline number, a release", () => {
    const { ruleset, patterns } = FINGERPRINTED_RULES;
    const base = canonical(FINGERPRINTED_RULES);
    const changed = [
      { ruleset: { ...ruleset, camera_offline: { ...ruleset.camera_offline, minOfflineMs: 90_000 } }, patterns },
      { ruleset, patterns: { ...patterns, codes: { ...patterns.codes, out_of_place: { ...patterns.codes.out_of_place, maxP: 0.1 } } } },
      { ruleset, patterns: { ...patterns, baseline: { ...patterns.baseline, readyMinSmoothedDays: 7 } } },
      { ruleset, patterns: { ...patterns, codes: { ...patterns.codes, long_dwell: { ...patterns.codes.long_dwell, release: "live" } } } },
    ];
    for (const c of changed) expect(canonical(c)).not.toBe(base);
  });
});
