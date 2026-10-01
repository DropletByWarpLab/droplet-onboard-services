/**
 * WARP-2979 (ADR-059 P4 §6.11.3, DS-005, D21 — narrowed) — a "Summary by
 * Droplet" is shown only to a viewer who sees EVERY camera and may read
 * threats (`mayReadSummaries`, P5's verdict rule: independent of the
 * incident), and then only when the incident-level checks pass. Anyone else
 * gets `narrative: null` on every incident, in every state — so a
 * camera-limited viewer's page is the same whether or not evidence is hidden
 * from her (the R1 pg pin). `narrativeVisibleTo` is the one function route 18
 * and route 28 call (and the assistant's A2, PR-3).
 */
import { describe, expect, it } from "vitest";
import type { SecurityReasonCode } from "@prisma/client";
import {
  mayReadSummaries,
  narrativeIncidentVisible,
  narrativeView,
  narrativeVisibleTo,
  parseNarrativeAudience,
  type NarrativeRow,
} from "./security-narrative-view.js";
import type { IncidentProjection, IncidentViewer } from "./security-incident-view.js";

const OWNER: IncidentViewer = { userId: "u-owner", visibleCameras: "all", mayReadThreats: true, ownerOrAdmin: true };
const FAMILY_BOTH: IncidentViewer = { userId: "u-fam", visibleCameras: new Set(["back_cam", "till_cam"]), mayReadThreats: false, ownerOrAdmin: false };
const FAMILY_BACK: IncidentViewer = { userId: "u-fam", visibleCameras: new Set(["back_cam"]), mayReadThreats: false, ownerOrAdmin: false };
const ADMIN_NO_THREATS: IncidentViewer = { userId: "u-adm", visibleCameras: "all", mayReadThreats: false, ownerOrAdmin: true };
/** Anyone who sees every camera and may read threats — not only an owner. */
const SEES_EVERYTHING: IncidentViewer = { userId: "u-adm", visibleCameras: "all", mayReadThreats: true, ownerOrAdmin: false };

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

describe("the viewer rule first: mayReadSummaries (P5's verdict rule, independent of the incident)", () => {
  it("only a viewer who sees every camera AND may read threats", () => {
    expect(mayReadSummaries(OWNER)).toBe(true);
    expect(mayReadSummaries(SEES_EVERYTHING)).toBe(true);
    expect(mayReadSummaries(ADMIN_NO_THREATS)).toBe(false);
    expect(mayReadSummaries(FAMILY_BOTH)).toBe(false);
    expect(mayReadSummaries(FAMILY_BACK)).toBe(false);
  });

  const onHers = row({ cameras: ["back_cam"], narrativeAudience: { cameras: ["back_cam"], threats: false, locks: false } });
  const hers = reasons("back_cam");
  const p = projected(["after_hours_presence"]);

  it("🔴 a family member gets NO summary on an incident entirely on her own cameras — the incident-level checks alone would let her", () => {
    expect(narrativeIncidentVisible(onHers, hers, p, FAMILY_BACK)).toBe(true);
    expect(narrativeVisibleTo(onHers, hers, p, FAMILY_BACK)).toBe(false);
    expect(narrativeVisibleTo(onHers, hers, p, FAMILY_BOTH)).toBe(false);
  });

  it("🔴 threats: an admin who sees every camera but may not read threats gets none either", () => {
    expect(narrativeIncidentVisible(onHers, hers, p, ADMIN_NO_THREATS)).toBe(true);
    expect(narrativeVisibleTo(onHers, hers, p, ADMIN_NO_THREATS)).toBe(false);
  });

  const none = { narrativeState: "none" as const, narrative: null, narrativeModel: null, narrativePromptVersion: null, narratedAt: null, narrativeAudience: null };
  const states: Array<[string, Partial<NarrativeRow>]> = [
    ["collecting, none asked for", { ...none, grouping: "collecting" }],
    ["pending", { ...none, narrativeState: "pending" }],
    ["pending, keeping a previous text", { narrativeState: "pending" }],
    ["written", {}],
    ["failed", { ...none, narrativeState: "failed" }],
  ];

  it.each(states)("🔴 %s: null for a family member on her own cameras, for any partial grant, and without threats", (_l, over) => {
    const r = { ...onHers, ...over };
    for (const v of [FAMILY_BACK, FAMILY_BOTH, ADMIN_NO_THREATS]) expect(narrativeView(r, hers, p, v, true)).toBeNull();
  });

  it.each(states)("%s: the owner, and anyone who sees everything, get it", (_l, over) => {
    const r = { ...onHers, ...over };
    for (const v of [OWNER, SEES_EVERYTHING]) {
      const n = narrativeView(r, hers, p, v, true);
      expect(n).not.toBeNull();
      expect(n!.state).toBe(r.narrativeState);
    }
  });
});

