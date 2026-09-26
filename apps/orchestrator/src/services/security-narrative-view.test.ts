/**
 * WARP-2979 (ADR-059 P4 §6.11.3, DS-005, D21) — a "Summary by Droplet" is
 * shown only to a viewer who can see EVERYTHING it could name. Anyone else
 * gets `narrative: null` — no state, no hint that a summary exists. The one
 * function route 18 and route 28 call (and the assistant's A2, PR-3).
 */
import { describe, expect, it } from "vitest";
import type { SecurityReasonCode } from "@prisma/client";
import { narrativeView, narrativeVisibleTo, parseNarrativeAudience, type NarrativeRow } from "./security-narrative-view.js";
import type { IncidentProjection, IncidentViewer } from "./security-incident-view.js";

const OWNER: IncidentViewer = { userId: "u-owner", visibleCameras: "all", mayReadThreats: true, ownerOrAdmin: true };
const FAMILY_BOTH: IncidentViewer = { userId: "u-fam", visibleCameras: new Set(["back_cam", "till_cam"]), mayReadThreats: false, ownerOrAdmin: false };
const FAMILY_BACK: IncidentViewer = { userId: "u-fam", visibleCameras: new Set(["back_cam"]), mayReadThreats: false, ownerOrAdmin: false };
const ADMIN_NO_THREATS: IncidentViewer = { userId: "u-adm", visibleCameras: "all", mayReadThreats: false, ownerOrAdmin: true };

const WRITTEN_AT = new Date("2026-09-22T01:31:00Z");

function row(over: Partial<NarrativeRow> = {}): NarrativeRow {
  return {
    scope: "area",
    severity: "alert",
    grouping: "closed",
    cameras: ["back_cam", "till_cam"],
    reasonCodes: ["after_hours_presence"],
    narrativeState: "written",
    narrative: "Someone was seen in the Stock room at 2:14 AM while the site was closed.",
    narrativeModel: "gpt-oss:20b",
    narrativePromptVersion: 1,
    narratedAt: WRITTEN_AT,
    narrativeAudience: { cameras: ["back_cam", "till_cam"], threats: false, locks: false },
    ...over,
  };
}

const reasons = (...cams: Array<string | null>) => cams.map((c) => ({ evidenceCamera: c, relatedCamera: null, relatedLock: false }));

/** A projection as projectIncident returns it: only `codes` is read. */
const projected = (codes: SecurityReasonCode[]) => ({ codes }) as unknown as IncidentProjection;

describe("parseNarrativeAudience", () => {
  it("the stored shape, else null (validated in code)", () => {
    expect(parseNarrativeAudience({ cameras: ["a"], threats: false, locks: false })).toEqual({ cameras: ["a"], threats: false, locks: false });
    for (const bad of [null, [], "x", { cameras: "a", threats: false, locks: false }, { cameras: [1], threats: false, locks: false }, { cameras: [], threats: "no", locks: false }, { cameras: [], threats: false }]) {
      expect(parseNarrativeAudience(bad)).toBeNull();
    }
  });
});

