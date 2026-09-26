/**
 * WARP-2979 (ADR-059 P4 §6.4) — Droplet's evidence as sentences: the numbers
 * first, the names line below them (a tiebreak, never evidence), the samples
 * only while they are kept, and never a raw confidence or p-value.
 */
import { describe, it, expect } from "vitest";
import { aboutCount, evidenceSentences, provenanceLine, sourcePhrase } from "@/components/security/link-evidence-copy";
import type { LinkEvidenceView } from "@/lib/types";

const TZ = "Europe/London";
const NOW = new Date("2026-09-24T12:00:00Z");

function camera(over: Partial<LinkEvidenceView> = {}): LinkEvidenceView {
  return {
    v: 1,
    kind: "camera_camera",
    window: { from: "2026-09-10T11:45:00.000Z", to: "2026-09-24T11:45:00.000Z" },
    anchor: { linkId: "l1", sourceKind: "camera", sourceRef: "stock_a", label: "Stock cam A" },
    candidate: { sourceKind: "camera", sourceRef: "stock_b", label: "Stock cam B" },
    forward: { n: 40, k: 34, excluded: 0, lambdaMilli: 2000, liftTenths: 170, confidenceBp: 7090 },
    reverse: { n: 45, k: 36, excluded: 1, lambdaMilli: 2700, liftTenths: 133, confidenceBp: 6620 },
    chosen: "whole",
    wholeK: null,
    names: { match: false, shared: [] },
    hypotheses: 12,
    pAdj: "1.1e-27",
    gate: "auto",
    samples: [],
    samplesTrimmedBefore: null,
    ...over,
  };
}

describe("evidenceSentences", () => {
  it("camera ↔ camera: §6.4's sentence, both directions", () => {
    expect(evidenceSentences(camera(), TZ, NOW)).toEqual([
      "When Stock cam A saw someone (40 times in 14 days), Stock cam B also did within 10 seconds 34 times, and the other way round 36 of 45 times. By chance you'd expect about 2 and 3.",
    ]);
  });

  it("lock → camera (PR-4's evidence): §6.4's sentence", () => {
    const lock = camera({
      kind: "lock_camera",
      anchor: { linkId: "l1", sourceKind: "lock", sourceRef: "matter:4/1", label: "Back door" },
      candidate: { sourceKind: "camera_zone", sourceRef: "back_cam/back_door", label: "Back camera" },
      forward: { n: 14, k: 12, excluded: 0, lambdaMilli: 168, liftTenths: 714, confidenceBp: 6010 },
      reverse: null,
      chosen: "part",
      wholeK: 12,
    });
    expect(evidenceSentences(lock, TZ, NOW)[0]).toBe(
      "In the last 14 days the Back door lock turned 14 times. 12 of those times, someone was in the 'back_door' part of Back camera's view within 10 seconds. By chance you'd expect about 0.2.",
    );
  });

  it("the names line comes BELOW the numbers, and only when they match; samples only while kept", () => {
    const e = camera({
      names: { match: true, shared: ["back", "door"] },
      samples: [
        { anchorAt: "2026-09-22T13:14:00.000Z", hitAt: "2026-09-22T13:14:03.000Z" },
        { anchorAt: "2026-09-21T08:02:00.000Z", hitAt: "2026-09-21T08:02:02.000Z" },
      ],
    });
    const s = evidenceSentences(e, TZ, NOW);
    expect(s[1]).toBe("The names match too: back door.");
    expect(s[2]).toBe("Most recently: Tue 2:14 PM, Mon 9:02 AM.");
    expect(evidenceSentences(camera({ samples: [], samplesTrimmedBefore: "2026-09-20T03:50:00.000Z" }), TZ, NOW)).toHaveLength(1);
  });

  it("never shows the confidence or the p-value raw", () => {
    const text = evidenceSentences(camera(), TZ, NOW).join(" ");
    expect(text).not.toMatch(/0\.66|0\.70|6620|7090|e-27|confidence/);
  });
});

describe("the small pieces", () => {
  it("aboutCount: whole numbers from 1, one decimal below", () => {
    expect(aboutCount(2000)).toBe("2");
    expect(aboutCount(2700)).toBe("3");
    expect(aboutCount(168)).toBe("0.2");
    expect(aboutCount(20)).toBe("0");
  });

  it("sourcePhrase: a camera, a part of its view, a lock", () => {
    expect(sourcePhrase({ sourceKind: "camera", sourceRef: "b", label: "Back camera" })).toBe("Back camera");
    expect(sourcePhrase({ sourceKind: "camera_zone", sourceRef: "b/till", label: "Back camera" })).toBe("the 'till' part of Back camera's view");
    expect(sourcePhrase({ sourceKind: "lock", sourceRef: "matter:1/1", label: "Back door" })).toBe("the Back door lock");
  });

  it("provenance in the site's clock", () => {
    expect(provenanceLine("linked", "2026-09-20T14:14:00.000Z", TZ)).toBe("Droplet linked this on Sep 20 at 3:14 PM.");
    expect(provenanceLine("suggested", "2026-09-20T14:14:00.000Z", TZ)).toBe("Droplet suggested this on Sep 20.");
  });
});