describe("narrativeIncidentVisible — the incident-level checks, after the viewer rule", () => {
  const r = reasons("back_cam");

  it("the owner, and a viewer granted every camera it names, see it", () => {
    expect(narrativeIncidentVisible(row(), r, projected(["after_hours_presence"]), OWNER)).toBe(true);
    expect(narrativeIncidentVisible(row(), r, projected(["after_hours_presence"]), FAMILY_BOTH)).toBe(true);
  });

  it("a viewer missing ONE audience camera does not", () => {
    expect(narrativeIncidentVisible(row(), r, projected(["after_hours_presence"]), FAMILY_BACK)).toBe(false);
  });

  it("the incident's own cameras count even when the stored audience is narrower (a Regenerate in flight, or no text yet)", () => {
    const narrow = row({ narrativeAudience: { cameras: ["back_cam"], threats: false, locks: false } });
    expect(narrativeIncidentVisible(narrow, r, projected(["after_hours_presence"]), FAMILY_BACK)).toBe(false);
    const none = row({ narrativeState: "none", narrative: null, narrativeAudience: null, cameras: ["back_cam"] });
    expect(narrativeIncidentVisible(none, r, projected(["after_hours_presence"]), FAMILY_BACK)).toBe(true);
    // A reason's related camera is named too.
    const related = [{ evidenceCamera: "back_cam", relatedCamera: "yard_cam", relatedLock: false }];
    expect(narrativeIncidentVisible(none, related, projected(["after_hours_presence"]), FAMILY_BACK)).toBe(false);
  });

  it("threats need mayReadThreats — by the audience, the scope, or a threat reason", () => {
    const t = row({ narrativeAudience: { cameras: [], threats: true, locks: false }, cameras: [], scope: "site_threat", reasonCodes: ["threat_signal"] });
    expect(narrativeIncidentVisible(t, reasons(null), projected(["threat_signal"]), OWNER)).toBe(true);
    expect(narrativeIncidentVisible(t, reasons(null), projected(["threat_signal"]), ADMIN_NO_THREATS)).toBe(false);
    const byScope = row({ narrativeAudience: { cameras: [], threats: false, locks: false }, cameras: [], scope: "site_threat", reasonCodes: ["threat_signal"] });
    expect(narrativeIncidentVisible(byScope, reasons(null), projected(["threat_signal"]), ADMIN_NO_THREATS)).toBe(false);
  });

  it("a lock named (P4 PR-4) needs a viewer who sees every camera until mayReadLocks exists", () => {
    const l = row({ narrativeAudience: { cameras: ["back_cam"], threats: false, locks: true }, cameras: ["back_cam"] });
    expect(narrativeIncidentVisible(l, r, projected(["after_hours_presence"]), OWNER)).toBe(true);
    expect(narrativeIncidentVisible(l, r, projected(["after_hours_presence"]), FAMILY_BOTH)).toBe(false);
  });

  it("the viewer's projected codes must equal the stored codes (as a set)", () => {
    const two = row({ reasonCodes: ["camera_offline", "after_hours_presence"] });
    expect(narrativeIncidentVisible(two, r, projected(["after_hours_presence", "camera_offline"]), OWNER)).toBe(true);
    expect(narrativeIncidentVisible(two, r, projected(["after_hours_presence"]), OWNER)).toBe(false);
    expect(narrativeIncidentVisible(row(), r, null, OWNER)).toBe(false);
  });

  it("THE reason-visibility rule over every reason: a hidden evidence camera, a hidden related camera, a related lock", () => {
    const one = row({ cameras: ["back_cam"], narrativeAudience: { cameras: ["back_cam"], threats: false, locks: false } });
    expect(narrativeIncidentVisible(one, [{ evidenceCamera: "till_cam", relatedCamera: null, relatedLock: false }], projected(["after_hours_presence"]), FAMILY_BACK)).toBe(false);
    expect(narrativeIncidentVisible(one, [{ evidenceCamera: "back_cam", relatedCamera: "till_cam", relatedLock: false }], projected(["after_hours_presence"]), FAMILY_BACK)).toBe(false);
    expect(narrativeIncidentVisible(one, [{ evidenceCamera: "back_cam", relatedCamera: null, relatedLock: true }], projected(["after_hours_presence"]), FAMILY_BACK)).toBe(false);
    expect(narrativeIncidentVisible(one, [{ evidenceCamera: "back_cam", relatedCamera: null, relatedLock: false }], projected(["after_hours_presence"]), FAMILY_BACK)).toBe(true);
    // A camera-less reason follows the incident's scope: the camera system's own row is everyone's.
    const system = row({ scope: "site_camera_system", cameras: [], reasonCodes: ["camera_offline"], narrativeAudience: { cameras: [], threats: false, locks: false } });
    expect(narrativeIncidentVisible(system, reasons(null), projected(["camera_offline"]), FAMILY_BACK)).toBe(true);
  });

  it("a PARTIAL view never gets it, whatever else it can see", () => {
    const partial = { codes: ["after_hours_presence"], partial: true } as unknown as IncidentProjection;
    expect(narrativeIncidentVisible(row(), r, partial, OWNER)).toBe(false);
  });

  it("a stored audience that is not the shape fails closed", () => {
    expect(narrativeIncidentVisible(row({ narrativeAudience: { cameras: "back_cam" } }), r, projected(["after_hours_presence"]), OWNER)).toBe(false);
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