describe("narrativeVisibleTo", () => {
  const r = reasons("back_cam");

  it("the owner, and a viewer granted every camera it names, see it", () => {
    expect(narrativeVisibleTo(row(), r, projected(["after_hours_presence"]), OWNER)).toBe(true);
    expect(narrativeVisibleTo(row(), r, projected(["after_hours_presence"]), FAMILY_BOTH)).toBe(true);
  });

  it("a viewer missing ONE audience camera does not", () => {
    expect(narrativeVisibleTo(row(), r, projected(["after_hours_presence"]), FAMILY_BACK)).toBe(false);
  });

  it("the incident's own cameras count even when the stored audience is narrower (a Regenerate in flight, or no text yet)", () => {
    const narrow = row({ narrativeAudience: { cameras: ["back_cam"], threats: false, locks: false } });
    expect(narrativeVisibleTo(narrow, r, projected(["after_hours_presence"]), FAMILY_BACK)).toBe(false);
    const none = row({ narrativeState: "none", narrative: null, narrativeAudience: null, cameras: ["back_cam"] });
    expect(narrativeVisibleTo(none, r, projected(["after_hours_presence"]), FAMILY_BACK)).toBe(true);
    // A reason's related camera is named too.
    const related = [{ evidenceCamera: "back_cam", relatedCamera: "yard_cam", relatedLock: false }];
    expect(narrativeVisibleTo(none, related, projected(["after_hours_presence"]), FAMILY_BACK)).toBe(false);
  });

  it("threats need mayReadThreats — by the audience, the scope, or a threat reason", () => {
    const t = row({ narrativeAudience: { cameras: [], threats: true, locks: false }, cameras: [], scope: "site_threat", reasonCodes: ["threat_signal"] });
    expect(narrativeVisibleTo(t, reasons(null), projected(["threat_signal"]), OWNER)).toBe(true);
    expect(narrativeVisibleTo(t, reasons(null), projected(["threat_signal"]), ADMIN_NO_THREATS)).toBe(false);
    const byScope = row({ narrativeAudience: { cameras: [], threats: false, locks: false }, cameras: [], scope: "site_threat", reasonCodes: ["threat_signal"] });
    expect(narrativeVisibleTo(byScope, reasons(null), projected(["threat_signal"]), ADMIN_NO_THREATS)).toBe(false);
  });

  it("a lock named (P4 PR-4) needs a viewer who sees every camera until mayReadLocks exists", () => {
    const l = row({ narrativeAudience: { cameras: ["back_cam"], threats: false, locks: true }, cameras: ["back_cam"] });
    expect(narrativeVisibleTo(l, r, projected(["after_hours_presence"]), OWNER)).toBe(true);
    expect(narrativeVisibleTo(l, r, projected(["after_hours_presence"]), FAMILY_BOTH)).toBe(false);
  });

  it("the viewer's projected codes must equal the stored codes (as a set)", () => {
    const two = row({ reasonCodes: ["camera_offline", "after_hours_presence"] });
    expect(narrativeVisibleTo(two, r, projected(["after_hours_presence", "camera_offline"]), OWNER)).toBe(true);
    expect(narrativeVisibleTo(two, r, projected(["after_hours_presence"]), OWNER)).toBe(false);
    expect(narrativeVisibleTo(row(), r, null, OWNER)).toBe(false);
  });

  it("a stored audience that is not the shape fails closed", () => {
    expect(narrativeVisibleTo(row({ narrativeAudience: { cameras: "back_cam" } }), r, projected(["after_hours_presence"]), OWNER)).toBe(false);
  });
});

describe("narrativeView — route 18's `narrative`", () => {
  const r = reasons("back_cam");
  const p = projected(["after_hours_presence"]);

  it("written: the text, when, which model, which prompt", () => {
    expect(narrativeView(row(), r, p, OWNER, true)).toEqual({
      state: "written",
      text: "Someone was seen in the Stock room at 2:14 AM while the site was closed.",
      writtenAt: WRITTEN_AT.toISOString(),
      model: "gpt-oss:20b",
      promptVersion: 1,
    });
  });

  it("pending keeps the previous text (a Regenerate); failed has none", () => {
    expect(narrativeView(row({ narrativeState: "pending" }), r, p, OWNER, true)).toMatchObject({ state: "pending", text: expect.any(String) });
    const failed = row({ narrativeState: "failed", narrative: null, narrativeModel: null, narrativePromptVersion: null, narratedAt: null, narrativeAudience: null });
    expect(narrativeView(failed, r, p, OWNER, true)).toEqual({ state: "failed", text: null, writtenAt: null, model: null, promptVersion: null });
  });

  it("none while still collecting is shown (Summarise now); none once closed, and expired with no text, are not", () => {
    const none = row({ narrativeState: "none", narrative: null, narrativeModel: null, narrativePromptVersion: null, narratedAt: null, narrativeAudience: null });
    expect(narrativeView({ ...none, grouping: "collecting" }, r, p, OWNER, true)).toMatchObject({ state: "none", text: null });
    expect(narrativeView(none, r, p, OWNER, true)).toBeNull();
    expect(narrativeView({ ...none, narrativeState: "expired" }, r, p, OWNER, true)).toBeNull();
  });

  it("🔴 null — no state, no hint — for a partial viewer, for plain activity, and with summaries off", () => {
    expect(narrativeView(row(), r, p, FAMILY_BACK, true)).toBeNull();
    expect(narrativeView(row({ severity: "info", narrativeState: "none", narrative: null, narrativeAudience: null, narrativeModel: null, narrativePromptVersion: null, narratedAt: null, reasonCodes: [] }), [], projected([]), OWNER, true)).toBeNull();
    expect(narrativeView(row(), r, p, OWNER, false)).toBeNull();
  });
});
