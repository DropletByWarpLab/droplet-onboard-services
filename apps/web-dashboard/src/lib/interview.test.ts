/**
 * WARP-1121 — the client interview protocol (topic markers, fence watch,
 * proposal parsing). Pure-function tests; the hold-never-guess and
 * raw-JSON-never-paints contracts live here.
 */
import { describe, it, expect } from "vitest";
import {
  parseTopicMarker,
  stripTopicMarkers,
  containsProposalFenceStart,
  parseProposal,
  TOPIC_CHIPS,
  INTERVIEW_COPY,
} from "./interview";

describe("topic markers (§9.3)", () => {
  it("parses and strips a leading marker", () => {
    const t = "[topic 3/7] What kind of customers do you serve?";
    expect(parseTopicMarker(t)).toBe(3);
    expect(stripTopicMarkers(t)).toBe("What kind of customers do you serve?");
  });

  it("tolerates spacing and case", () => {
    expect(parseTopicMarker("[Topic 5 / 7] A typical day?")).toBe(5);
  });

  it("holds (null) when no marker parses — never guesses", () => {
    expect(parseTopicMarker("Tell me more about that.")).toBeNull();
    expect(parseTopicMarker("[topic 9/7] bogus")).toBeNull();
    expect(parseTopicMarker("[topic 0/7] bogus")).toBeNull();
  });

  it("chip sets exist for exactly topics 2, 3, 7", () => {
    expect(Object.keys(TOPIC_CHIPS).sort()).toEqual(["2", "3", "7"]);
    expect(TOPIC_CHIPS[3]).toContain("Just me");
  });
});

describe("proposal fence watch (raw JSON never paints)", () => {
  it("fires on a ```json fence mid-stream", () => {
    expect(containsProposalFenceStart("Here's what I learned:\n```json\n{")).toBe(true);
  });
  it("stays quiet on ordinary prose", () => {
    expect(containsProposalFenceStart("[topic 6/7] What are your goals?")).toBe(false);
  });
});

describe("parseProposal", () => {
  const GOOD = [
    "Here you go:",
    "```json",
    JSON.stringify({
      profile: { whatWeDo: "Dental practice", customers: " Families " },
      summary: "A dental practice in Boise.",
      facts: [
        { category: "Business", fact: "Open Tue-Sat", audience: "family" },
        { category: "Nonsense", fact: "Numbers first", audience: "weird" },
      ],
    }),
    "```",
  ].join("\n");

  it("parses the fenced payload, trimming and clamping", () => {
    const p = parseProposal(GOOD)!;
    expect(p.profile.whatWeDo).toBe("Dental practice");
    expect(p.profile.customers).toBe("Families");
    expect(p.summary).toBe("A dental practice in Boise.");
    expect(p.facts).toEqual([
      { category: "Business", fact: "Open Tue-Sat", audience: "family" },
      // Unknown category → Business; unknown audience → family (D-11).
      { category: "Business", fact: "Numbers first", audience: "family" },
    ]);
  });

  it("returns null (parse-failure card) on broken JSON", () => {
    expect(parseProposal("```json\n{not json}\n```")).toBeNull();
    expect(parseProposal("no fence, no json")).toBeNull();
  });

  it("returns null on a parsed-but-empty proposal", () => {
    expect(parseProposal('```json\n{"profile":{},"summary":"","facts":[]}\n```')).toBeNull();
  });

  it("caps facts at the backend's 20-fact bound", () => {
    const many = {
      summary: "s",
      facts: Array.from({ length: 30 }, (_, i) => ({
        category: "Business",
        fact: `fact ${i}`,
      })),
    };
    const p = parseProposal("```json\n" + JSON.stringify(many) + "\n```")!;
    expect(p.facts).toHaveLength(20);
  });

  it("wrap-up copy matches the backend conductor contract byte-for-byte", () => {
    expect(INTERVIEW_COPY.wrapUpTurn).toBe(
      "That's enough — sum up what you have so far.",
    );
  });
});
