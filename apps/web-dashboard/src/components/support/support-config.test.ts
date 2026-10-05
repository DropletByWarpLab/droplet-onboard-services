/**
 * WARP-3528 — the Support surface's copy and pure helpers.
 */
import { describe, it, expect } from "vitest";
import {
  CHANNEL_LABELS,
  EMPTY_COPY,
  QUEUE_LABELS,
  SLA_LABELS,
  hasDeliveryChannel,
  isSupportQueue,
  relativeTime,
  textToHtml,
  toPmState,
} from "./support-config";
import { SUPPORT_QUEUES } from "./types";
import { STATES } from "./support.test-fixtures";

describe("copy tables cover every value the API can send", () => {
  it("has a label and an empty state for every queue, in plain sentence case", () => {
    for (const q of SUPPORT_QUEUES) {
      expect(QUEUE_LABELS[q], q).toBeTruthy();
      const { heading, body } = EMPTY_COPY[q];
      expect(heading.endsWith("."), q).toBe(true);
      expect(`${heading} ${body}`).not.toMatch(/[!]/);
      expect(`${heading} ${body}`).not.toMatch(/requester|work item/i);
    }
  });

  it("teaches the model on the empty desk", () => {
    expect(EMPTY_COPY.all).toEqual({ heading: "No tickets yet.", body: "Customers email you; tickets appear here." });
  });

  it("names every channel and every SLA state a ticket can carry", () => {
    expect(Object.keys(CHANNEL_LABELS).sort()).toEqual(["API", "CHAT", "EMAIL", "INTERNAL", "PHONE", "WEB_FORM"]);
    expect(Object.keys(SLA_LABELS).sort()).toEqual(["AT_RISK", "BREACHED", "MET", "ON_TRACK", "PAUSED"]);
  });

  it("recognises a queue name and nothing else", () => {
    expect(isSupportQueue("mine")).toBe(true);
    expect(isSupportQueue("everything")).toBe(false);
    expect(isSupportQueue(null)).toBe(false);
  });
});

describe("textToHtml", () => {
  it("makes paragraphs of blank-line-separated text and breaks of single newlines", () => {
    expect(textToHtml("Hello\nthere\n\nSecond")).toBe("<p>Hello<br>there</p><p>Second</p>");
  });

  it("escapes everything the parser would treat as markup", () => {
    expect(textToHtml("<script>boom</script> & <b>")).toBe(
      "<p>&lt;script&gt;boom&lt;/script&gt; &amp; &lt;b&gt;</p>",
    );
  });

  it("normalises Windows line endings and drops empty paragraphs", () => {
    expect(textToHtml("a\r\n\r\n\r\n\r\nb\r\n")).toBe("<p>a</p><p>b</p>");
    expect(textToHtml("   \n\n  ")).toBe("");
  });
});

describe("relativeTime", () => {
  const now = new Date("2026-10-04T12:00:00.000Z");
  it.each([
    ["2026-10-04T11:59:40.000Z", "now"],
    ["2026-10-04T11:55:00.000Z", "5m"],
    ["2026-10-04T10:00:00.000Z", "2h"],
    ["2026-10-01T12:00:00.000Z", "3d"],
  ])("%s -> %s", (iso, out) => expect(relativeTime(iso, now)).toBe(out));

  it("reads a future stamp (clock skew) as now, and a bad one as empty", () => {
    expect(relativeTime("2026-10-04T12:05:00.000Z", now)).toBe("now");
    expect(relativeTime("not a date", now)).toBe("");
  });

  it("falls back to a short date after a week", () => {
    expect(relativeTime("2026-09-01T12:00:00.000Z", now)).toMatch(/Sep|1/);
  });
});

describe("desk helpers", () => {
  it("gives the projects pill what it reads off a desk status", () => {
    expect(toPmState(STATES[1]!, "d1")).toMatchObject({ name: "Open", group: "started", projectId: "d1", isDefault: false });
  });

  it("knows a desk has no delivery channel until one is enabled", () => {
    expect(hasDeliveryChannel([])).toBe(false);
    expect(hasDeliveryChannel([{ enabled: false }])).toBe(false);
    expect(hasDeliveryChannel([{ enabled: true }])).toBe(true);
  });
});
